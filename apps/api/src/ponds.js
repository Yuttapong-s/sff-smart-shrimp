// Pond queries and the JSON shape shared by REST overview, pond detail and SSE updates.

import { evaluatePond, thresholdsFromRules, dayOfCulture } from '@sff/shared';
import { pool } from './db.js';

const POND_SELECT = `
  SELECT p.id, p.farm_id, p.code, p.name, u.id AS unit_id, u.code AS unit,
         l.time, l.do_mgl, l.do_pct, l.temp_c, l.quality,
         c.id AS cycle_id, c.cycle_no, c.stocked_at, c.stocked_count,
         COALESCE(d.on_count, 0) AS aer_on, COALESCE(d.total, 0) AS aer_total,
         COALESCE(d.fault_count, 0) AS aer_fault,
         COALESCE(pc.mode, 'unknown') AS mode
  FROM ponds p
  JOIN units u ON u.id = p.unit_id
  LEFT JOIN pond_latest l ON l.pond_id = p.id
  LEFT JOIN crop_cycles c ON c.pond_id = p.id AND c.status = 'active'
  LEFT JOIN pond_control pc ON pc.pond_id = p.id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE s.is_on) AS on_count,
           count(*) AS total,
           count(*) FILTER (WHERE s.fault) AS fault_count
    FROM devices dv LEFT JOIN device_state s ON s.device_id = dv.id
    WHERE dv.pond_id = p.id AND dv.kind = 'aerator'
  ) d ON true
`;

// Thresholds are read often (every SSE batch) and change rarely: cache briefly.
const thresholdCache = new Map();
export function clearThresholdCache(farmId) {
  thresholdCache.delete(farmId);
}

export async function getThresholds(farmId) {
  const hit = thresholdCache.get(farmId);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const { rows } = await pool.query('SELECT * FROM alarm_rules WHERE farm_id = $1', [farmId]);
  const value = thresholdsFromRules(rows);
  thresholdCache.set(farmId, { at: Date.now(), value });
  return value;
}

export function toPondJson(r, thresholds, now = Date.now()) {
  const latest = r.time
    ? { time: r.time.toISOString(), do: r.do_mgl, doPct: r.do_pct, temp: r.temp_c, quality: r.quality }
    : null;
  const cycle = r.cycle_id
    ? {
        id: r.cycle_id,
        no: r.cycle_no,
        stockedAt: r.stocked_at,
        stockedCount: r.stocked_count,
        doc: dayOfCulture(r.stocked_at, now),
      }
    : null;
  const ev = evaluatePond({ latest, active: !!cycle, now, thresholds });
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    unitId: r.unit_id,
    latest,
    cycle,
    aerators: { on: r.aer_on, total: r.aer_total, fault: r.aer_fault },
    mode: r.mode,
    status: ev.status,
    metricStatus: ev.metrics,
    reasons: ev.reasons,
  };
}

export async function listPonds(farmId, pondIds = null, unitId = null) {
  const params = [farmId];
  let where = 'WHERE p.farm_id = $1';
  if (pondIds) {
    params.push(pondIds);
    where += ` AND p.id = ANY($${params.length}::int[])`;
  }
  if (unitId) {
    params.push(unitId);
    where += ` AND p.unit_id = $${params.length}`;
  }
  const [{ rows }, thresholds] = await Promise.all([
    pool.query(`${POND_SELECT} ${where} ORDER BY u.sort, p.sort`, params),
    getThresholds(farmId),
  ]);
  const now = Date.now();
  return rows.map((r) => toPondJson(r, thresholds, now));
}

export async function getPond(pondId) {
  const { rows } = await pool.query(`${POND_SELECT} WHERE p.id = $1`, [pondId]);
  if (!rows[0]) return null;
  return { row: rows[0], json: toPondJson(rows[0], await getThresholds(rows[0].farm_id)) };
}

/**
 * Pick the cheapest source for a chart range: raw for <= 24h, 5-minute aggregate up to
 * 7 days, hourly beyond. `kind` is 'sensor' (pond DO probes) or 'ras' (unit RAS probes).
 */
export function readingSource(rangeSec, kind = 'sensor') {
  const raw = kind === 'ras' ? 'ras_readings' : 'sensor_readings';
  if (rangeSec <= 24 * 3600) return { table: raw, time: 'time' };
  if (rangeSec <= 7 * 86400) return { table: `${kind}_5m`, time: 'bucket' };
  return { table: `${kind}_1h`, time: 'bucket' };
}

/**
 * Columnar (uPlot-friendly) series: {source, from, to, t: [epochSec], <key>: [...]}.
 * @param {{kind: 'sensor'|'ras', keyCol: string, id: number, columns: Record<string,string>}} q
 *   columns: output key -> SQL column
 */
export async function getSeries({ kind, keyCol, id, columns }, fromMs, toMs) {
  const { table, time } = readingSource((toMs - fromMs) / 1000, kind);
  const entries = Object.entries(columns);
  const { rows } = await pool.query(
    `SELECT extract(epoch FROM ${time})::float8 AS t, ${entries.map(([, c]) => c).join(', ')}
     FROM ${table}
     WHERE ${keyCol} = $1 AND ${time} >= to_timestamp($2) AND ${time} <= to_timestamp($3)
     ORDER BY ${time}`,
    [id, fromMs / 1000, toMs / 1000],
  );
  const out = { source: table, from: fromMs / 1000, to: toMs / 1000, t: [] };
  for (const [k] of entries) out[k] = [];
  for (const r of rows) {
    out.t.push(r.t);
    for (const [k, c] of entries) out[k].push(r[c]);
  }
  return out;
}

/** Pond DO-probe series: {t, do, doPct, temp}. */
export function getReadings(pondId, fromMs, toMs) {
  return getSeries(
    { kind: 'sensor', keyCol: 'pond_id', id: pondId, columns: { do: 'do_mgl', doPct: 'do_pct', temp: 'temp_c' } },
    fromMs,
    toMs,
  );
}

/** RAS series of a unit: {t, ph, orp, temp}. */
export function getRasReadings(unitId, fromMs, toMs) {
  return getSeries(
    { kind: 'ras', keyCol: 'unit_id', id: unitId, columns: { ph: 'ph', orp: 'orp_mv', temp: 'temp_c' } },
    fromMs,
    toMs,
  );
}
