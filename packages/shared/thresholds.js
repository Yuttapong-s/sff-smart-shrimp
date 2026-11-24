// Water-quality thresholds and pond / RAS status evaluation.
// Browser-compatible (no Node imports): served to the PWA at /shared/.

// Pond DO probe gives DO (mg/L), DO saturation (%) and temperature.
// RAS (one per unit) has a pH probe (pH + temperature) and an ORP probe.
export const POND_METRICS = ['do', 'temp']; // drive pond status
export const POND_VALUES = ['do', 'doPct', 'temp']; // everything shown for a pond
export const RAS_METRICS = ['ph', 'orp', 'temp'];

export const METRIC_INFO = {
  do: { label: 'DO', unit: 'mg/L', digits: 1, column: 'do_mgl' },
  doPct: { label: 'DO', unit: '%', digits: 0, column: 'do_pct' },
  ph: { label: 'pH', unit: '', digits: 2, column: 'ph' },
  orp: { label: 'ORP', unit: 'mV', digits: 0, column: 'orp_mv' },
  temp: { label: 'อุณหภูมิ', unit: '°C', digits: 1, column: 'temp_c' },
};

// Defaults for Pacific white shrimp (L. vannamei). Overridable per farm via alarm_rules.
export const DEFAULT_THRESHOLDS = {
  do: { critLow: 3.0, warnLow: 4.0, warnHigh: null, critHigh: null },
  ph: { critLow: 7.0, warnLow: 7.5, warnHigh: 8.5, critHigh: 9.0 },
  orp: { critLow: 50, warnLow: 150, warnHigh: null, critHigh: null },
  temp: { critLow: 24, warnLow: 26, warnHigh: 32, critHigh: 34 },
};

// No reading for this long => pond shown as offline / stale data.
export const STALE_AFTER_SEC = 300;

export const STATUS = Object.freeze({
  IDLE: 'idle',
  OK: 'ok',
  WARN: 'warn',
  OFFLINE: 'offline',
  CRIT: 'crit',
});

const RANK = { idle: 0, ok: 1, warn: 2, offline: 3, crit: 4 };

export const STATUS_LABEL = {
  idle: 'บ่อว่าง',
  ok: 'ปกติ',
  warn: 'เตือน',
  offline: 'ขาดการติดต่อ',
  crit: 'วิกฤต',
};

export function statusRank(status) {
  return RANK[status] ?? 0;
}

