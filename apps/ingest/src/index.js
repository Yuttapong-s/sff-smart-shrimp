// Ingest: MQTT -> TimescaleDB.
// Telemetry is batched (flush every FLUSH_MS or BATCH_MAX rows) and written with one
// INSERT ... unnest() per batch, then pond_latest is upserted and the api is NOTIFYed.

import mqtt from 'mqtt';
import pg from 'pg';
import { INGEST_SUBSCRIPTIONS, parseTopic } from '@sff/shared';
import { parseTelemetry, parseState, parseGateway } from './parse.js';

const env = process.env;
const MQTT_URL = env.MQTT_URL ?? 'mqtt://localhost:1883';
const FLUSH_MS = Number(env.FLUSH_MS ?? 1000);
const BATCH_MAX = Number(env.BATCH_MAX ?? 5000);
const BUFFER_MAX = Number(env.BUFFER_MAX ?? 500_000); // rows held in memory while DB is down
// Optional: run several ingest replicas with a shared subscription. Off by default because
// EMQX does not queue shared-subscription messages while every group member is offline,
// whereas a single persistent session keeps everything during an ingest restart.
const SHARE_GROUP = env.SHARE_GROUP || null;
const SESSION_EXPIRY_SEC = Number(env.MQTT_SESSION_EXPIRY_SEC ?? 86400);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL ?? 'postgres://sff:sff@localhost:5432/sff', max: 4 });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

// ---------- pond / device lookup cache ----------

let pondByKey = new Map(); // "F1/A01" -> {pondId, farmId}
let deviceByKey = new Map(); // "<pondId>/AE1" -> deviceId
let farmByCode = new Map(); // "F1" -> farmId
let lastReload = 0;

async function reloadCache() {
  const [ponds, devices] = await Promise.all([
    pool.query('SELECT p.id, p.code, f.id AS farm_id, f.code AS farm FROM ponds p JOIN farms f ON f.id = p.farm_id'),
    pool.query('SELECT id, pond_id, code FROM devices'),
  ]);
  pondByKey = new Map(ponds.rows.map((r) => [`${r.farm}/${r.code}`, { pondId: r.id, farmId: r.farm_id }]));
  farmByCode = new Map(ponds.rows.map((r) => [r.farm, r.farm_id]));
  deviceByKey = new Map(devices.rows.map((r) => [`${r.pond_id}/${r.code}`, r.id]));
  lastReload = Date.now();
}

/** Look up a pond; on a miss reload at most every 30 s (new ponds added via the app). */
async function lookupPond(farm, pond) {
  const key = `${farm}/${pond}`;
  let hit = pondByKey.get(key);
  if (!hit && Date.now() - lastReload > 30_000) {
    await reloadCache();
    hit = pondByKey.get(key);
  }
  return hit;
}

// ---------- telemetry batching ----------

