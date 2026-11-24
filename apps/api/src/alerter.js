// Alert engine service (runs as its own container, same image as the api).
//
// Every ALERT_TICK_SEC it reads the latest pond / RAS / gateway state, feeds AlarmEngine, and
// stores alarm changes. Manual records (test-kit water, lab) are checked every 30 s. Open,
// unacknowledged alarms are re-pushed / escalated on schedule. Each change NOTIFYs
// 'alarm_update' so the api pushes fresh counts to open apps over SSE.
//
// Critical control (aerators on low DO) stays on the PLC; this service only tells people.

import {
  evaluateMetric,
  POND_METRICS,
  RAS_METRICS,
  METRIC_INFO,
  STALE_AFTER_SEC,
  WATER_PARAMS,
  LAB_PARAMS,
  PCR_RESULTS,
  waterRefFlag,
  labFlag,
  thresholdsFromRules,
} from '@sff/shared';
import { pool, waitForDb } from './db.js';
import { AlarmEngine, dueEscalations, RECIPIENTS } from './alerts/engine.js';
import { pushTo } from './alerts/push.js';

const env = process.env;
const TICK_SEC = Number(env.ALERT_TICK_SEC ?? 10);
const CLEAR_HOLD_SEC = Number(env.ALERT_CLEAR_HOLD_SEC ?? 60);
const GATEWAY_HOLD_SEC = Number(env.ALERT_GATEWAY_HOLD_SEC ?? 60);
const ESCALATION = {
  critRepeatSec: Number(env.ALERT_CRIT_REPEAT_MIN ?? 5) * 60,
  warnEscalateSec: Number(env.ALERT_WARN_ESCALATE_MIN ?? 30) * 60,
};
const SLOW_EVERY = Math.max(1, Math.round(30 / TICK_SEC)); // manual records + escalation

const engine = new AlarmEngine();
const SEVERITY_TEXT = { crit: 'วิกฤต', warn: 'เตือน' };

// ---------- observations ----------

function holdFor(rules, metric) {
  return rules.find((r) => r.metric === metric)?.hold_seconds ?? 300;
}

/** Live-data observation for one metric of a pond / RAS. */
function metricObs(base, metric, value, thresholds, rules) {
  const { status, direction } = evaluateMetric(metric, value, thresholds);
  const missing = status === 'offline'; // reporting, but this value is absent: probe fault
  return {
    ...base,
    key: `${base.keyPrefix}:${metric}`,
    kind: 'sensor',
    metric,
    value: typeof value === 'number' ? value : null,
    direction,
    missing,
    level: missing ? 'warn' : status === 'ok' ? 'ok' : status,
    hold: holdFor(rules, metric),
    clearHold: CLEAR_HOLD_SEC,
  };
}