export function worstStatus(...statuses) {
  return statuses.reduce((a, b) => (statusRank(b) > statusRank(a) ? b : a), STATUS.IDLE);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** @returns {{status: string, direction: 'low'|'high'|null}} */
export function evaluateMetric(metric, value, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds[metric];
  if (!t || !isNum(value)) return { status: STATUS.OFFLINE, direction: null };
  if (isNum(t.critLow) && value < t.critLow) return { status: STATUS.CRIT, direction: 'low' };
  if (isNum(t.critHigh) && value > t.critHigh) return { status: STATUS.CRIT, direction: 'high' };
  if (isNum(t.warnLow) && value < t.warnLow) return { status: STATUS.WARN, direction: 'low' };
  if (isNum(t.warnHigh) && value > t.warnHigh) return { status: STATUS.WARN, direction: 'high' };
  return { status: STATUS.OK, direction: null };
}

/**
 * Evaluate a set of metrics from one latest reading.
 * @returns {{metrics: object, reasons: object[], stale: boolean, live: string}}
 *   live = status ignoring staleness (ok/warn/crit), with a missing value on live data as warn.
 */
export function evaluateReadings(metricList, latest, { now = Date.now(), thresholds = DEFAULT_THRESHOLDS, staleAfterSec = STALE_AFTER_SEC } = {}) {
  const metrics = {};
  const reasons = [];
  const ageSec = latest?.time ? (now - new Date(latest.time).getTime()) / 1000 : Infinity;
  const stale = ageSec > staleAfterSec;
  let live = STATUS.OK;

  for (const m of metricList) {
    const { status, direction } = stale
      ? { status: STATUS.OFFLINE, direction: null }
      : evaluateMetric(m, latest?.[m], thresholds);
    metrics[m] = status;
    if (status === STATUS.CRIT || status === STATUS.WARN) {
      const level = status === STATUS.CRIT ? 'วิกฤต' : '';
      const dir = direction === 'low' ? 'ต่ำ' : 'สูง';
      reasons.push({ metric: m, status, text: `${METRIC_INFO[m].label} ${dir}${level}` });
      live = worstStatus(live, status);
    } else if (status === STATUS.OFFLINE && !stale) {
      // A missing individual value on live data counts as a warning (likely probe fault).
      reasons.push({ metric: m, status: STATUS.WARN, text: `ไม่มีค่า ${METRIC_INFO[m].label}` });
      live = worstStatus(live, STATUS.WARN);
    }
  }
  reasons.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  return { metrics, reasons, stale, live };
}

const OFFLINE_REASON = { metric: null, status: STATUS.OFFLINE, text: 'ไม่มีข้อมูลล่าสุด' };

/**
 * Evaluate a pond's overall status from its latest DO-probe reading.
 * @param {object} p
 * @param {object|null} p.latest  {time, do, doPct, temp}
 * @param {boolean} p.active      pond has an active crop cycle
 * @param {number} [p.now]        epoch ms
 * @param {object} [p.thresholds]
 * @param {number} [p.staleAfterSec]
 */
export function evaluatePond({ latest, active, ...opts }) {
  const r = evaluateReadings(POND_METRICS, latest, opts);
  if (!active) return { status: STATUS.IDLE, metrics: r.metrics, reasons: [], stale: r.stale };
  if (r.stale) return { status: STATUS.OFFLINE, metrics: r.metrics, reasons: [OFFLINE_REASON], stale: true };
  return { status: r.live, metrics: r.metrics, reasons: r.reasons, stale: false };
}

/**
 * Evaluate a unit's RAS (pH / ORP / temp). A RAS is always running, so there is no idle state.
 * @param {object} p
 * @param {object|null} p.latest  {time, ph, orp, temp}
 */
export function evaluateRas({ latest, ...opts }) {
  const r = evaluateReadings(RAS_METRICS, latest, opts);
  if (r.stale) return { status: STATUS.OFFLINE, metrics: r.metrics, reasons: [OFFLINE_REASON], stale: true };
  return { status: r.live, metrics: r.metrics, reasons: r.reasons, stale: false };
}

/** Convert alarm_rules DB rows into the thresholds shape. */
export function thresholdsFromRules(rules) {
  const out = structuredClone(DEFAULT_THRESHOLDS);
  for (const r of rules ?? []) {
    if (!out[r.metric]) continue;
    out[r.metric] = {
      critLow: r.crit_low,
      warnLow: r.warn_low,
      warnHigh: r.warn_high,
      critHigh: r.crit_high,
    };
  }
  return out;
}

// Physically plausible ranges; values outside are treated as sensor faults.
export const PHYSICAL_RANGE = {
  do: [0, 25],
  doPct: [0, 300],
  ph: [0, 14],
  orp: [-2000, 2000],
  temp: [-5, 60],
};

export const ALARM_METRICS = ['do', 'temp', 'ph', 'orp'];

/**
 * Validate one alarm rule {critLow, warnLow, warnHigh, critHigh, holdSeconds} (null = not used).
 * Limits must lie in PHYSICAL_RANGE and increase: critLow < warnLow < warnHigh < critHigh.
 * @returns {string[]} Thai error messages
 */
export function validateRule(metric, r) {
  const errors = [];
  const label = METRIC_INFO[metric]?.label;
  if (!ALARM_METRICS.includes(metric)) return [`ไม่รู้จักค่า ${metric}`];
  const [lo, hi] = PHYSICAL_RANGE[metric];
  const seq = [];
  for (const k of ['critLow', 'warnLow', 'warnHigh', 'critHigh']) {
    const v = r?.[k];
    if (v == null) continue;
    if (!isNum(v)) errors.push(`${label}: ค่าเกณฑ์ต้องเป็นตัวเลข`);
    else if (v < lo || v > hi) errors.push(`${label}: ค่าเกณฑ์ต้องอยู่ระหว่าง ${lo}–${hi}`);
    else seq.push(v);
  }
  if (!errors.length && seq.some((v, i) => i > 0 && v <= seq[i - 1])) {
    errors.push(`${label}: ต้องเรียง วิกฤตต่ำ < เตือนต่ำ < เตือนสูง < วิกฤตสูง`);
  }
  if (!seq.length) errors.push(`${label}: ต้องมีเกณฑ์อย่างน้อย 1 ค่า`);
  const h = r?.holdSeconds;
  if (!Number.isInteger(h) || h < 0 || h > 3600) errors.push(`${label}: เวลายืนยันต้องเป็น 0–3600 วินาที`);
  return errors;
}
