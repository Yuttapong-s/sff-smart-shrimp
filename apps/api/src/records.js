// Manual records (phase 3): the offline outbox sync endpoint, deletes, and the read queries
// used by the pond and unit pages.
//
// POST /api/records {items: [{type, clientId, data}]} -> {results: [{clientId, status, errors?}]}
//   status: 'ok' (stored) | 'duplicate' (already stored: safe re-send) | 'rejected' (never retry)
//   Any other failure answers 5xx and the phone retries the whole batch later.

import { Router } from 'express';
import { validateRecord, RECORD_TYPES, WATER_PARAMS, LAB_PARAMS, roleAtLeast } from '@sff/shared';
import { pool } from './db.js';
import { requireRole } from './auth.js';

export const records = Router();

const MAX_BATCH = 100;

class Rejected extends Error {
  constructor(message) {
    super(message);
    this.errors = [message];
  }
}

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0];
}

async function unitFarm(client, unitId) {
  const u = await one(client, 'SELECT farm_id FROM units WHERE id = $1', [unitId]);
  if (!u) throw new Rejected('ไม่พบ Unit นี้');
  return u.farm_id;
}

async function pondFarm(client, pondId, { lock = false } = {}) {
  const p = await one(client, `SELECT farm_id, unit_id FROM ponds WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [pondId]);
  if (!p) throw new Rejected('ไม่พบบ่อนี้');
  return p;
}

/** Cycle a feeding / growth record belongs to: the one the phone saw, else the active one. */
async function resolveCycle(client, pondId, cycleId) {
  if (cycleId) {
    const c = await one(client, 'SELECT id FROM crop_cycles WHERE id = $1 AND pond_id = $2', [cycleId, pondId]);
    if (c) return c.id;
  }
  const c = await one(client, `SELECT id FROM crop_cycles WHERE pond_id = $1 AND status = 'active'`, [pondId]);
  if (!c) throw new Rejected('บ่อนี้ไม่มีรอบการเลี้ยง — ต้องลงกุ้งก่อน');
  return c.id;
}

/** Store one validated record. Returns {inserted, farmId, unitId?, pondId?, pondChanged?}. */
const HANDLERS = {
  async water(client, { clientId, data: d }, user) {
    const farmId = await unitFarm(client, d.unitId);
    const entries = Object.entries(d.values).filter(([, v]) => v != null);
    const { rowCount } = await client.query(
      `INSERT INTO manual_readings (time, unit_id, param, value, unit, method, recorded_by, client_id, note)
       SELECT $1, $2, p, v, u, 'test_kit', $3, $4, $5
       FROM unnest($6::text[], $7::real[], $8::text[]) AS t(p, v, u)
       ON CONFLICT (client_id, param, time) DO NOTHING`,
      [
        d.time,
        d.unitId,
        user.id,
        clientId,
        d.note || null,
        entries.map(([k]) => k),
        entries.map(([, v]) => v),
        entries.map(([k]) => WATER_PARAMS[k].unit),
      ],
    );
    return { inserted: rowCount > 0, farmId, unitId: d.unitId };
  },

  async lab(client, { clientId, data: d }, user) {
    let farmId;
    let unitId = null;
    if (d.unitId) {
      farmId = await unitFarm(client, d.unitId);
      unitId = d.unitId;
    } else {
      ({ farm_id: farmId, unit_id: unitId } = await pondFarm(client, d.pondId));
    }
    const entries = Object.entries(d.results).filter(([, v]) => v != null && v !== '');
    const { rowCount } = await client.query(
      `INSERT INTO lab_results (pond_id, unit_id, sampled_at, lab_name, param, value, value_text, unit, recorded_by, client_id, note)
       SELECT $1, $2, $3, $4, p, v, vt, u, $5, $6, $7
       FROM unnest($8::text[], $9::real[], $10::text[], $11::text[]) AS t(p, v, vt, u)
       ON CONFLICT (client_id, param) DO NOTHING`,
      [
        d.pondId || null,
        d.unitId || null,
        d.sampledAt,
        d.labName?.trim() || null,
        user.id,
        clientId,
        d.note || null,
        entries.map(([k]) => k),
        entries.map(([k, v]) => (LAB_PARAMS[k].kind === 'count' ? v : null)),
        entries.map(([k, v]) => (LAB_PARAMS[k].kind === 'pcr' ? v : null)),
        entries.map(([k]) => LAB_PARAMS[k].unit ?? null),
      ],
    );
    return { inserted: rowCount > 0, farmId, unitId, pondId: d.pondId || null };
  },

  async feeding(client, { clientId, data: d }, user) {
    const p = await pondFarm(client, d.pondId);
    const cycleId = await resolveCycle(client, d.pondId, d.cycleId);
    const { rowCount } = await client.query(
      `INSERT INTO feedings (cycle_id, fed_at, feed_kg, feed_type, tray_check, recorded_by, client_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (client_id) DO NOTHING`,
      [cycleId, d.fedAt, d.feedKg, d.feedType?.trim() || null, d.trayCheck ?? null, user.id, clientId, d.note || null],
    );
    return { inserted: rowCount > 0, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId };
  },

  async growth(client, { clientId, data: d }, user) {
    const p = await pondFarm(client, d.pondId);
    const cycleId = await resolveCycle(client, d.pondId, d.cycleId);
    const { rowCount } = await client.query(
      `INSERT INTO growth_samples (cycle_id, sampled_at, abw_g, survival_pct, sample_count, recorded_by, client_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (client_id) DO NOTHING`,
      [cycleId, d.sampledAt, d.abwG, d.survivalPct ?? null, d.sampleCount ?? null, user.id, clientId, d.note || null],
    );
    return { inserted: rowCount > 0, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId };
  },

  async cycle_start(client, { clientId, data: d }, user) {
    const p = await pondFarm(client, d.pondId, { lock: true }); // serialises cycle_no per pond
    if (await one(client, 'SELECT 1 FROM crop_cycles WHERE client_id = $1', [clientId])) {
      return { inserted: false, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId };
    }
    if (await one(client, `SELECT 1 FROM crop_cycles WHERE pond_id = $1 AND status = 'active'`, [d.pondId])) {
      throw new Rejected('บ่อนี้มีรอบการเลี้ยงที่ยังไม่จบอยู่แล้ว');
    }
    await client.query(
      `INSERT INTO crop_cycles (pond_id, cycle_no, stocked_at, stocked_count, note, client_id, created_by)
       SELECT $1, COALESCE(max(cycle_no), 0) + 1, $2, $3, $4, $5, $6 FROM crop_cycles WHERE pond_id = $1`,
      [d.pondId, d.stockedAt, d.stockedCount, d.note || null, clientId, user.id],
    );
    await audit(client, user, 'cycle_start', `pond:${d.pondId}`, d);
    return { inserted: true, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId, pondChanged: true };
  },

  async cycle_end(client, { clientId, data: d }, user) {
    const p = await pondFarm(client, d.pondId, { lock: true });
    const c = await one(client, 'SELECT status, stocked_at, closed_client_id FROM crop_cycles WHERE id = $1 AND pond_id = $2', [
      d.cycleId,
      d.pondId,
    ]);
    if (!c) throw new Rejected('ไม่พบรอบการเลี้ยงนี้');
    if (c.closed_client_id === clientId) return { inserted: false, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId };
    if (c.status !== 'active') throw new Rejected('รอบการเลี้ยงนี้ถูกปิดไปแล้ว');
    if (d.endedAt < c.stocked_at) throw new Rejected('วันที่จบรอบอยู่ก่อนวันลงกุ้ง');
    await client.query(
      `UPDATE crop_cycles SET status = $2, harvested_at = $3, harvest_kg = $4, closed_by = $5, closed_client_id = $6,
              note = CASE WHEN $7::text IS NULL THEN note ELSE concat_ws(E'\\n', note, $7::text) END
       WHERE id = $1`,
      [d.cycleId, d.status, d.endedAt, d.harvestKg ?? null, user.id, clientId, d.note || null],
    );
    await audit(client, user, 'cycle_end', `pond:${d.pondId}`, d);
    return { inserted: true, farmId: p.farm_id, unitId: p.unit_id, pondId: d.pondId, pondChanged: true };
  },
};

function audit(client, user, action, target, detail) {
  return client.query('INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
    user.id,
    action,
    target,
    detail,
  ]);
}

/** Tell open pages (and the overview, for cycle changes) that records changed. */
async function notify(client, type, r) {
  await client.query('SELECT pg_notify($1, $2)', [
    'record_update',
    JSON.stringify({ farmId: r.farmId, type, unitId: r.unitId ?? null, pondId: r.pondId ?? null }),
  ]);
  if (r.pondChanged) await client.query('SELECT pg_notify($1, $2)', ['pond_update', `${r.farmId}:${r.pondId}`]);
}

async function storeRecord(item, user) {
  const errors = validateRecord(item);
  if (errors.length) return { status: 'rejected', errors };
  if (!roleAtLeast(user.role, RECORD_TYPES[item.type].minRole)) {
    return { status: 'rejected', errors: ['ไม่มีสิทธิ์บันทึกรายการนี้'] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await HANDLERS[item.type](client, item, user);
    if (r.inserted) await notify(client, item.type, r);
    await client.query('COMMIT');
    return { status: r.inserted ? 'ok' : 'duplicate' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof Rejected) return { status: 'rejected', errors: err.errors };
    // Integrity errors will fail the same way on every retry: reject instead of looping.
    if (typeof err.code === 'string' && err.code.startsWith('23')) {
      return { status: 'rejected', errors: [`ข้อมูลไม่ผ่านการตรวจของฐานข้อมูล (${err.code})`] };
    }
    throw err;
  } finally {
    client.release();
  }
}

records.post('/records', async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length > MAX_BATCH) {
    return res.status(400).json({ error: `items must be an array of at most ${MAX_BATCH}` });
  }
  const results = [];
  for (const item of items) {
    results.push({ clientId: item?.clientId, ...(await storeRecord(item, req.user)) });
  }
  res.json({ results });
});

// Delete a whole submission by its clientId (manager+). Cycles are closed, not deleted.
const DELETABLE = { water: 'manual_readings', lab: 'lab_results', feeding: 'feedings', growth: 'growth_samples' };

records.delete('/records/:type/:clientId', requireRole('manager'), async (req, res) => {
  const { type, clientId } = req.params;
  const table = DELETABLE[type];
  if (!table || !/^[0-9a-f-]{36}$/i.test(clientId)) return res.status(400).json({ error: 'bad request' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`DELETE FROM ${table} WHERE client_id = $1 RETURNING *`, [clientId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    // Work out where the record lived so open pages refresh.
    const r0 = rows[0];
    let where;
    if (r0.cycle_id) {
      where = await one(
        client,
        'SELECT p.farm_id, p.unit_id, p.id AS pond_id FROM crop_cycles c JOIN ponds p ON p.id = c.pond_id WHERE c.id = $1',
        [r0.cycle_id],
      );
    } else if (r0.pond_id) {
      where = await one(client, 'SELECT farm_id, unit_id, id AS pond_id FROM ponds WHERE id = $1', [r0.pond_id]);
    } else {
      where = await one(client, 'SELECT farm_id, id AS unit_id FROM units WHERE id = $1', [r0.unit_id]);
    }
    await audit(client, req.user, `delete_${type}`, `client:${clientId}`, { rows });
    if (where) {
      await notify(client, type, { farmId: where.farm_id, unitId: where.unit_id, pondId: where.pond_id ?? null });
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ---------- read queries ----------

const BY = 'LEFT JOIN users usr ON usr.id = x.recorded_by';

/** Test-kit submissions of a unit, newest first: [{clientId, time, values, note, by, createdAt}]. */
export async function waterTests(unitId, limit = 30) {
  const { rows } = await pool.query(
    `SELECT x.client_id, x.time, x.note, x.created_at, usr.display_name AS by,
            jsonb_object_agg(x.param, x.value) AS vals
     FROM manual_readings x ${BY}
     WHERE x.unit_id = $1
     GROUP BY x.client_id, x.time, x.note, x.created_at, usr.display_name
     ORDER BY x.time DESC LIMIT $2`,
    [unitId, limit],
  );
  return rows.map((r) => ({ clientId: r.client_id, time: r.time, values: r.vals, note: r.note, by: r.by, createdAt: r.created_at }));
}

/** Latest value of each test-kit param for a unit: {param: {value, time}}. */
export async function waterLatest(unitId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (param) param, value, time FROM manual_readings
     WHERE unit_id = $1 ORDER BY param, time DESC`,
    [unitId],
  );
  return Object.fromEntries(rows.map((r) => [r.param, { value: r.value, time: r.time }]));
}

/** Lab submissions for a unit's water and/or a pond: [{clientId, target, sampledAt, labName, results, note, by}]. */
export async function labTests({ unitId = null, pondId = null }, limit = 30) {
  const { rows } = await pool.query(
    `SELECT x.client_id, x.unit_id, x.pond_id, x.sampled_at, x.lab_name, x.note, usr.display_name AS by,
            jsonb_object_agg(x.param, COALESCE(to_jsonb(x.value), to_jsonb(x.value_text))) AS res
     FROM lab_results x ${BY}
     WHERE ($1::int IS NOT NULL AND x.unit_id = $1) OR ($2::int IS NOT NULL AND x.pond_id = $2)
     GROUP BY x.client_id, x.unit_id, x.pond_id, x.sampled_at, x.lab_name, x.note, usr.display_name
     ORDER BY x.sampled_at DESC LIMIT $3`,
    [unitId, pondId, limit],
  );
  return rows.map((r) => ({
    clientId: r.client_id,
    target: r.unit_id ? 'unit' : 'pond',
    sampledAt: r.sampled_at,
    labName: r.lab_name,
    results: r.res,
    note: r.note,
    by: r.by,
  }));
}

/** Feedings of a cycle (newest first) and totals; "today" uses the farm's timezone. */
export async function feedings(cycleId, tz = 'Asia/Bangkok', limit = 40) {
  if (!cycleId) return { list: [], todayKg: 0, todayMeals: 0, totalKg: 0 };
  const [{ rows: list }, { rows: [sum] }] = await Promise.all([
    pool.query(
      `SELECT x.client_id, x.fed_at, x.feed_kg, x.feed_type, x.tray_check, x.note, usr.display_name AS by
       FROM feedings x ${BY} WHERE x.cycle_id = $1 ORDER BY x.fed_at DESC LIMIT $2`,
      [cycleId, limit],
    ),
    pool.query(
      `SELECT COALESCE(sum(feed_kg), 0)::float8 AS total,
              COALESCE(sum(feed_kg) FILTER (WHERE (fed_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date), 0)::float8 AS today,
              count(*) FILTER (WHERE (fed_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::int AS meals
       FROM feedings WHERE cycle_id = $1`,
      [cycleId, tz],
    ),
  ]);
  return {
    list: list.map((r) => ({
      clientId: r.client_id,
      fedAt: r.fed_at,
      feedKg: Number(r.feed_kg),
      feedType: r.feed_type,
      trayCheck: r.tray_check,
      note: r.note,
      by: r.by,
    })),
    todayKg: sum.today,
    todayMeals: sum.meals,
    totalKg: sum.total,
  };
}

export async function growthSamples(cycleId, limit = 30) {
  if (!cycleId) return [];
  const { rows } = await pool.query(
    `SELECT x.client_id, x.sampled_at, x.abw_g, x.survival_pct, x.sample_count, x.note, usr.display_name AS by
     FROM growth_samples x ${BY} WHERE x.cycle_id = $1 ORDER BY x.sampled_at DESC LIMIT $2`,
    [cycleId, limit],
  );
  return rows.map((r) => ({
    clientId: r.client_id,
    sampledAt: r.sampled_at,
    abwG: Number(r.abw_g),
    survivalPct: r.survival_pct == null ? null : Number(r.survival_pct),
    sampleCount: r.sample_count,
    note: r.note,
    by: r.by,
  }));
}

export async function cycleHistory(pondId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.cycle_no, c.stocked_at, c.stocked_count, c.harvested_at, c.harvest_kg, c.status, c.note,
            (SELECT COALESCE(sum(feed_kg), 0)::float8 FROM feedings f WHERE f.cycle_id = c.id) AS feed_kg
     FROM crop_cycles c WHERE c.pond_id = $1 ORDER BY c.stocked_at DESC, c.id DESC LIMIT 20`,
    [pondId],
  );
  return rows.map((r) => ({
    id: r.id,
    no: r.cycle_no,
    stockedAt: r.stocked_at,
    stockedCount: r.stocked_count,
    endedAt: r.harvested_at,
    harvestKg: r.harvest_kg == null ? null : Number(r.harvest_kg),
    status: r.status,
    note: r.note,
    feedKg: r.feed_kg,
  }));
}
