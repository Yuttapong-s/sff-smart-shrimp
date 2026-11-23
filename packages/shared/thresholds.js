// Water-quality thresholds and pond status evaluation.
// Browser-compatible (no Node imports): served to the PWA at /shared/.

export const METRICS = ['do', 'ph', 'orp', 'temp'];

export const METRIC_INFO = {
  do: { label: 'DO', unit: 'mg/L', digits: 1, column: 'do_mgl' },
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
 * Evaluate a pond's overall status from its latest reading.
 * @param {object} p
 * @param {object|null} p.latest  {time, do, ph, orp, temp}
 * @param {boolean} p.active      pond has an active crop cycle
 * @param {number} [p.now]        epoch ms
 * @param {object} [p.thresholds]
 * @param {number} [p.staleAfterSec]
 */
export function evaluatePond({
  latest,
  active,
  now = Date.now(),
  thresholds = DEFAULT_THRESHOLDS,
  staleAfterSec = STALE_AFTER_SEC,
}) {
  const metrics = {};
  const reasons = [];

  const ageSec = latest?.time ? (now - new Date(latest.time).getTime()) / 1000 : Infinity;
  const stale = ageSec > staleAfterSec;

  for (const m of METRICS) {
    const { status, direction } = stale
      ? { status: STATUS.OFFLINE, direction: null }
      : evaluateMetric(m, latest?.[m], thresholds);
    metrics[m] = status;
    if (status === STATUS.CRIT || status === STATUS.WARN) {
      const level = status === STATUS.CRIT ? 'วิกฤต' : '';
      const dir = direction === 'low' ? 'ต่ำ' : 'สูง';
      reasons.push({ metric: m, status, text: `${METRIC_INFO[m].label} ${dir}${level}` });
    }
  }

  if (!active) {
    return { status: STATUS.IDLE, metrics, reasons: [], stale };
  }
  if (stale) {
    return {
      status: STATUS.OFFLINE,
      metrics,
      reasons: [{ metric: null, status: STATUS.OFFLINE, text: 'ไม่มีข้อมูลล่าสุด' }],
      stale,
    };
  }

  // A missing individual value on a live pond counts as a warning (likely sensor fault).
  let status = STATUS.OK;
  for (const m of METRICS) {
    if (metrics[m] === STATUS.OFFLINE) {
      reasons.push({ metric: m, status: STATUS.WARN, text: `ไม่มีค่า ${METRIC_INFO[m].label}` });
      status = worstStatus(status, STATUS.WARN);
    } else {
      status = worstStatus(status, metrics[m]);
    }
  }
  reasons.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  return { status, metrics, reasons, stale };
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
  ph: [0, 14],
  orp: [-1000, 1000],
  temp: [-5, 60],
};
