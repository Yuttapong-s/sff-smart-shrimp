// Server-Sent Events hub. Ingest writes data and NOTIFYs; we LISTEN, re-read the affected
// ponds, and push the same JSON shape the overview returns. Updates are coalesced per farm
// so a burst of MQTT messages (pond or RAS) produces at most one SSE event per second.

import pg from 'pg';
import { config } from './config.js';
import { pool } from './db.js';
import { listPonds } from './ponds.js';
import { listUnits } from './units.js';
import { getThresholds } from './ponds.js';
import { alarmStats } from './alarms.js';

const CHANNELS = ['pond_update', 'ras_update', 'farm_update', 'record_update', 'alarm_update'];
const FLUSH_MS = 1000;

/** farmId -> Set<res> */
const clients = new Map();
/** farmId -> Set<pondId> / Set<unitId> pending */
const pending = new Map();
const pendingUnits = new Map();
const pendingFarm = new Set();
const pendingAlarms = new Set();
let flushTimer = null;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(farmId, event, data) {
  for (const res of clients.get(farmId) ?? []) send(res, event, data);
}

async function flush() {
  flushTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  const unitBatch = [...pendingUnits.entries()];
  pendingUnits.clear();
  const farms = [...pendingFarm];
  pendingFarm.clear();
  const alarmFarms = [...pendingAlarms];
  pendingAlarms.clear();

  for (const [farmId, ids] of batch) {
    if (!clients.get(farmId)?.size) continue;
    try {
      const ponds = await listPonds(farmId, [...ids]);
      broadcast(farmId, 'ponds', { serverTime: new Date().toISOString(), ponds });
    } catch (err) {
      console.error('[stream] flush failed', err.message);
    }
  }
  for (const [farmId, ids] of unitBatch) {
    if (!clients.get(farmId)?.size) continue;
    try {
      const units = await listUnits(farmId, [...ids]);
      broadcast(farmId, 'units', { serverTime: new Date().toISOString(), units });
    } catch (err) {
      console.error('[stream] unit flush failed', err.message);
    }
  }
  for (const farmId of farms) {
    if (!clients.get(farmId)?.size) continue;
    try {
      const {
        rows: [f],
      } = await pool.query('SELECT gateway_online, gateway_seen_at FROM farms WHERE id = $1', [farmId]);
      if (f) {
        broadcast(farmId, 'farm', {
          gatewayOnline: f.gateway_online,
          gatewaySeenAt: f.gateway_seen_at,
          thresholds: await getThresholds(farmId),
        });
      }
    } catch (err) {
      console.error('[stream] farm flush failed', err.message);
    }
  }
  for (const farmId of alarmFarms) {
    if (!clients.get(farmId)?.size) continue;
    try {
      broadcast(farmId, 'alarms', await alarmStats(farmId));
    } catch (err) {
      console.error('[stream] alarm flush failed', err.message);
    }
  }
}

function schedule() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function onNotify(msg) {
  // Manual records are rare: relay {farmId, type, unitId, pondId} straight away.
  if (msg.channel === 'record_update') {
    try {
      const r = JSON.parse(msg.payload);
      broadcast(r.farmId, 'records', r);
    } catch (err) {
      console.error('[stream] bad record_update payload', err.message);
    }
    return;
  }
  // payload: "<farmId>:<id>,<id>,..." (pond ids / unit ids)  or  "<farmId>" for farm_update
  const [farmPart, idsPart] = msg.payload.split(':');
  const farmId = Number(farmPart);
  if (msg.channel === 'farm_update') {
    pendingFarm.add(farmId);
  } else if (msg.channel === 'alarm_update') {
    pendingAlarms.add(farmId);
  } else {
    const target = msg.channel === 'ras_update' ? pendingUnits : pending;
    if (!target.has(farmId)) target.set(farmId, new Set());
    const set = target.get(farmId);
    for (const id of idsPart?.split(',') ?? []) if (id) set.add(Number(id));
  }
  schedule();
}

/** Dedicated LISTEN connection with automatic reconnect. */
export async function startListener() {
  const connect = async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('notification', onNotify);
    client.on('error', (err) => {
      console.error('[stream] listener error, reconnecting', err.message);
      client.end().catch(() => {});
      setTimeout(connect, 3000);
    });
    try {
      await client.connect();
      for (const ch of CHANNELS) await client.query(`LISTEN ${ch}`);
      console.log('[stream] listening for updates');
    } catch (err) {
      console.error('[stream] listener connect failed', err.message);
      client.end().catch(() => {});
      setTimeout(connect, 3000);
    }
  };
  await connect();

  // Keep proxies from closing idle SSE connections.
  setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  }, 25_000).unref();
}

export function streamHandler(req, res) {
  const farmId = Number(req.query.farm);
  if (!Number.isInteger(farmId)) return res.status(400).json({ error: 'farm required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  send(res, 'hello', { serverTime: new Date().toISOString() });

  if (!clients.has(farmId)) clients.set(farmId, new Set());
  clients.get(farmId).add(res);
  req.on('close', () => clients.get(farmId)?.delete(res));
}