async function farmObservations(farm, now) {
  const [{ rows: rules }, { rows: ponds }, { rows: units }] = await Promise.all([
    pool.query('SELECT * FROM alarm_rules WHERE farm_id = $1', [farm.id]),
    pool.query(
      `SELECT p.id, p.code, p.unit_id, l.time, l.do_mgl, l.temp_c, c.id IS NOT NULL AS active
       FROM ponds p LEFT JOIN pond_latest l ON l.pond_id = p.id
       LEFT JOIN crop_cycles c ON c.pond_id = p.id AND c.status = 'active'
       WHERE p.farm_id = $1`,
      [farm.id],
    ),
    pool.query(
      `SELECT u.id, u.code, r.time, r.ph, r.orp_mv, r.temp_c FROM units u
       LEFT JOIN ras_latest r ON r.unit_id = u.id WHERE u.farm_id = $1`,
      [farm.id],
    ),
  ]);
  const thresholds = thresholdsFromRules(rules);
  const gatewayDown = farm.gateway_online === false;
  const out = [];

  if (farm.gateway_online !== null) {
    out.push({
      key: `gateway:${farm.id}`,
      kind: 'gateway',
      farmId: farm.id,
      level: gatewayDown ? 'crit' : 'ok',
      hold: GATEWAY_HOLD_SEC,
      clearHold: 0,
    });
  }

  const owners = [
    ...ponds.map((p) => ({
      base: { farmId: farm.id, pondId: p.id, unitId: p.unit_id, code: p.code, keyPrefix: `pond:${p.id}`, what: `บ่อ ${p.code}` },
      active: p.active,
      time: p.time,
      metrics: POND_METRICS,
      values: { do: p.do_mgl, temp: p.temp_c },
    })),
    ...units.map((u) => ({
      base: { farmId: farm.id, pondId: null, unitId: u.id, code: u.code, keyPrefix: `ras:${u.id}`, what: `RAS ${u.code}` },
      active: true,
      time: u.time,
      metrics: RAS_METRICS,
      values: { ph: u.ph, orp: u.orp_mv, temp: u.temp_c },
    })),
  ];

  for (const o of owners) {
    const offKey = `${o.base.keyPrefix}:offline`;
    const offline = { ...o.base, key: offKey, kind: 'offline', hold: 0, clearHold: 0 };
    if (!o.active) {
      // Idle pond: nothing to watch; close whatever was open.
      out.push({ ...offline, level: 'ok' });
      for (const m of o.metrics) out.push({ ...o.base, key: `${o.base.keyPrefix}:${m}`, level: 'ok', hold: 0, clearHold: 0 });
      continue;
    }
    const stale = !o.time || (now - o.time.getTime()) / 1000 > STALE_AFTER_SEC;
    if (stale) {
      // Whole-gateway outage is one alarm, not one per pond: freeze per-pond state meanwhile.
      // A farm whose gateway never connected (fresh install) has nothing to compare against.
      if (!gatewayDown && farm.gateway_online !== null) out.push({ ...offline, level: 'warn', neverSeen: !o.time });
      continue;
    }
    out.push({ ...offline, level: 'ok' });
    for (const m of o.metrics) out.push(metricObs(o.base, m, o.values[m], thresholds, rules));
  }
  return out;
}

// ---------- messages ----------

function fmtValue(metric, v) {
  const info = METRIC_INFO[metric];
  return `${v.toFixed(info.digits)}${info.unit ? ` ${info.unit}` : ''}`;
}

function describe(obs, severity) {
  const level = severity === 'crit' ? 'วิกฤต' : '';
  switch (obs.kind) {
    case 'gateway':
      return 'Gateway ฟาร์มขาดการเชื่อมต่อ — ข้อมูลทุกบ่อและ RAS ไม่อัปเดต ตรวจไฟ/อินเทอร์เน็ตที่ตู้ควบคุม';
    case 'offline':
      return obs.neverSeen
        ? `${obs.what}: ไม่เคยได้รับข้อมูล — ตรวจการตั้งค่าหัววัด/PLC`
        : `${obs.what}: ไม่มีข้อมูลเกิน ${Math.round(STALE_AFTER_SEC / 60)} นาที — ตรวจหัววัด/สาย/PLC`;
    case 'sensor': {
      const label = METRIC_INFO[obs.metric].label;
      if (obs.missing) return `${obs.what}: ไม่มีค่า ${label} — ตรวจหัววัด`;
      const dir = obs.direction === 'low' ? 'ต่ำ' : 'สูง';
      return `${obs.what}: ${label} ${dir}${level} ${fmtValue(obs.metric, obs.value)}`;
    }
    default:
      return obs.message;
  }
}

function linkFor(a) {
  if (a.pond_id) return `/#/pond/${a.pond_id}`;
  if (a.unit_id) return `/#/unit/${a.unit_id}`;
  return '/#/alarms';
}

function payloadFor(a, { repeat = 0, clear = false } = {}) {
  const sev = SEVERITY_TEXT[a.severity];
  return {
    title: clear ? `✓ กลับสู่ปกติ` : `${a.severity === 'crit' ? '‼' : '!'} ${sev}${repeat ? ` · ยังไม่มีผู้รับทราบ (ครั้งที่ ${repeat + 1})` : ''}`,
    body: a.message,
    tag: clear ? `clear-${a.key}` : a.key,
    url: linkFor(a),
    alarmId: a.id,
    severity: clear ? 'info' : a.severity,
    renotify: !clear,
    time: new Date().toISOString(),
  };
}

// ---------- storing actions ----------

const changedFarms = new Set();

async function notifyFarms() {
  for (const farmId of changedFarms) await pool.query('SELECT pg_notify($1, $2)', ['alarm_update', String(farmId)]);
  changedFarms.clear();
}

