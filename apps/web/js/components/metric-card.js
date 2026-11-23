// Latest-value card with status tag, 30-min trend arrow and 6 h sparkline.
// Shared by the pond page (DO / DO% / temp) and the unit page (RAS pH / ORP / temp).

import { METRIC_INFO, STATUS_LABEL } from '/shared/index.js';
import { sparkline } from './ts-chart.js';
import { fmt, STATUS_ICON } from '../format.js';

const TREND_STEP = { do: 0.2, doPct: 3, ph: 0.05, orp: 10, temp: 0.2 };

/** Arrow comparing the last value with the one ~30 minutes earlier. */
export function trendArrow(series, metric) {
  const vals = series[metric];
  const ts = series.t;
  if (!ts.length) return '';
  const last = vals[vals.length - 1];
  const target = ts[ts.length - 1] - 30 * 60;
  let i = ts.length - 1;
  while (i > 0 && ts[i] > target) i--;
  const prev = vals[i];
  if (typeof last !== 'number' || typeof prev !== 'number' || i === ts.length - 1) return '';
  const d = last - prev;
  if (Math.abs(d) < TREND_STEP[metric]) return '<span class="trend" title="ทรงตัว (30 นาที)">→</span>';
  return d > 0
    ? '<span class="trend" title="เพิ่มขึ้น (30 นาที)">↑</span>'
    : '<span class="trend" title="ลดลง (30 นาที)">↓</span>';
}

/**
 * @param {object} o
 * @param {string} o.metric
 * @param {number|null} o.value
 * @param {string} o.ownerStatus   status of the pond / RAS as a whole
 * @param {string|undefined} o.metricStatus  per-metric status (undefined = display-only value)
 * @param {object} o.series        24 h columnar series {t, <metric>: []}
 * @param {string} [o.missingText] note when the owner reports but this value is missing
 */
export function metricCard({ metric, value, ownerStatus, metricStatus, series, missingText }) {
  const info = METRIC_INFO[metric];
  const ownerLevel = ownerStatus === 'idle' || ownerStatus === 'offline';
  let s = ownerLevel ? ownerStatus : metricStatus ?? (typeof value === 'number' ? 'none' : 'offline');
  let tag = ['ok', 'idle', 'none'].includes(s) ? '' : `<span class="tag s-${s}">${STATUS_ICON[s]} ${STATUS_LABEL[s]}</span>`;
  const missing = !ownerLevel && typeof value !== 'number';
  if (missing) {
    // Still reporting but this probe value is absent: likely a sensor fault, not a lost connection.
    s = 'warn';
    tag = `<span class="tag s-warn">! ไม่มีค่า</span>`;
  }
  const sixH = (series.t.at(-1) ?? 0) - 6 * 3600;
  const start = series.t.findIndex((t) => t >= sixH);
  return `<div class="metric" data-s="${s}">
    <div class="top"><span>${info.label}${info.unit === '%' ? ' (% อิ่มตัว)' : ''}</span>${tag}</div>
    <div class="value"><span class="v">${fmt(metric, value)}</span><span class="u">${info.unit}</span>${trendArrow(series, metric)}</div>
    ${sparkline(start >= 0 ? series[metric].slice(start) : [])}
    <div class="when">${missing ? missingText ?? 'ยังส่งข้อมูล แต่ไม่มีค่านี้ — ตรวจหัววัด' : '6 ชม.ล่าสุด'}</div>
  </div>`;
}
