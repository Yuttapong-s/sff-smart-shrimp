// Ingest: MQTT -> TimescaleDB.
// Telemetry is batched (flush every FLUSH_MS or BATCH_MAX rows) and written with one
// INSERT ... unnest() per batch, then the *_latest table is upserted and the api is NOTIFYed.
// Two sinks share that path: pond DO probes (sensor_readings) and unit RAS probes (ras_readings).

import mqtt from 'mqtt';
import pg from 'pg';
import { INGEST_SUBSCRIPTIONS, parseTopic } from '@sff/shared';
import { parseTelemetry, parseRasTelemetry, parseState, parseGateway, parseCmdAck } from './parse.js';

const env = process.env;
const MQTT_URL = env.MQTT_URL ?? 'mqtt://localhost:1883';
const FLUSH_MS = Number(env.FLUSH_MS ?? 1000);
const BATCH_MAX = Number(env.BATCH_MAX ?? 5000);
const BUFFER_MAX = Number(env.BUFFER_MAX ?? 500_000); // rows per sink held in memory while DB is down
// Optional: run several ingest replicas with a shared subscription. Off by default because
// EMQX does not queue shared-subscription messages while every group member is offline,
// whereas a single persistent session keeps everything during an ingest restart.
const SHARE_GROUP = env.SHARE_GROUP || null;
const SESSION_EXPIRY_SEC = Number(env.MQTT_SESSION_EXPIRY_SEC ?? 86400);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL ?? 'postgres://sff:sff@localhost:5432/sff', max: 4 });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

// ---------- pond / device lookup cache ----------

let pondByKey = new Map(); // "F1/U01-P01" -> {id, farmId}
let deviceByKey = new Map(); // "<pond id>/AE1" -> deviceId
let unitByKey = new Map(); // "F1/U01" -> {id, farmId}
let farmByCode = new Map(); // "F1" -> farmId
let lastReload = 0;

async function reloadCache() {
  const [farms, ponds, units, devices] = await Promise.all([
    pool.query('SELECT id, code FROM farms'),
    pool.query('SELECT p.id, p.code, f.id AS farm_id, f.code AS farm FROM ponds p JOIN farms f ON f.id = p.farm_id'),
    pool.query('SELECT u.id, u.code, f.id AS farm_id, f.code AS farm FROM units u JOIN farms f ON f.id = u.farm_id'),
    pool.query('SELECT id, pond_id, code FROM devices'),
  ]);
  farmByCode = new Map(farms.rows.map((r) => [r.code, r.id]));
  pondByKey = new Map(ponds.rows.map((r) => [`${r.farm}/${r.code}`, { id: r.id, farmId: r.farm_id }]));
  unitByKey = new Map(units.rows.map((r) => [`${r.farm}/${r.code}`, { id: r.id, farmId: r.farm_id }]));
  deviceByKey = new Map(devices.rows.map((r) => [`${r.pond_id}/${r.code}`, r.id]));
  lastReload = Date.now();
}

/** Look up a pond/unit; on a miss reload at most every 30 s (new ponds added via the app). */
async function lookup(getMap, farm, code) {
  const key = `${farm}/${code}`;
  let hit = getMap().get(key);
  if (!hit && Date.now() - lastReload > 30_000) {
    await reloadCache();
    hit = getMap().get(key);
  }
  return hit;
}

// ---------- telemetry batching ----------

const stats = { received: 0, written: 0, dropped: 0, unknown: 0 };

/**
 * A sink = one hypertable + its latest-value table + NOTIFY channel.
 * `fields` map sample keys to columns (order matters for the unnest types).
 */
function makeSink({ name, table, latest, key, fields, channel }) {
  const cols = fields.map((f) => f.column);
  const types = ['timestamptz[]', 'int[]', ...fields.map(() => 'real[]'), 'smallint[]'];
  const unnest = `unnest(${types.map((t, i) => `$${i + 1}::${t}`).join(', ')})`;
  const all = ['time', key, ...cols, 'quality'];
  return {
    name,
    channel,
    buffer: [],
    flushing: false,
    owner: new Map(), // entity id -> farmId, for NOTIFY payloads
    insertSql: `INSERT INTO ${table} (${all.join(', ')})
      SELECT * FROM ${unnest}
      ON CONFLICT (${key}, time) DO NOTHING`,
    // Only move the latest row forward in time (backfilled samples never overwrite newer data).
    latestSql: `INSERT INTO ${latest} (${key}, time, ${cols.join(', ')}, quality, updated_at)
      SELECT DISTINCT ON (${key}) ${key}, time, ${cols.join(', ')}, quality, now()
      FROM ${unnest} AS t(${all.join(', ')})
      ORDER BY ${key}, time DESC
      ON CONFLICT (${key}) DO UPDATE SET
        time = EXCLUDED.time, ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
        quality = EXCLUDED.quality, updated_at = now()
      WHERE ${latest}.time < EXCLUDED.time
      RETURNING ${key} AS id`,
    params(batch) {
      return [
        batch.map((r) => r.time),
        batch.map((r) => r.id),
        ...fields.map((f) => batch.map((r) => r[f.key])),
        batch.map((r) => r.quality),
      ];
    },
  };
}

