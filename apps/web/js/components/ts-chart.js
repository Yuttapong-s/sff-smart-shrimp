// uPlot time-series chart with warning/critical threshold bands.

import uPlot from '/vendor/uplot/uPlot.esm.js';
import { METRIC_INFO } from '/shared/index.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function bandsPlugin(threshold) {
  return {
    hooks: {
      drawClear: (u) => {
        const { ctx, bbox } = u;
        const y = (v) => u.valToPos(v, 'y', true);
        const top = bbox.top;
        const bottom = bbox.top + bbox.height;
        const clampY = (py) => Math.min(bottom, Math.max(top, py));
        const band = (from, to, color) => {
          const y1 = clampY(y(to));
          const y2 = clampY(y(from));
          if (y2 - y1 <= 0) return;
          ctx.fillStyle = color;
          ctx.fillRect(bbox.left, y1, bbox.width, y2 - y1);
        };
        const lo = u.scales.y.min;
        const hi = u.scales.y.max;
        const t = threshold;
        ctx.save();
        if (isNum(t.critLow)) band(lo, t.critLow, css('--chart-crit'));
        if (isNum(t.warnLow)) band(isNum(t.critLow) ? t.critLow : lo, t.warnLow, css('--chart-warn'));
        if (isNum(t.warnHigh)) band(t.warnHigh, isNum(t.critHigh) ? t.critHigh : hi, css('--chart-warn'));
        if (isNum(t.critHigh)) band(t.critHigh, hi, css('--chart-crit'));
        ctx.restore();
      },
    },
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** 24-hour ticks; day labels when the span is long or at midnight. */
function timeTicks(u, splits) {
  const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
  return splits.map((ts) => {
    const d = new Date(ts * 1000);
    const day = `${d.getDate()} ${TH_MONTHS[d.getMonth()]}`;
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (span > 3 * 86400) return day;
    return d.getHours() === 0 && d.getMinutes() === 0 ? `${hm}\n${day}` : hm;
  });
}

/** Y range that always shows the nearest thresholds so bands give context. */
function yRange(threshold) {
  return (_u, min, max) => {
    const t = threshold;
    const marks = [t.critLow, t.warnLow, t.warnHigh, t.critHigh].filter(isNum);
    if (!isNum(min) || !isNum(max)) {
      if (!marks.length) return [0, 1];
      min = Math.min(...marks);
      max = Math.max(...marks);
    }
    // Pull in thresholds near the data so the band is visible, but don't let far ones flatten the line.
    const span = Math.max(max - min, 1e-6);
    for (const m of marks) {
      if (m < min && min - m < span * 1.5) min = m;
      if (m > max && m - max < span * 1.5) max = m;
    }
    const pad = (max - min) * 0.12 || 0.5;
    return [min - pad, max + pad];
  };
}

/**
 * @param {HTMLElement} el
 * @param {{metric: string, threshold: object, height?: number, syncKey?: string}} opts
 */
export function createChart(el, { metric, threshold, height = 150, syncKey = 'pond' }) {
  const info = METRIC_INFO[metric];
  let data = [[], []];
  let plot = null;
  let xWindow = null; // [fromSec, toSec]: x axis always spans the requested range so gaps show

  const build = () => {
    plot?.destroy();
    const axis = {
      stroke: css('--text-3'),
      grid: { stroke: css('--chart-grid'), width: 1 },
      ticks: { stroke: css('--chart-grid'), width: 1 },
      font: `11px ${css('--font')}`,
    };
    plot = new uPlot(
      {
        width: Math.max(200, el.clientWidth),
        height,
        cursor: { sync: { key: syncKey }, drag: { x: false, y: false } },
        legend: { show: false },
        scales: {
          x: { time: true, range: (_u, min, max) => (xWindow ? [xWindow[0], xWindow[1]] : [min, max]) },
          y: { range: yRange(threshold) },
        },
        axes: [
          { ...axis, space: 64, values: timeTicks },
          {
            ...axis,
            size: 44,
            values: (_u, vals) => vals.map((v) => (metric === 'orp' ? v.toFixed(0) : v.toFixed(info.digits > 1 ? 1 : info.digits))),
          },
        ],
        series: [
          {},
          {
            label: info.label,
            stroke: css('--chart-line'),
            width: 1.6,
            spanGaps: false,
            points: { show: (_u, _si, i0, i1) => i1 - i0 < 40, size: 5 },
            value: (_u, v) => (v == null ? '–' : `${v.toFixed(info.digits)} ${info.unit}`),
          },
        ],
        plugins: [bandsPlugin(threshold)],
      },
      data,
      el,
    );
  };

  build();
  const ro = new ResizeObserver(() => plot?.setSize({ width: Math.max(200, el.clientWidth), height }));
  ro.observe(el);
  const onTheme = () => build();
  window.addEventListener('theme-change', onTheme);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onTheme);

  return {
    /** @param {[number, number]} [range] [fromSec, toSec] */
    setData(t, values, range) {
      if (range) xWindow = range;
      data = [t, values];
      plot.setData(data);
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener('theme-change', onTheme);
      mq.removeEventListener('change', onTheme);
      plot?.destroy();
    },
  };
}

/** Tiny inline SVG sparkline (no axes) for metric cards. */
export function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
  if (pts.length < 2) return '<svg viewBox="0 0 100 34" aria-hidden="true"></svg>';
  const ys = pts.map(([, v]) => v);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const d = pts.map(([i, v]) => `${((i / n) * 100).toFixed(2)},${(32 - ((v - min) / span) * 30).toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><polyline points="${d}"/></svg>`;
}