let buffer = [];
let flushing = false;
const stats = { received: 0, written: 0, dropped: 0, unknownPond: 0 };

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.slice(0, BATCH_MAX);
  try {
    const cols = { time: [], pond: [], do: [], ph: [], orp: [], temp: [], q: [] };
    for (const r of batch) {
      cols.time.push(r.time);
      cols.pond.push(r.pondId);
      cols.do.push(r.do);
      cols.ph.push(r.ph);
      cols.orp.push(r.orp);
      cols.temp.push(r.temp);
      cols.q.push(r.quality);
    }
    const params = [cols.time, cols.pond, cols.do, cols.ph, cols.orp, cols.temp, cols.q];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO sensor_readings (time, pond_id, do_mgl, ph, orp_mv, temp_c, quality)
         SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::real[], $4::real[], $5::real[], $6::real[], $7::smallint[])
         ON CONFLICT (pond_id, time) DO NOTHING`,
        params,
      );
      // Only move pond_latest forward in time (backfilled samples never overwrite newer data).
      const { rows: changed } = await client.query(
        `INSERT INTO pond_latest (pond_id, time, do_mgl, ph, orp_mv, temp_c, quality, updated_at)
         SELECT DISTINCT ON (pond_id) pond_id, time, do_mgl, ph, orp_mv, temp_c, quality, now()
         FROM unnest($1::timestamptz[], $2::int[], $3::real[], $4::real[], $5::real[], $6::real[], $7::smallint[])
              AS t(time, pond_id, do_mgl, ph, orp_mv, temp_c, quality)
         ORDER BY pond_id, time DESC
         ON CONFLICT (pond_id) DO UPDATE SET
           time = EXCLUDED.time, do_mgl = EXCLUDED.do_mgl, ph = EXCLUDED.ph, orp_mv = EXCLUDED.orp_mv,
           temp_c = EXCLUDED.temp_c, quality = EXCLUDED.quality, updated_at = now()
         WHERE pond_latest.time < EXCLUDED.time
         RETURNING pond_id`,
        params,
      );
      await notifyPonds(client, changed.map((r) => r.pond_id));
      await client.query('COMMIT');
      stats.written += ins.rowCount;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    buffer = buffer.slice(batch.length);
  } catch (err) {
    console.error(`[ingest] flush failed (${buffer.length} rows buffered): ${err.message}`);
  } finally {
    flushing = false;
  }
  if (buffer.length >= BATCH_MAX) setImmediate(flush);
}

const pondFarm = new Map(); // pondId -> farmId, filled from cache lookups

/** NOTIFY pond_update with "<farmId>:<id>,<id>" chunks (payload limit is 8000 bytes). */
async function notifyPonds(client, pondIds) {
  const byFarm = new Map();
  for (const id of pondIds) {
    const f = pondFarm.get(id);
    if (!byFarm.has(f)) byFarm.set(f, []);
    byFarm.get(f).push(id);
  }
  for (const [farmId, ids] of byFarm) {
    for (let i = 0; i < ids.length; i += 800) {
      await client.query('SELECT pg_notify($1, $2)', ['pond_update', `${farmId}:${ids.slice(i, i + 800).join(',')}`]);
    }
  }
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
        [pond.pondId, st.mode, st.time],
      );
    }
    for (const d of st.devices) {
      const deviceId = deviceByKey.get(`${pond.pondId}/${d.code}`);
      if (!deviceId) continue;
      await client.query(
        `INSERT INTO device_state (device_id, is_on, current_a, fault, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE SET is_on = EXCLUDED.is_on, current_a = EXCLUDED.current_a,
           fault = EXCLUDED.fault, updated_at = EXCLUDED.updated_at
         WHERE device_state.updated_at <= EXCLUDED.updated_at`,
        [deviceId, d.on, d.currentA, d.fault, st.time],
      );
    }
    await client.query('SELECT pg_notify($1, $2)', ['pond_update', `${pond.farmId}:${pond.pondId}`]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ingest] state write failed', err.message);
  } finally {
    client.release();
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
  if (t.kind !== 'telemetry' && t.kind !== 'state') return; // cmdAck / alarm: later phases

  const pond = await lookupPond(t.farm, t.pond);
  if (!pond) return void stats.unknownPond++;
  pondFarm.set(pond.pondId, pond.farmId);

  if (t.kind === 'state') return handleState(pond, msg);

  const { samples, dropped } = parseTelemetry(msg);
  stats.received += samples.length;
  stats.dropped += dropped;
  if (buffer.length + samples.length > BUFFER_MAX) {
    stats.dropped += samples.length;
    return;
  }
  for (const s of samples) buffer.push({ ...s, pondId: pond.pondId });
  if (buffer.length >= BATCH_MAX) flush();
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
  console.log(`[ingest] cache loaded: ${pondByKey.size} ponds`);

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

  setInterval(flush, FLUSH_MS);
  setInterval(() => reloadCache().catch(() => {}), 5 * 60_000);
  setInterval(() => {
    console.log(`[ingest] received=${stats.received} written=${stats.written} dropped=${stats.dropped} unknownPond=${stats.unknownPond} buffered=${buffer.length}`);
  }, 60_000);

  const shutdown = async () => {
    console.log('[ingest] shutting down, flushing buffer');
    client.end();
    for (let i = 0; i < 5 && buffer.length; i++) {
      while (flushing) await new Promise((r) => setTimeout(r, 100));
      await flush();
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
