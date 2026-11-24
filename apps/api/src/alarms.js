// Alarm list / acknowledgement, Web Push subscriptions, and alarm-rule editing.

import { Router } from 'express';
import { ALARM_METRICS, validateRule } from '@sff/shared';
import { pool } from './db.js';
import { requireRole } from './auth.js';
import { clearThresholdCache } from './ponds.js';
import { getVapid, pushTo } from './alerts/push.js';

export const alarms = Router();

const HEARTBEAT_STALE_SEC = 90;

/** Counts for badges + whether the alerter is alive. */
export async function alarmStats(farmId) {
  const [{ rows: [c] }, { rows: [hb] }] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS open,
              count(*) FILTER (WHERE acked_at IS NULL)::int AS unacked,
              count(*) FILTER (WHERE severity = 'crit')::int AS crit,
              count(*) FILTER (WHERE severity = 'crit' AND acked_at IS NULL)::int AS unacked_crit
       FROM alarms WHERE farm_id = $1 AND cleared_at IS NULL`,
      [farmId],
    ),
    pool.query(`SELECT updated_at FROM app_settings WHERE key = 'alerter_heartbeat'`),
  ]);
  const at = hb?.updated_at ?? null;
  return {
    open: c.open,
    unacked: c.unacked,
    crit: c.crit,
    unackedCrit: c.unacked_crit,
    alerterAt: at,
    alerterOk: !!at && (Date.now() - at.getTime()) / 1000 < HEARTBEAT_STALE_SEC,
  };
}

const toJson = (a) => ({
  id: Number(a.id),
  kind: a.kind,
  key: a.key,
  severity: a.severity,
  metric: a.metric,
  message: a.message,
  value: a.value,
  pondId: a.pond_id,
  pondCode: a.pond_code,
  unitId: a.unit_id,
  unitCode: a.unit_code,
  startedAt: a.started_at,
  updatedAt: a.updated_at,
  clearedAt: a.cleared_at,
  ackedAt: a.acked_at,
  ackedBy: a.acked_by_name,
  escalationLevel: a.escalation_level,
  lastNotifiedAt: a.last_notified_at,
  pushedDevices: a.pushed_devices,
});

alarms.get('/alarms', async (req, res) => {
  const farmId = Number(req.query.farm) || 1;
  const history = req.query.state === 'history';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
    `SELECT a.*, p.code AS pond_code, u.code AS unit_code, usr.display_name AS acked_by_name,
            (SELECT COALESCE(sum(n.devices), 0)::int FROM alarm_notifications n WHERE n.alarm_id = a.id) AS pushed_devices
     FROM alarms a
     LEFT JOIN ponds p ON p.id = a.pond_id
     LEFT JOIN units u ON u.id = a.unit_id
     LEFT JOIN users usr ON usr.id = a.acked_by
     WHERE a.farm_id = $1 AND ${history ? `a.started_at > now() - interval '30 days'` : 'a.cleared_at IS NULL'}
     ORDER BY ${history ? 'a.started_at DESC' : `(a.acked_at IS NULL) DESC, (a.severity = 'crit') DESC, a.started_at DESC`}
     LIMIT $2`,
    [farmId, limit],
  );
  res.json({ serverTime: new Date().toISOString(), stats: await alarmStats(farmId), alarms: rows.map(toJson) });
});

// Any role may acknowledge: whoever is at the pond takes responsibility. Lab alarms are
// one-off findings, so acknowledging also closes them.
alarms.post('/alarms/:id/ack', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(
    `UPDATE alarms SET acked_at = now(), acked_by = $2, updated_at = now(),
            cleared_at = CASE WHEN kind = 'lab' THEN now() ELSE cleared_at END
     WHERE id = $1 AND acked_at IS NULL RETURNING farm_id, message`,
    [id, req.user.id],
  );
  if (!rows[0]) {
    const { rowCount } = await pool.query('SELECT 1 FROM alarms WHERE id = $1', [id]);
    return rowCount ? res.json({ ok: true, already: true }) : res.status(404).json({ error: 'not found' });
  }
  await pool.query('INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
    req.user.id,
    'alarm_ack',
    `alarm:${id}`,
    { message: rows[0].message, via: req.body?.via ?? 'app' },
  ]);
  await pool.query('SELECT pg_notify($1, $2)', ['alarm_update', String(rows[0].farm_id)]);
  res.json({ ok: true });
});

// ---------- Web Push ----------

alarms.get('/push/key', async (_req, res) => {
  res.json({ publicKey: (await getVapid()).publicKey });
});

alarms.get('/push/status', async (req, res) => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
  res.json({ devices: rows[0].n });
});

alarms.post('/push/subscribe', async (req, res) => {
  const s = req.body?.subscription;
  const ok =
    s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
  if (!ok) return res.status(400).json({ error: 'invalid subscription' });
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, keys, user_agent) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys,
       user_agent = EXCLUDED.user_agent, fail_count = 0`,
    [req.user.id, s.endpoint, { p256dh: s.keys.p256dh, auth: s.keys.auth }, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  res.json({ ok: true });
});

