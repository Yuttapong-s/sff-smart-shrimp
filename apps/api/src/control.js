// Remote device control: POST a command -> checks -> `commands` row -> MQTT cmd to the farm gateway.
// The PLC answers on cmd/ack (ingest updates the row); a sweeper expires commands nobody answered.
// The device's real state only comes from PLC feedback (device_state), never from "command sent".

import os from 'node:os';
import { Router } from 'express';
import mqtt from 'mqtt';
import { topics, checkCommand, CONTROL_MIN_ROLE, DEFAULT_COMMAND_TTL_SEC } from '@sff/shared';
import { pool } from './db.js';
import { requireRole } from './auth.js';
import { listPonds } from './ponds.js';

const env = process.env;
const TTL_SEC = Math.min(300, Math.max(5, Number(env.CMD_TTL_SEC ?? DEFAULT_COMMAND_TTL_SEC)));
const PUBLISH_TIMEOUT_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const control = Router();

// ---------- MQTT ----------

let client = null;

export function startControl() {
  client = mqtt.connect(env.MQTT_URL ?? 'mqtt://localhost:1883', {
    clientId: `sff-api-${os.hostname()}-${process.pid}`,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 2000,
  });
  client.on('connect', () => console.log('[control] mqtt connected'));
  client.on('error', (err) => console.error('[control] mqtt error', err.message));

  // Expire commands the PLC never answered. Idempotent, so several api replicas are fine.
  setInterval(() => sweep().catch((err) => console.error('[control] sweep failed', err.message)), 2000).unref();
}

