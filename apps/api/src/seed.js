import bcrypt from 'bcryptjs';
import { DEFAULT_THRESHOLDS, generatePondCodes } from '@sff/shared';
import { config } from './config.js';

/** Ensure an owner account exists. */
export async function seedAdmin(pool) {
  const { rowCount } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (rowCount) return;
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await pool.query(
    `INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, 'owner')`,
    [config.adminUser, hash, 'ผู้ดูแลระบบ'],
  );
  console.log(`[seed] created owner user "${config.adminUser}"`);
}

/** Demo farm with zones x ponds, 2 aerators per pond, and active crop cycles on ~90% of ponds. */
export async function seedDemoFarm(pool) {
  const { farmCode, farmName, zones, pondsPerZone } = config.seed;
  const { rowCount } = await pool.query('SELECT 1 FROM farms LIMIT 1');
  if (rowCount) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [farm],
    } = await client.query('INSERT INTO farms (code, name) VALUES ($1, $2) RETURNING id', [farmCode, farmName]);

    for (const [metric, t] of Object.entries(DEFAULT_THRESHOLDS)) {
      await client.query(
        `INSERT INTO alarm_rules (farm_id, metric, crit_low, warn_low, warn_high, crit_high)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [farm.id, metric, t.critLow, t.warnLow, t.warnHigh, t.critHigh],
      );
    }

    const zoneIds = new Map();
    const codes = generatePondCodes(zones, pondsPerZone);
    for (const p of codes) {
      if (!zoneIds.has(p.zone)) {
        const {
          rows: [z],
        } = await client.query(
          'INSERT INTO zones (farm_id, code, name, sort) VALUES ($1, $2, $3, $4) RETURNING id',
          [farm.id, p.zone, `โซน ${p.zone}`, p.zoneIndex],
        );
        zoneIds.set(p.zone, z.id);
      }
    }

    // Bulk insert ponds.
    const { rows: ponds } = await client.query(
      `INSERT INTO ponds (farm_id, zone_id, code, name, area_rai, sort)
       SELECT $1, z, c, c, 3.0, s FROM unnest($2::int[], $3::text[], $4::int[]) AS t(z, c, s)
       RETURNING id, code`,
      [farm.id, codes.map((p) => zoneIds.get(p.zone)), codes.map((p) => p.code), codes.map((p) => p.index)],
    );

    const pondIds = ponds.map((p) => p.id);
    await client.query(
      `INSERT INTO devices (pond_id, code, kind, name)
       SELECT id, d.code, 'aerator', d.name FROM unnest($1::int[]) AS id
       CROSS JOIN (VALUES ('AE1', 'เครื่องตีน้ำ 1'), ('AE2', 'เครื่องตีน้ำ 2')) AS d(code, name)`,
      [pondIds],
    );
    await client.query(
      `INSERT INTO pond_control (pond_id, mode) SELECT id, 'remote' FROM unnest($1::int[]) AS id`,
      [pondIds],
    );

    // Deterministic pseudo-random so every fresh install looks the same.
    let s = 42;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const active = pondIds.filter(() => rand() > 0.1);
    await client.query(
      `INSERT INTO crop_cycles (pond_id, cycle_no, stocked_at, stocked_count)
       SELECT id, 1 + (id % 5), current_date - doc, cnt
       FROM unnest($1::int[], $2::int[], $3::int[]) AS t(id, doc, cnt)`,
      [active, active.map(() => Math.floor(5 + rand() * 105)), active.map(() => 150000 + Math.floor(rand() * 15) * 10000)],
    );

    await client.query('COMMIT');
    console.log(`[seed] demo farm ${farmCode}: ${zones} zones, ${pondIds.length} ponds, ${active.length} active cycles`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