alarms.post('/push/unsubscribe', async (req, res) => {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [String(req.body?.endpoint ?? ''), req.user.id]);
  res.json({ ok: true });
});

alarms.post('/push/test', async (req, res) => {
  const r = await pushTo({
    userIds: [req.user.id],
    payload: {
      title: '✓ ทดสอบการแจ้งเตือน',
      body: 'เครื่องนี้รับการแจ้งเตือนจาก SFF Smart Shrimp ได้แล้ว',
      tag: 'test',
      url: '/#/settings',
      severity: 'info',
      time: new Date().toISOString(),
    },
    reason: 'test',
  });
  res.json(r);
});

// ---------- alarm rules ----------

const ruleJson = (r) => ({
  critLow: r.crit_low,
  warnLow: r.warn_low,
  warnHigh: r.warn_high,
  critHigh: r.crit_high,
  holdSeconds: r.hold_seconds,
});

alarms.get('/alarm-rules', async (req, res) => {
  const farmId = Number(req.query.farm) || 1;
  const { rows } = await pool.query('SELECT * FROM alarm_rules WHERE farm_id = $1', [farmId]);
  res.json(Object.fromEntries(rows.map((r) => [r.metric, ruleJson(r)])));
});

alarms.put('/alarm-rules', requireRole('manager'), async (req, res) => {
  const farmId = Number(req.body?.farmId) || 1;
  const rules = req.body?.rules ?? {};
  const errors = Object.entries(rules).flatMap(([m, r]) => validateRule(m, r));
  if (!Object.keys(rules).length) errors.push('ไม่มีเกณฑ์ที่จะบันทึก');
  if (errors.length) return res.status(400).json({ error: errors.join(' · '), errors });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM alarm_rules WHERE farm_id = $1', [farmId]);
    for (const m of ALARM_METRICS) {
      const r = rules[m];
      if (!r) continue;
      await client.query(
        `INSERT INTO alarm_rules (farm_id, metric, crit_low, warn_low, warn_high, crit_high, hold_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (farm_id, metric) DO UPDATE SET crit_low = $3, warn_low = $4, warn_high = $5, crit_high = $6, hold_seconds = $7`,
        [farmId, m, r.critLow ?? null, r.warnLow ?? null, r.warnHigh ?? null, r.critHigh ?? null, r.holdSeconds],
      );
    }
    await client.query('INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
      req.user.id,
      'alarm_rules_update',
      `farm:${farmId}`,
      { before: Object.fromEntries(before.map((r) => [r.metric, ruleJson(r)])), after: rules },
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  clearThresholdCache(farmId);
  // Open apps re-evaluate pond / RAS colours with the new limits.
  await pool.query('SELECT pg_notify($1, $2)', ['farm_update', String(farmId)]);
  res.json({ ok: true });
});
