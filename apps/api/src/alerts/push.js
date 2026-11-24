// Web Push delivery (VAPID). Keys come from env, else are generated once and kept in app_settings
// so every api / alerter process signs with the same key pair.

import { generateVAPIDKeys, sendNotification } from 'web-push';
import { pool } from '../db.js';

let vapidPromise = null;

export function getVapid() {
  vapidPromise ??= (async () => {
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject };
    }
    const fresh = generateVAPIDKeys();
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [fresh]);
    const {
      rows: [row],
    } = await pool.query(`SELECT value FROM app_settings WHERE key = 'vapid'`);
    return { ...row.value, subject };
  })().catch((err) => {
    vapidPromise = null;
    throw err;
  });
  return vapidPromise;
}

const URGENCY = { crit: 'high', warn: 'normal', info: 'low' };

/**
 * Push a payload to every active user with one of `roles` (or exactly `userIds`).
 * Dead subscriptions (404/410) are removed. Returns {users, devices, failed}.
 * @param {object} p
 * @param {string[]} [p.roles]
 * @param {number[]} [p.userIds]
 * @param {object} p.payload  {title, body, tag, url, alarmId, severity}
 * @param {number|null} [p.alarmId]
 * @param {string} p.reason   alarm_notifications.reason
 */
export async function pushTo({ roles = null, userIds = null, payload, alarmId = null, reason }) {
  const vapid = await getVapid();
  const { rows: subs } = await pool.query(
    `SELECT s.id, s.user_id, s.endpoint, s.keys FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE u.active AND ($1::text[] IS NULL OR u.role = ANY($1)) AND ($2::int[] IS NULL OR u.id = ANY($2))`,
    [roles, userIds],
  );
  const perUser = new Map();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      const u = perUser.get(s.user_id) ?? { devices: 0, failed: 0 };
      perUser.set(s.user_id, u);
      try {
        await sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
          TTL: payload.severity === 'crit' ? 3600 : 6 * 3600,
          urgency: URGENCY[payload.severity] ?? 'normal',
          topic: payload.tag ? payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : undefined,
          vapidDetails: vapid,
          timeout: 10_000,
        });
        u.devices++;
        await pool.query('UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0 WHERE id = $1', [s.id]);
      } catch (err) {
        u.failed++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        } else {
          console.warn('[push] send failed', err.statusCode ?? '', err.message);
          await pool.query('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = $1', [s.id]);
        }
      }
    }),
  );
  if (perUser.size) {
    const ids = [...perUser.keys()];
    await pool.query(
      `INSERT INTO alarm_notifications (alarm_id, user_id, reason, devices, failed)
       SELECT $1, u, $2, d, f FROM unnest($3::int[], $4::int[], $5::int[]) AS t(u, d, f)`,
      [alarmId, reason, ids, ids.map((i) => perUser.get(i).devices), ids.map((i) => perUser.get(i).failed)],
    );
  }
  let devices = 0;
  let failed = 0;
  for (const u of perUser.values()) {
    devices += u.devices;
    failed += u.failed;
  }
  return { users: perUser.size, devices, failed };
}