const pondSink = makeSink({
  name: 'pond',
  table: 'sensor_readings',
  latest: 'pond_latest',
  key: 'pond_id',
  channel: 'pond_update',
  fields: [
    { key: 'do', column: 'do_mgl' },
    { key: 'doPct', column: 'do_pct' },
    { key: 'temp', column: 'temp_c' },
  ],
});
const rasSink = makeSink({
  name: 'ras',
  table: 'ras_readings',
  latest: 'ras_latest',
  key: 'unit_id',
  channel: 'ras_update',
  fields: [
    { key: 'ph', column: 'ph' },
    { key: 'orp', column: 'orp_mv' },
    { key: 'temp', column: 'temp_c' },
  ],
});
const SINKS = [pondSink, rasSink];

async function flush(sink) {
  if (sink.flushing || sink.buffer.length === 0) return;
  sink.flushing = true;
  const batch = sink.buffer.slice(0, BATCH_MAX);
  try {
    const params = sink.params(batch);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(sink.insertSql, params);
      const { rows: changed } = await client.query(sink.latestSql, params);
      await notify(client, sink, changed.map((r) => r.id));
      await client.query('COMMIT');
      stats.written += ins.rowCount;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    sink.buffer = sink.buffer.slice(batch.length);
  } catch (err) {
    console.error(`[ingest] ${sink.name} flush failed (${sink.buffer.length} rows buffered): ${err.message}`);
  } finally {
    sink.flushing = false;
  }
  if (sink.buffer.length >= BATCH_MAX) setImmediate(() => flush(sink));
}

const flushAll = () => Promise.all(SINKS.map(flush));

/** NOTIFY <channel> with "<farmId>:<id>,<id>" chunks (payload limit is 8000 bytes). */
async function notify(client, sink, ids) {
  const byFarm = new Map();
  for (const id of ids) {
    const f = sink.owner.get(id);
    if (!byFarm.has(f)) byFarm.set(f, []);
    byFarm.get(f).push(id);
  }
  for (const [farmId, list] of byFarm) {
    for (let i = 0; i < list.length; i += 800) {
      await client.query('SELECT pg_notify($1, $2)', [sink.channel, `${farmId}:${list.slice(i, i + 800).join(',')}`]);
    }
  }
}

function enqueue(sink, entity, { samples, dropped }) {
  sink.owner.set(entity.id, entity.farmId);
  stats.received += samples.length;
  stats.dropped += dropped;
  if (sink.buffer.length + samples.length > BUFFER_MAX) {
    stats.dropped += samples.length;
    return;
  }
  for (const smp of samples) sink.buffer.push({ ...smp, id: entity.id });
  if (sink.buffer.length >= BATCH_MAX) flush(sink);
}

// ---------- state / gateway (low volume: write directly) ----------

async function handleState(pond, msg) {
  const st = parseState(msg);
  if (!st) return void stats.dropped++;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (st.mode) {
      await client.query(
        `INSERT INTO pond_control (pond_id, mode, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (pond_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at`,
        [pond.id, st.mode, st.time],
      );
    }
    for (const d of st.devices) {
      const deviceId = deviceByKey.get(`${pond.id}/${d.code}`);
      if (!deviceId) continue;
      await client.query(
        `INSERT INTO device_state (device_id, is_on, auto, current_a, fault, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (device_id) DO UPDATE SET is_on = EXCLUDED.is_on, auto = EXCLUDED.auto,
           current_a = EXCLUDED.current_a, fault = EXCLUDED.fault, updated_at = EXCLUDED.updated_at
         WHERE device_state.updated_at <= EXCLUDED.updated_at`,
        [deviceId, d.on, d.auto, d.currentA, d.fault, st.time],
      );
    }
    await client.query('SELECT pg_notify($1, $2)', ['pond_update', `${pond.farmId}:${pond.id}`]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ingest] state write failed', err.message);
  } finally {
    client.release();
  }
}

/**
 * PLC result for a command. A late ack (after the api marked it expired) still wins: the PLC is
 * the truth about what it did. An ack can also beat the api's own "sent" update (PUBACK race).
 */
