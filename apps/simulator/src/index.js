// Farm gateway simulator: publishes RAS telemetry per unit, DO telemetry + device state per pond,
// with an LWT
// so the cloud sees "gateway offline" when this process dies. Optionally backfills history.

import mqtt from 'mqtt';
import { generateLayout, topics } from '@sff/shared';
import { makeUnit, makePond, sampleRas, samplePond, aeratorState } from './model.js';

const env = process.env;
const MQTT_URL = env.MQTT_URL ?? 'mqtt://localhost:1883';
const FARM = env.SIM_FARM_CODE ?? env.SEED_FARM_CODE ?? 'F1';
const UNITS = Number(env.SEED_UNITS ?? 12);
const PONDS_MIN = Number(env.SEED_PONDS_MIN ?? 4);
const PONDS_MAX = Number(env.SEED_PONDS_MAX ?? 6);
const INTERVAL_SEC = Number(env.SIM_INTERVAL_SEC ?? 10);
const BACKFILL_HOURS = Number(env.SIM_BACKFILL_HOURS ?? 24);
const BACKFILL_STEP_SEC = Number(env.SIM_BACKFILL_STEP_SEC ?? 300);

const units = [];
const ponds = [];
for (const u of generateLayout({ units: UNITS, min: PONDS_MIN, max: PONDS_MAX })) {
  const unit = makeUnit(u.unit, 500 + u.unitIndex);
  units.push(unit);
  for (const p of u.ponds) ponds.push(makePond(p.code, 1000 + ponds.length, unit));
}
const scenarios = (list) => list.filter((x) => x.scenario !== 'normal').map((x) => `${x.code}:${x.scenario}`).join(' ');
console.log(`[sim] farm ${FARM}: ${units.length} units, ${ponds.length} ponds`);
console.log(`[sim] scenarios ${scenarios(units)} ${scenarios(ponds)}`);

const client = mqtt.connect(MQTT_URL, {
  clientId: `sff-gateway-sim-${FARM}`,
  username: env.MQTT_USERNAME,
  password: env.MQTT_PASSWORD,
  clean: true,
  will: {
    topic: topics.gatewayStatus(FARM),
    payload: JSON.stringify({ online: false }),
    qos: 1,
    retain: true,
  },
});

const pub = (topic, body, opts = { qos: 1 }) =>
  new Promise((resolve, reject) =>
    client.publish(topic, JSON.stringify(body), opts, (err) => (err ? reject(err) : resolve())),
  );

async function backfill() {
  if (BACKFILL_HOURS <= 0) return;
  const now = Date.now();
  const start = now - BACKFILL_HOURS * 3600_000;
  console.log(`[sim] backfilling ${BACKFILL_HOURS}h at ${BACKFILL_STEP_SEC}s steps...`);
  const series = (fn, x) => {
    const samples = [];
    for (let t = start; t < now - INTERVAL_SEC * 1000; t += BACKFILL_STEP_SEC * 1000) {
      samples.push({ ...fn(x, t), backfill: true });
    }
    return { samples };
  };
  for (const u of units) {
    if (u.scenario !== 'ras_offline') await pub(topics.rasTelemetry(FARM, u.code), series(sampleRas, u));
  }
  for (const p of ponds) {
    if (p.scenario !== 'offline') await pub(topics.telemetry(FARM, p.code), series(samplePond, p));
  }
  console.log('[sim] backfill done');
}

async function tick() {
  const ts = Date.now();
  const jobs = [];
  for (const u of units) {
    if (u.scenario !== 'ras_offline') jobs.push(pub(topics.rasTelemetry(FARM, u.code), sampleRas(u, ts)));
  }
  for (const p of ponds) {
    if (p.scenario === 'offline') continue;
    const s = samplePond(p, ts);
    jobs.push(pub(topics.telemetry(FARM, p.code), s));
    jobs.push(
      pub(
        topics.state(FARM, p.code),
        { ts: s.ts, mode: 'remote', devices: aeratorState(p, s, ts) },
        { qos: 1, retain: true },
      ),
    );
  }
  await Promise.all(jobs);
}

let started = false;
client.on('connect', async () => {
  console.log(`[sim] connected ${MQTT_URL}`);
  await pub(topics.gatewayStatus(FARM), { online: true, ts: new Date().toISOString() }, { qos: 1, retain: true });
  if (started) return; // reconnect: just re-announce online
  started = true;
  try {
    await backfill();
  } catch (err) {
    console.error('[sim] backfill failed', err.message);
  }
  await tick();
  setInterval(() => tick().catch((e) => console.error('[sim] tick failed', e.message)), INTERVAL_SEC * 1000);
  console.log(`[sim] publishing every ${INTERVAL_SEC}s`);
});
client.on('error', (err) => console.error('[mqtt] error', err.message));
