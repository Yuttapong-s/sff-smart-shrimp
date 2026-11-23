import { METRIC_INFO, STATUS_LABEL } from '/shared/index.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmt(metric, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return v.toFixed(METRIC_INFO[metric].digits);
}

/** Shorter value for tiles: ORP / DO% without decimals, others 1 decimal. */
export function fmtTile(metric, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return metric === 'orp' || metric === 'doPct' ? String(Math.round(v)) : v.toFixed(1);
}

export const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('th-TH'));

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'ไม่เคยได้รับข้อมูล';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

export function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtDate(d) {
  if (!d) return '–';
  return new Date(d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
}

// Icon + label so status never relies on color alone.
export const STATUS_ICON = { crit: '‼', warn: '!', offline: '⨯', ok: '✓', idle: '–' };

export const statusText = (s) => `${STATUS_ICON[s]} ${STATUS_LABEL[s]}`;
