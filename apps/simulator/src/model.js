// Simple diurnal water-quality model.
// Unit = one RAS: pH probe (pH + temp) and ORP probe. Pond: DO probe (mg/L, % saturation, temp).
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

// Fixed scenarios so the demo always shows every case (codes missing from a smaller layout are skipped).
export const POND_SCENARIOS = {
  'U02-P02': 'low_do', // crashing DO at night (critical)
  'U05-P03': 'marginal_do', // borderline DO at night (warning)
  'U08-P01': 'marginal_do',
  'U10-P04': 'offline', // DO probe / RTU not reporting
  'U12-P02': 'do_pct_fault', // DO % missing (probe firmware)
};
export const RAS_SCENARIOS = {
  U03: 'ras_high_ph', // pH drifting up (warn -> crit in the afternoon)
  U06: 'ras_low_orp', // ORP low (warning)
  U09: 'ras_ph_probe_fault', // pH probe gives nothing (pH + its temp missing)
  U11: 'ras_offline', // RAS controller not reporting
};

export function makeUnit(code, seed) {
  const rand = mulberry32(seed);
  return {
    code,
    scenario: RAS_SCENARIOS[code] ?? 'normal',
    rand,
    phMean: 7.95 + (rand() - 0.5) * 0.2,
    orpMean: 300 + (rand() - 0.5) * 60,
    tempMean: 29 + (rand() - 0.5) * 1.2,
    phase: (rand() - 0.5) * 0.08,
  };
}

export function makePond(code, seed, unit) {
  const rand = mulberry32(seed);
  return {
    code,
    unit,
    scenario: POND_SCENARIOS[code] ?? 'normal',
    rand,
    doMean: 5.6 + (rand() - 0.5) * 0.8,
    doAmp: 1.4 + rand() * 0.6,
    tempOffset: (rand() - 0.5) * 0.4, // ponds sit close to their RAS temperature
    phase: (rand() - 0.5) * 0.08,
  };
}

function hourOf(ts) {
  const d = new Date(ts);
  return (d.getUTCHours() + 7 + d.getUTCMinutes() / 60) % 24; // Asia/Bangkok
}

/** Shared water temperature of a unit at time ts. */
function unitTemp(u, hour) {
  return u.tempMean + 1.3 * Math.sin(TAU * ((hour - 9) / 24));
}

/** DO at 100% saturation (mg/L), fresh water, temperature in °C. */
export function doSaturation(t) {
  return 14.652 - 0.41022 * t + 0.007991 * t * t - 0.000077774 * t * t * t;
}

/** RAS sample `{ts, ph, orp, temp}`. @param {number} ts epoch ms */
export function sampleRas(u, ts) {
  const hour = hourOf(ts);
  const day = Math.sin(TAU * ((hour - 10) / 24 + u.phase)); // peaks ~16:00, lowest ~04:00
  const noise = (a) => (u.rand() - 0.5) * a;
  const phMean = u.scenario === 'ras_high_ph' ? 8.75 : u.phMean;
  const orpMean = u.scenario === 'ras_low_orp' ? 125 : u.orpMean;
  const s = {
    ts: new Date(ts).toISOString(),
    ph: round(phMean + 0.25 * day + noise(0.04), 2),
    orp: round(orpMean + 20 * day + noise(10), 0),
    temp: round(unitTemp(u, hour) + noise(0.1), 2),
  };
  if (u.scenario === 'ras_ph_probe_fault') {
    s.ph = null;
    s.temp = null; // temperature comes from the pH probe
  }
  return s;
}

/** Pond sample `{ts, do, do_pct, temp}`. @param {number} ts epoch ms */
export function samplePond(p, ts) {
  const hour = hourOf(ts);
  const day = Math.sin(TAU * ((hour - 10) / 24 + p.phase));
  const noise = (a) => (p.rand() - 0.5) * a;

  let doMean = p.doMean;
  if (p.scenario === 'low_do') doMean = 3.0;
  if (p.scenario === 'marginal_do') doMean = 4.4;

  const temp = round(unitTemp(p.unit, hour) + p.tempOffset + noise(0.1), 2);
  const doMgl = round(Math.max(0.2, doMean + p.doAmp * day + noise(0.3)), 2);
  return {
    ts: new Date(ts).toISOString(),
    do: doMgl,
    do_pct: p.scenario === 'do_pct_fault' ? null : round((doMgl / doSaturation(temp)) * 100, 0),
    temp,
  };
}

/** Aerators run when DO is low or at night (18:00-08:00). */
export function aeratorState(p, s, ts) {
  const hour = (new Date(ts).getUTCHours() + 7) % 24;
  const night = hour >= 18 || hour < 8;
  const need = s.do < 5 || night;
  const second = need && (s.do < 4.5 || night);
  return [
    { code: 'AE1', on: need, current_a: need ? round(11.5 + p.rand(), 1) : 0, fault: false },
    { code: 'AE2', on: second, current_a: second ? round(11.8 + p.rand(), 1) : 0, fault: false },
  ];
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
