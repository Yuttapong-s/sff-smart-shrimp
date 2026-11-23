// Farm gateway simulator: publishes telemetry + device state for every pond, with an LWT
// so the cloud sees "gateway offline" when this process dies. Optionally backfills history.

import mqtt from 'mqtt';
import { generatePondCodes, topics } from '@sff/shared';
import { makePond, sample, aeratorState } from './model.js';

const env = process.env;
const MQTT_URL = env.MQTT_URL ?? 'mqtt://localhost:1883';
const FARM = env.SIM_FARM_CODE ?? env.SEED_FARM_CODE ?? 'F1';
const ZONES = Number(env.SEED_ZONES ?? 10);
const PER_ZONE = Number(env.SEED_PONDS_PER_ZONE ?? 50);
const INTERVAL_SEC = Number(env.SIM_INTERVAL_SEC ?? 10);
const BACKFILL_HOURS = Number(env.SIM_BACKFILL_HOURS ?? 24);
const BACKFILL_STEP_SEC = Number(env.SIM_BACKFILL_STEP_SEC ?? 300);

const ponds = generatePondCodes(ZONES, PER_ZONE).map((p, i) => makePond(p.code, 1000 + i));
const counts = ponds.reduce((a, p) => ((a[p.scenario] = (a[p.scenario] ?? 0) + 1), a), {});
console.log(`[sim] farm ${FARM}: ${ponds.length} ponds, scenarios`, counts);

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
  for (const p of ponds) {
    if (p.scenario === 'offline') continue;
    const samples = [];
    for (let t = start; t < now - INTERVAL_SEC * 1000; t += BACKFILL_STEP_SEC * 1000) {
      samples.push({ ...sample(p, t), backfill: true });
    }
    await pub(topics.telemetry(FARM, p.code), { samples });
  }
  console.log('[sim] backfill done');
}

async function tick() {
  const ts = Date.now();
  const jobs = [];
  for (const p of ponds) {
    if (p.scenario === 'offline') continue;
    const s = sample(p, ts);
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