async function push(alarm, roles, reason, opts) {
  try {
    const r = await pushTo({ roles, payload: payloadFor(alarm, opts), alarmId: alarm.id, reason });
    if (reason !== 'clear') {
      await pool.query('UPDATE alarms SET last_notified_at = now() WHERE id = $1', [alarm.id]);
    }
    console.log(`[alerter] ${reason} #${alarm.id} ${alarm.severity} "${alarm.message}" -> ${r.users} users / ${r.devices} devices${r.failed ? ` (${r.failed} failed)` : ''}`);
  } catch (err) {
    console.error('[alerter] push failed', err.message);
  }
}

async function openAlarm({ obs, severity, kind = obs.kind, message = describe(obs, severity) }) {
  const { rows } = await pool.query(
    `INSERT INTO alarms (farm_id, pond_id, unit_id, metric, severity, message, kind, key, value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (farm_id, key) WHERE cleared_at IS NULL DO NOTHING
     RETURNING *`,
    [obs.farmId, obs.pondId ?? null, obs.unitId ?? null, obs.metric ?? null, severity, message, kind, obs.key, obs.value ?? null],
  );
  const a = rows[0];
  if (!a) return null;
  changedFarms.add(a.farm_id);
  await push(a, RECIPIENTS[severity], 'open');
  return a;
}

async function applyEngineAction(act) {
  if (act.op === 'open') {
    const a = await openAlarm(act);
    engine.applied(act, a?.id);
  } else if (act.op === 'raise') {
    const { rows } = await pool.query(
      `UPDATE alarms SET severity = 'crit', message = $2, value = $3, acked_at = NULL, acked_by = NULL,
              escalation_level = 0, updated_at = now()
       WHERE id = $1 AND cleared_at IS NULL RETURNING *`,
      [act.alarmId, describe(act.obs, 'crit'), act.obs.value ?? null],
    );
    engine.applied(act);
    if (rows[0]) {
      changedFarms.add(rows[0].farm_id);
      await push(rows[0], RECIPIENTS.crit, 'raise');
    }
  } else if (act.op === 'clear') {
    const { rows } = await pool.query(
      `UPDATE alarms SET cleared_at = now(), updated_at = now() WHERE id = $1 AND cleared_at IS NULL RETURNING *`,
      [act.alarmId],
    );
    engine.applied(act);
    if (rows[0]) {
      changedFarms.add(rows[0].farm_id);
      if (rows[0].severity === 'crit') await push(rows[0], RECIPIENTS.crit, 'clear', { clear: true });
    }
  }
}

// ---------- manual records ----------

