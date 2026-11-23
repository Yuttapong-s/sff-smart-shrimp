// Simple diurnal water-quality model per pond.
// DO and pH follow photosynthesis (low before dawn, high mid-afternoon); temperature lags the sun.

const TAU = Math.PI * 2;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scenario per pond, chosen deterministically so the demo farm looks the same each run. */
export function makePond(code, seed) {
  const rand = mulberry32(seed);
  const roll = rand();
  let scenario = 'normal';
  if (roll < 0.012) scenario = 'low_do'; // crashing DO (critical)
  else if (roll < 0.04) scenario = 'marginal_do'; // borderline DO at night (warning)
  else if (roll < 0.055) scenario = 'high_ph';
  else if (roll < 0.07) scenario = 'offline'; // sensor/RTU not reporting
  else if (roll < 0.08) scenario = 'ph_probe_fault'; // pH value missing

  return {
    code,
    scenario,
    rand,
    doMean: 5.6 + (rand() - 0.5) * 0.8,
    doAmp: 1.4 + rand() * 0.6,
    phMean: 7.95 + (rand() - 0.5) * 0.2,
    tempMean: 29 + (rand() - 0.5) * 1.2,
    orpMean: 260 + (rand() - 0.5) * 60,
    phase: (rand() - 0.5) * 0.08,
  };
}

/** @param {number} ts epoch ms */
export function sample(p, ts) {
  const hour = (new Date(ts).getUTCHours() + 7 + new Date(ts).getUTCMinutes() / 60) % 24; // Asia/Bangkok
  const day = Math.sin(TAU * ((hour - 10) / 24 + p.phase)); // peaks ~16:00, lowest ~04:00
  const noise = (a) => (p.rand() - 0.5) * a;

  let doMean = p.doMean;
  let phMean = p.phMean;
  if (p.scenario === 'low_do') doMean = 3.0;
  if (p.scenario === 'marginal_do') doMean = 4.4;
  if (p.scenario === 'high_ph') phMean = 8.75;

  const s = {
    ts: new Date(ts).toISOString(),
    do: round(Math.max(0.2, doMean + p.doAmp * day + noise(0.3)), 2),
    ph: round(phMean + 0.25 * day + noise(0.04), 2),
    orp: round(p.orpMean + 20 * day + noise(10), 0),
    temp: round(p.tempMean + 1.3 * Math.sin(TAU * ((hour - 9) / 24)) + noise(0.1), 2),
  };
  if (p.scenario === 'ph_probe_fault') s.ph = null;
  return s;
}

/** Aerators run when DO is low or at night (18:00-08:00). */
export function aeratorState(p, s, ts) {
  const hour = (new Date(ts).getUTCHours() + 7) % 24;
  const night = hour >= 18 || hour < 8;
  const need = s.do < 5 || night;
  return [
    { code: 'AE1', on: need, current_a: need ? round(11.5 + p.rand(), 1) : 0, fault: false },
    { code: 'AE2', on: need && (s.do < 4.5 || night), current_a: need && (s.do < 4.5 || night) ? round(11.8 + p.rand(), 1) : 0, fault: false },
  ];
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
