// Farm gateway simulator: publishes RAS telemetry per unit, DO telemetry + device state per pond,
// with an LWT
// so the cloud sees "gateway offline" when this process dies. Optionally backfills history.

import mqtt from 'mqtt';
import { generateLayout, topics, parseTopic } from '@sff/shared';
import { makeUnit, makePond, sampleRas, samplePond, aeratorState, applyCommand } from './model.js';

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
const pondByCode = new Map(ponds.map((p) => [p.code, p]));
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

const lastSample = new Map(); // pond code -> latest DO sample

const publishState = (p, s, ts) =>
  pub(
    topics.state(FARM, p.code),
    { ts: new Date(ts).toISOString(), mode: p.scenario === 'local_mode' ? 'local' : 'remote', devices: aeratorState(p, s, ts) },
    { qos: 1, retain: true },
  );

async function tick() {
  const ts = Date.now();
  const jobs = [];
  for (const u of units) {
    if (u.scenario !== 'ras_offline') jobs.push(pub(topics.rasTelemetry(FARM, u.code), sampleRas(u, ts)));
  }
  for (const p of ponds) {
    if (p.scenario === 'offline') continue;
    const s = samplePond(p, ts);
    lastSample.set(p.code, s);
    jobs.push(pub(topics.telemetry(FARM, p.code), s));
    jobs.push(publishState(p, s, ts));
  }
  await Promise.all(jobs);
}

/** Cloud command -> ack, then the contactor "closes" and the new state is reported ~1.5 s later. */
async function onCommand(topic, msg) {
  const t = parseTopic(topic);
  const p = t?.kind === 'cmd' ? pondByCode.get(t.pond) : null;
  if (!p || p.scenario === 'offline') return;
  let cmd;
  try {
    cmd = JSON.parse(msg.toString());
  } catch {
    return;
  }
  const ack = applyCommand(p, cmd);
  console.log(`[sim] cmd ${p.code}/${cmd.device} ${cmd.action} -> ${ack ? (ack.ok ? 'ok' : ack.reason) : 'no ack'}`);
  if (!ack) return;
  await pub(topics.cmdAck(FARM, p.code), ack);
  if (ack.ok && lastSample.has(p.code)) {
    setTimeout(() => publishState(p, lastSample.get(p.code), Date.now()).catch(() => {}), 1500);
  }
}

let started = false;
client.on('connect', async () => {
  console.log(`[sim] connected ${MQTT_URL}`);
  await pub(topics.gatewayStatus(FARM), { online: true, ts: new Date().toISOString() }, { qos: 1, retain: true });
  if (started) return; // reconnect: just re-announce online
  started = true;
  // Commands are only valid for a few seconds: never use a persistent session for them.
  client.subscribe(`sff/${FARM}/+/cmd`, { qos: 1 });
  client.on('message', (topic, msg) => onCommand(topic, msg).catch((e) => console.error('[sim] cmd failed', e.message)));
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