async function checkManual() {
  // Test-kit water: the newest value of each param per unit decides (out of range -> warn).
  const { rows: water } = await pool.query(
    `SELECT DISTINCT ON (m.unit_id, m.param) m.unit_id, m.param, m.value, m.time, u.farm_id, u.code
     FROM manual_readings m JOIN units u ON u.id = m.unit_id
     ORDER BY m.unit_id, m.param, m.time DESC`,
  );
  const { rows: openWater } = await pool.query(`SELECT id, key, farm_id FROM alarms WHERE kind = 'water' AND cleared_at IS NULL`);
  const openByKey = new Map(openWater.map((a) => [a.key, a]));
  for (const w of water) {
    const p = WATER_PARAMS[w.param];
    if (!p) continue;
    const key = `water:${w.unit_id}:${w.param}`;
    const flag = waterRefFlag(w.param, w.value);
    const open = openByKey.get(key);
    openByKey.delete(key);
    if (flag && !open) {
      const range = p.ref[0] == null ? `ไม่เกิน ${p.ref[1]}` : p.ref[1] == null ? `≥ ${p.ref[0]}` : `${p.ref[0]}–${p.ref[1]}`;
      await openAlarm({
        obs: { key, farmId: w.farm_id, unitId: w.unit_id, metric: w.param, value: w.value },
        severity: 'warn',
        kind: 'water',
        message: `RAS ${w.code}: ${p.label} ${flag === 'low' ? 'ต่ำ' : 'สูง'} ${w.value} ${p.unit} (แนะนำ ${range}) จากชุดทดสอบ`,
      });
    } else if (!flag && open) {
      await pool.query('UPDATE alarms SET cleared_at = now(), updated_at = now() WHERE id = $1', [open.id]);
      changedFarms.add(open.farm_id);
    }
  }
  // Test deleted: nothing left to back the alarm.
  for (const a of openByKey.values()) {
    await pool.query('UPDATE alarms SET cleared_at = now(), updated_at = now() WHERE id = $1', [a.id]);
    changedFarms.add(a.farm_id);
  }

  // Lab: every flagged result raises one alarm (closed when someone acknowledges it).
  const { rows: lab } = await pool.query(
    `SELECT l.client_id, l.param, l.value, l.value_text, l.sampled_at, l.pond_id, l.unit_id,
            COALESCE(p.farm_id, u.farm_id) AS farm_id, p.code AS pond_code, u.code AS unit_code,
            COALESCE(l.unit_id, p.unit_id) AS any_unit
     FROM lab_results l
     LEFT JOIN ponds p ON p.id = l.pond_id
     LEFT JOIN units u ON u.id = l.unit_id
     WHERE l.created_at > now() - interval '14 days'
       AND NOT EXISTS (SELECT 1 FROM alarms a WHERE a.key = 'lab:' || l.client_id || ':' || l.param)`,
  );
  for (const r of lab) {
    const p = LAB_PARAMS[r.param];
    const v = p?.kind === 'pcr' ? r.value_text : r.value;
    if (!p || !labFlag(r.param, v)) continue;
    const what = r.pond_id ? `บ่อ ${r.pond_code}` : `RAS ${r.unit_code}`;
    const result = p.kind === 'pcr' ? PCR_RESULTS[v] : `${Number(v).toLocaleString('th-TH')} ${p.unit} (ควรไม่เกิน ${p.warnAbove.toLocaleString('th-TH')})`;
    await openAlarm({
      obs: { key: `lab:${r.client_id}:${r.param}`, farmId: r.farm_id, pondId: r.pond_id, unitId: r.any_unit, metric: r.param, value: p.kind === 'count' ? v : null },
      severity: p.kind === 'pcr' ? 'crit' : 'warn',
      kind: 'lab',
      message: `${what}: ผล Lab ${p.label} ${result}`,
    });
  }
}

// ---------- escalation ----------

async function escalate(now) {
  const { rows } = await pool.query(
    `SELECT * FROM alarms WHERE cleared_at IS NULL AND acked_at IS NULL`,
  );
  for (const d of dueEscalations(rows, now, ESCALATION)) {
    const a = d.alarm;
    await pool.query('UPDATE alarms SET escalation_level = escalation_level + 1, updated_at = now() WHERE id = $1', [a.id]);
    changedFarms.add(a.farm_id);
    await push(a, d.roles, d.reason, { repeat: a.escalation_level + 1 });
  }
}

// ---------- main loop ----------

let tickNo = 0;
async function tick() {
  const now = Date.now();
  const { rows: farms } = await pool.query('SELECT id, gateway_online FROM farms');
  for (const farm of farms) {
    const observations = await farmObservations(farm, now);
    for (const act of engine.step(observations, now)) await applyEngineAction(act);
  }
  if (tickNo++ % SLOW_EVERY === 0) {
    await checkManual();
    await escalate(now);
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('alerter_heartbeat', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [{ at: new Date(now).toISOString() }],
  );
  await notifyFarms();
}

async function main() {
  await waitForDb();
  // Wait for the api to finish migrations (alarms.key exists from 004 on).
  for (;;) {
    const { rows } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'alarms' AND column_name = 'key'`);
    if (rows.length) break;
    console.log('[alerter] waiting for migrations');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { rows: open } = await pool.query(
    `SELECT id, key, severity FROM alarms WHERE cleared_at IS NULL AND kind IN ('sensor', 'offline', 'gateway')`,
  );
  engine.restore(open, Date.now());
  console.log(`[alerter] started: tick ${TICK_SEC}s, ${open.length} open alarms restored`);

  let running = false;
  setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('[alerter] tick failed', err);
    } finally {
      running = false;
    }
  }, TICK_SEC * 1000);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[alerter] fatal', err);
  process.exit(1);
});
