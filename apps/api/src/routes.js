import { Router } from 'express';
import { pool } from './db.js';
import { login, logout, requireAuth } from './auth.js';
import { listPonds, getPond, getReadings, getThresholds } from './ponds.js';
import { streamHandler } from './stream.js';

export const api = Router();

api.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, time: new Date().toISOString() });
});

api.post('/auth/login', login);
api.post('/auth/logout', logout);

api.use(requireAuth);

api.get('/me', (req, res) => res.json(req.user));

api.get('/farms', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, code, name, gateway_online, gateway_seen_at FROM farms ORDER BY id',
  );
  res.json(rows);
});

// Everything the overview grid needs in one request.
api.get('/farms/:id/overview', async (req, res) => {
  const farmId = Number(req.params.id);
  const {
    rows: [farm],
  } = await pool.query('SELECT id, code, name, gateway_online, gateway_seen_at FROM farms WHERE id = $1', [farmId]);
  if (!farm) return res.status(404).json({ error: 'farm not found' });

  const [{ rows: zones }, ponds, thresholds, { rows: alarmCount }] = await Promise.all([
    pool.query('SELECT code, name FROM zones WHERE farm_id = $1 ORDER BY sort', [farmId]),
    listPonds(farmId),
    getThresholds(farmId),
    pool.query('SELECT count(*)::int AS n FROM alarms WHERE farm_id = $1 AND cleared_at IS NULL', [farmId]),
  ]);
  res.json({
    serverTime: new Date().toISOString(),
    farm: {
      id: farm.id,
      code: farm.code,
      name: farm.name,
      gatewayOnline: farm.gateway_online,
      gatewaySeenAt: farm.gateway_seen_at,
    },
    zones,
    thresholds,
    openAlarms: alarmCount[0].n,
    ponds,
  });
});

api.get('/ponds/:id', async (req, res) => {
  const pondId = Number(req.params.id);
  const found = await getPond(pondId);
  if (!found) return res.status(404).json({ error: 'pond not found' });
  const { row, json } = found;

  const cycleId = row.cycle_id;
  const [devices, alarms, manual, lab, calibrations, growth, thresholds] = await Promise.all([
    pool.query(
      `SELECT d.id, d.code, d.kind, d.name, s.is_on, s.current_a, s.fault, s.updated_at
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id
       WHERE d.pond_id = $1 ORDER BY d.kind, d.code`,
      [pondId],
    ),
    pool.query(
      `SELECT id, metric, severity, message, source, started_at, cleared_at, acked_at
       FROM alarms WHERE pond_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [pondId],
    ),
    pool.query(
      `SELECT time, param, value, unit, method, note FROM manual_readings
       WHERE pond_id = $1 ORDER BY time DESC LIMIT 30`,
      [pondId],
    ),
    pool.query(
      `SELECT sampled_at, lab_name, param, value, value_text, unit FROM lab_results
       WHERE pond_id = $1 ORDER BY sampled_at DESC LIMIT 30`,
      [pondId],
    ),
    pool.query(
      `SELECT DISTINCT ON (metric) metric, calibrated_at, next_due, note FROM calibrations
       WHERE pond_id = $1 ORDER BY metric, calibrated_at DESC`,
      [pondId],
    ),
    cycleId
      ? pool.query(
          `SELECT sampled_at, abw_g, survival_pct FROM growth_samples
           WHERE cycle_id = $1 ORDER BY sampled_at DESC LIMIT 1`,
          [cycleId],
        )
      : { rows: [] },
    getThresholds(row.farm_id),
  ]);

  res.json({
    serverTime: new Date().toISOString(),
    farmId: row.farm_id,
    thresholds,
    pond: json,
    growth: growth.rows[0] ?? null,
    devices: devices.rows.map((d) => ({
      id: d.id,
      code: d.code,
      kind: d.kind,
      name: d.name,
      isOn: d.is_on,
      currentA: d.current_a,
      fault: d.fault,
      updatedAt: d.updated_at,
    })),
    alarms: alarms.rows,
    manual: manual.rows,
    lab: lab.rows,
    calibrations: calibrations.rows,
  });
});

const RANGES = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };

api.get('/ponds/:id/readings', async (req, res) => {
  const pondId = Number(req.params.id);
  const to = Date.now();
  let from;
  if (req.query.range === 'cycle') {
    const {
      rows: [c],
    } = await pool.query(`SELECT stocked_at FROM crop_cycles WHERE pond_id = $1 AND status = 'active'`, [pondId]);
    from = c ? Date.parse(c.stocked_at) : to - RANGES['30d'] * 1000;
  } else {
    from = to - (RANGES[req.query.range] ?? RANGES['24h']) * 1000;
  }
  res.json(await getReadings(pondId, from, to));
});

api.get('/stream', streamHandler);