async function handleCmdAck(pond, msg) {
  const ack = parseCmdAck(msg);
  if (!ack) return void stats.dropped++;
  try {
    const { rows } = await pool.query(
      `UPDATE commands SET
         status = CASE WHEN $3 THEN 'acked' ELSE 'rejected' END,
         reason = $4, ack_at = $5,
         ack_detail = jsonb_build_object('message', $6::text, 'late', status = 'expired', 'receivedAt', now())
       WHERE id = $1 AND pond_id = $2 AND status IN ('pending', 'sent', 'expired')
       RETURNING id, status`,
      [ack.id, pond.id, ack.ok, ack.reason, ack.time, ack.message],
    );
    if (!rows.length) return void stats.unknown++;
    await pool.query('SELECT pg_notify($1, $2)', [
      'command_update',
      JSON.stringify({ farmId: pond.farmId, pondId: pond.id, id: ack.id, status: rows[0].status }),
    ]);
    console.log(`[ingest] cmd ${ack.id} ${rows[0].status}${ack.reason ? ` (${ack.reason})` : ''}`);
  } catch (err) {
    console.error('[ingest] cmd ack write failed', err.message);
  }
}

async function handleGateway(farm, msg) {
  const gw = parseGateway(msg);
  const farmId = farmByCode.get(farm);
  if (!gw || !farmId) return;
  try {
    await pool.query('UPDATE farms SET gateway_online = $2, gateway_seen_at = $3 WHERE id = $1', [
      farmId,
      gw.online,
      gw.time,
    ]);
    await pool.query('SELECT pg_notify($1, $2)', ['farm_update', String(farmId)]);
    console.log(`[ingest] gateway ${farm} ${gw.online ? 'online' : 'OFFLINE'}`);
  } catch (err) {
    console.error('[ingest] gateway write failed', err.message);
  }
}

// ---------- main ----------

async function handleMessage(topic, msg) {
  const t = parseTopic(topic.replace(/^\$share\/[^/]+\//, ''));
  if (!t) return;
  if (t.kind === 'gateway') return handleGateway(t.farm, msg);

  if (t.kind === 'rasTelemetry') {
    const unit = await lookup(() => unitByKey, t.farm, t.unit);
    if (!unit) return void stats.unknown++;
    return enqueue(rasSink, unit, parseRasTelemetry(msg));
  }
  if (t.kind !== 'telemetry' && t.kind !== 'state' && t.kind !== 'cmdAck') return; // edge alarm: later phase

  const pond = await lookup(() => pondByKey, t.farm, t.pond);
  if (!pond) return void stats.unknown++;
  if (t.kind === 'state') return handleState(pond, msg);
  if (t.kind === 'cmdAck') return handleCmdAck(pond, msg);
  enqueue(pondSink, pond, parseTelemetry(msg));
}

async function main() {
  for (let i = 1; ; i++) {
    try {
      await reloadCache();
      break;
    } catch (err) {
      if (i >= 30) throw err;
      console.log(`[ingest] waiting for database/schema (${i}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log(`[ingest] cache loaded: ${unitByKey.size} units, ${pondByKey.size} ponds`);

  const client = mqtt.connect(MQTT_URL, {
    // Stable client id is required: the broker keeps our queued messages under this id.
    clientId: env.MQTT_CLIENT_ID ?? 'sff-ingest-1',
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    protocolVersion: 5,
    clean: false, // persistent session: broker queues QoS1 messages while we are down
    properties: { sessionExpiryInterval: SESSION_EXPIRY_SEC },
    reconnectPeriod: 2000,
  });

  client.on('connect', (connack) => {
    if (connack.sessionPresent) {
      console.log(`[mqtt] connected ${MQTT_URL}, resumed session (receiving queued messages)`);
      return;
    }
    const subs = SHARE_GROUP ? INGEST_SUBSCRIPTIONS.map((s) => `$share/${SHARE_GROUP}/${s}`) : INGEST_SUBSCRIPTIONS;
    client.subscribe(subs, { qos: 1 }, (err) => {
      if (err) console.error('[mqtt] subscribe failed', err.message);
      else console.log(`[mqtt] connected ${MQTT_URL}, new session, subscribed`);
    });
  });
  client.on('error', (err) => console.error('[mqtt] error', err.message));
  client.on('message', (topic, msg) => {
    handleMessage(topic, msg).catch((err) => console.error('[ingest] message failed', err.message));
  });

  setInterval(flushAll, FLUSH_MS);
  setInterval(() => reloadCache().catch(() => {}), 5 * 60_000);
  setInterval(() => {
    const buffered = SINKS.map((k) => `${k.name}:${k.buffer.length}`).join(' ');
    console.log(`[ingest] received=${stats.received} written=${stats.written} dropped=${stats.dropped} unknown=${stats.unknown} buffered=${buffered}`);
  }, 60_000);

  const shutdown = async () => {
    console.log('[ingest] shutting down, flushing buffer');
    client.end();
    for (let i = 0; i < 5 && SINKS.some((k) => k.buffer.length); i++) {
      while (SINKS.some((k) => k.flushing)) await new Promise((r) => setTimeout(r, 100));
      await flushAll();
    }
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[ingest] fatal', err);
  process.exit(1);
});