function publish(topic, body, ttlSec) {
  return new Promise((resolve, reject) => {
    if (!client?.connected) return reject(new Error('broker_unavailable'));
    const timer = setTimeout(() => reject(new Error('puback timeout')), PUBLISH_TIMEOUT_MS);
    // Not retained; the broker also drops it after the TTL if the gateway is offline.
    client.publish(topic, JSON.stringify(body), { qos: 1, retain: false, properties: { messageExpiryInterval: ttlSec } }, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

async function notifyCommand(farmId, pondId, id, status) {
  await pool.query('SELECT pg_notify($1, $2)', ['command_update', JSON.stringify({ farmId, pondId, id, status })]);
}

async function sweep() {
  const { rows } = await pool.query(
    `UPDATE commands c SET status = 'expired', reason = 'no_ack'
     FROM ponds p
     WHERE p.id = c.pond_id AND c.status IN ('pending', 'sent') AND c.expires_at < now()
     RETURNING c.id, c.pond_id, p.farm_id`,
  );
  for (const r of rows) {
    console.warn(`[control] command ${r.id} expired without PLC ack`);
    await notifyCommand(r.farm_id, r.pond_id, r.id, 'expired');
  }
}

// ---------- queries ----------

const COMMAND_SELECT = `
  SELECT c.id, c.pond_id, c.device_id, d.code AS device_code, d.name AS device_name, c.action, c.status,
         c.reason, c.requested_at, c.sent_at, c.ack_at, c.expires_at, c.ack_detail, c.context,
         c.requested_by AS requested_by_id, u.display_name AS requested_by
  FROM commands c
  JOIN devices d ON d.id = c.device_id
  JOIN users u ON u.id = c.requested_by`;

export const commandJson = (r) => ({
  id: r.id,
  pondId: r.pond_id,
  deviceId: r.device_id,
  deviceCode: r.device_code,
  deviceName: r.device_name,
  action: r.action,
  status: r.status,
  reason: r.reason,
  message: r.ack_detail?.message ?? null,
  late: r.ack_detail?.late ?? false,
  confirmedLowDo: r.context?.confirmedLowDo ?? false,
  requestedBy: r.requested_by,
  requestedById: r.requested_by_id,
  requestedAt: r.requested_at,
  sentAt: r.sent_at,
  ackAt: r.ack_at, // PLC clock
  ackReceivedAt: r.ack_detail?.receivedAt ?? null, // server clock: use for response time
  expiresAt: r.expires_at,
});

export async function pondCommands(pondId, limit = 30) {
  const { rows } = await pool.query(`${COMMAND_SELECT} WHERE c.pond_id = $1 ORDER BY c.requested_at DESC LIMIT $2`, [
    pondId,
    limit,
  ]);
  return rows.map(commandJson);
}

async function commandById(id) {
  const { rows } = await pool.query(`${COMMAND_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? commandJson(rows[0]) : null;
}

// ---------- routes ----------

control.get('/ponds/:id/commands', async (req, res) => {
  res.json(await pondCommands(Number(req.params.id), Math.min(200, Number(req.query.limit) || 50)));
});

/**
 * Body: {id: uuid (from the app, makes retries idempotent), deviceId, action: on|off|auto, confirm?: boolean}
 * 202 + command JSON on success; 409 {code} when a check fails (see checkCommand).
 */
control.post('/commands', requireRole(CONTROL_MIN_ROLE), async (req, res) => {
  const { id, deviceId, action, confirm } = req.body ?? {};
  if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) required' });
  const cmdId = id.toLowerCase();

  const existing = await commandById(cmdId);
  if (existing) {
    // Retry of the same tap (e.g. the response got lost): return what happened, never send twice.
    if (existing.requestedById !== req.user.id) return res.status(409).json({ error: 'id in use', code: 'id_in_use' });
    return res.status(200).json(existing);
  }

  const {
    rows: [dev],
  } = await pool.query(
    `SELECT d.id, d.code, d.kind, d.name, d.pond_id, p.code AS pond_code, p.farm_id, f.code AS farm_code,
            f.gateway_online, s.is_on, s.auto, s.fault, s.updated_at AS state_at,
            EXISTS (SELECT 1 FROM commands c WHERE c.device_id = d.id AND c.status IN ('pending', 'sent')) AS busy
     FROM devices d
     JOIN ponds p ON p.id = d.pond_id
     JOIN farms f ON f.id = p.farm_id
     LEFT JOIN device_state s ON s.device_id = d.id
     WHERE d.id = $1`,
    [Number(deviceId)],
  );
  if (!dev) return res.status(404).json({ error: 'device not found' });
  const [pond] = await listPonds(dev.farm_id, [dev.pond_id]);

  const check = checkCommand({
    role: req.user.role,
    action,
    device: { kind: dev.kind, isOn: dev.is_on },
    pond,
    gatewayOnline: dev.gateway_online,
    busy: dev.busy,
    confirmed: confirm === true,
  });
  if (!check.ok) return res.status(409).json({ error: check.code, code: check.code, needsConfirm: !!check.needsConfirm });
  if (!client?.connected) return res.status(503).json({ error: 'broker_unavailable', code: 'broker_unavailable' });

  const context = {
    do: pond.latest?.do ?? null,
    doStatus: pond.metricStatus?.do ?? null,
    mode: pond.mode,
    wasOn: dev.is_on,
    wasAuto: dev.auto,
    fault: dev.fault,
    confirmedLowDo: confirm === true && (pond.metricStatus?.do === 'warn' || pond.metricStatus?.do === 'crit'),
  };
  try {
    await pool.query(
      `INSERT INTO commands (id, pond_id, device_id, action, requested_by, expires_at, context)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)`,
      [cmdId, dev.pond_id, dev.id, action, req.user.id, TTL_SEC, context],
    );
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint === 'commands_inflight_uq') return res.status(409).json({ error: 'busy', code: 'busy' });
      return res.status(409).json(await commandById(cmdId)); // same id raced in
    }
    throw err;
  }
  await pool.query('INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
    req.user.id,
    'device_command',
    `device:${dev.pond_code}/${dev.code}`,
    { commandId: cmdId, action, ...context },
  ]);

  const {
    rows: [row],
  } = await pool.query('SELECT expires_at FROM commands WHERE id = $1', [cmdId]);
  try {
    await publish(
      topics.cmd(dev.farm_code, dev.pond_code),
      {
        id: cmdId,
        device: dev.code,
        action,
        ts: new Date().toISOString(),
        expires_at: row.expires_at.toISOString(),
        ttl_sec: TTL_SEC,
        by: req.user.name,
      },
      TTL_SEC,
    );
    // The PLC ack may already have arrived: only move pending -> sent.
    await pool.query(
      `UPDATE commands SET sent_at = now(), status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END WHERE id = $1`,
      [cmdId],
    );
  } catch (err) {
    console.error(`[control] publish ${cmdId} failed: ${err.message}`);
    const code = err.message === 'broker_unavailable' ? 'broker_unavailable' : 'publish_failed';
    await pool.query(`UPDATE commands SET status = 'failed', reason = $2 WHERE id = $1 AND status = 'pending'`, [cmdId, code]);
  }
  const cmd = await commandById(cmdId);
  await notifyCommand(dev.farm_id, dev.pond_id, cmdId, cmd.status);
  res.status(cmd.status === 'failed' ? 502 : 202).json(cmd);
});
