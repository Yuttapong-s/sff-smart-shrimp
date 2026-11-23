// Unit (= one RAS) queries and the JSON shape shared by overview, unit detail and SSE updates.

import { evaluateRas } from '@sff/shared';
import { pool } from './db.js';
import { getThresholds } from './ponds.js';

const UNIT_SELECT = `
  SELECT u.id, u.farm_id, u.code, u.name, u.sort,
         (SELECT count(*)::int FROM ponds p WHERE p.unit_id = u.id) AS pond_count,
         r.time, r.ph, r.orp_mv, r.temp_c, r.quality
  FROM units u
  LEFT JOIN ras_latest r ON r.unit_id = u.id
`;

export function toUnitJson(r, thresholds, now = Date.now()) {
  const latest = r.time
    ? { time: r.time.toISOString(), ph: r.ph, orp: r.orp_mv, temp: r.temp_c, quality: r.quality }
    : null;
  const ev = evaluateRas({ latest, now, thresholds });
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    pondCount: r.pond_count,
    ras: { latest, status: ev.status, metricStatus: ev.metrics, reasons: ev.reasons },
  };
}

export async function listUnits(farmId, unitIds = null) {
  const params = [farmId];
  let where = 'WHERE u.farm_id = $1';
  if (unitIds) {
    params.push(unitIds);
    where += ' AND u.id = ANY($2::int[])';
  }
  const [{ rows }, thresholds] = await Promise.all([
    pool.query(`${UNIT_SELECT} ${where} ORDER BY u.sort, u.code`, params),
    getThresholds(farmId),
  ]);
  const now = Date.now();
  return rows.map((r) => toUnitJson(r, thresholds, now));
}
