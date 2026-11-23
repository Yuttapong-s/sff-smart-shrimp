// Rendering helpers for manual records, shared by the record page, pond page and unit page.
// Server rows and not-yet-sent outbox items render the same way; outbox rows get a "waiting" tag.

import { WATER_PARAMS, LAB_PARAMS, PCR_RESULTS, TRAY_CHECK, RECORD_TYPES, waterRefFlag, labFlag, roleAtLeast } from '/shared/index.js';
import { store } from './store.js';
import { api } from './api.js';
import { esc, fmtInt, fmtDate, fmtDateTime } from './format.js';

export const TYPE_LABEL = Object.fromEntries(Object.entries(RECORD_TYPES).map(([k, v]) => [k, v.label]));

const num = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('th-TH', { maximumFractionDigits: digits }) : '–');

export function targetText(d) {
  if (d.pondId) return `บ่อ ${store.ponds.get(d.pondId)?.code ?? `#${d.pondId}`}`;
  if (d.unitId) return `RAS ${store.units.get(d.unitId)?.code ?? `#${d.unitId}`}`;
  return '';
}

/** Value chips for a water test: flagged when outside the recommended range. */
export function waterChips(values) {
  return Object.keys(WATER_PARAMS)
    .filter((k) => values[k] != null)
    .map((k) => {
      const p = WATER_PARAMS[k];
      const f = waterRefFlag(k, values[k]);
      const tag = f ? ` ${f === 'low' ? '↓' : '↑'}` : '';
      return `<span class="vchip${f ? ' flag' : ''}" title="${f ? 'นอกช่วงแนะนำ' : ''}">${esc(p.label)} <b class="num">${num(values[k], p.digits)}</b> ${esc(p.unit)}${tag}</span>`;
    })
    .join('');
}

export function labChips(results) {
  return Object.keys(LAB_PARAMS)
    .filter((k) => results[k] != null && results[k] !== '')
    .map((k) => {
      const p = LAB_PARAMS[k];
      const v = results[k];
      const flag = labFlag(k, v);
      const shown = p.kind === 'pcr' ? PCR_RESULTS[v] ?? v : `<b class="num">${num(v, 0)}</b> ${p.unit}`;
      return `<span class="vchip${flag ? ' flag' : ''}">${flag ? '! ' : ''}${esc(p.label)} ${shown}</span>`;
    })
    .join('');
}

/** One-line summary of an outbox item. */
export function summarize(it) {
  const d = it.data;
  switch (it.type) {
    case 'water':
      return waterChips(d.values);
    case 'lab':
      return labChips(d.results);
    case 'feeding':
      return `${num(d.feedKg, 2)} kg${d.feedType ? ` · ${esc(d.feedType)}` : ''}${d.trayCheck ? ` · ${TRAY_CHECK[d.trayCheck]}` : ''}`;
    case 'growth':
      return `ABW ${num(d.abwG, 2)} g${d.sampleCount ? ` (สุ่ม ${d.sampleCount} ตัว)` : ''}${d.survivalPct != null ? ` · รอด ${d.survivalPct}%` : ''}`;
    case 'cycle_start':
      return `ลงกุ้ง ${fmtInt(d.stockedCount)} ตัว วันที่ ${fmtDate(d.stockedAt)}`;
    case 'cycle_end':
      return d.status === 'harvested' ? `จับกุ้ง ${num(d.harvestKg, 1)} kg วันที่ ${fmtDate(d.endedAt)}` : `ยกเลิกรอบ วันที่ ${fmtDate(d.endedAt)}`;
    default:
      return '';
  }
}

export function recordTime(it) {
  const d = it.data;
  return d.time ?? d.sampledAt ?? d.fedAt ?? d.stockedAt ?? d.endedAt ?? it.createdAt;
}

export const pendingTag = (it) =>
  it.state === 'rejected'
    ? `<span class="status-pill s-crit" title="${esc((it.errors ?? []).join(', '))}">✕ ไม่ผ่าน</span>`
    : '<span class="status-pill s-warn">⏳ รอส่ง</span>';

const canDelete = () => store.user && roleAtLeast(store.user.role, 'manager');
const delBtn = (type, clientId) =>
  canDelete() ? `<button type="button" class="btn btn-sm" data-del="${type}" data-cid="${clientId}" aria-label="ลบรายการ">ลบ</button>` : '';

function table(head, rows, empty = 'ยังไม่มีข้อมูล') {
  return rows.length
    ? `<div class="table-wrap"><table class="list"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
}

/** Water tests: pending outbox items first, then server rows. */
export function waterTable(serverRows, pending) {
  const rows = [
    ...pending.map(
      (it) => `<tr class="pending"><td>${fmtDateTime(recordTime(it))}<div>${pendingTag(it)}</div></td><td><div class="vchips">${waterChips(it.data.values)}</div></td><td>${esc(it.userName)}</td><td></td></tr>`,
    ),
    ...serverRows.map(
      (r) => `<tr><td>${fmtDateTime(r.time)}</td><td><div class="vchips">${waterChips(r.values)}</div>${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td><td>${esc(r.by ?? '–')}</td><td>${delBtn('water', r.clientId)}</td></tr>`,
    ),
  ];
  return table(['เวลาวัด', 'ค่าน้ำ', 'ผู้บันทึก', ''], rows, 'ยังไม่มีผลวัดค่าน้ำ');
}

export function labTable(serverRows, pending) {
  const where = (d) => (d.unitId ? 'น้ำ RAS' : `ตัวอย่างกุ้ง ${targetText(d)}`);
  const rows = [
    ...pending.map(
      (it) => `<tr class="pending"><td>${fmtDateTime(recordTime(it))}<div>${pendingTag(it)}</div></td><td>${where(it.data)}${it.data.labName ? `<div class="small muted">${esc(it.data.labName)}</div>` : ''}</td><td><div class="vchips">${labChips(it.data.results)}</div></td><td></td></tr>`,
    ),
    ...serverRows.map(
      (r) => `<tr><td>${fmtDateTime(r.sampledAt)}</td><td>${r.target === 'unit' ? 'น้ำ RAS' : 'ตัวอย่างกุ้ง'}${r.labName ? `<div class="small muted">${esc(r.labName)}</div>` : ''}</td><td><div class="vchips">${labChips(r.results)}</div>${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td><td>${delBtn('lab', r.clientId)}</td></tr>`,
    ),
  ];
  return table(['เก็บตัวอย่าง', 'ตัวอย่าง / Lab', 'ผล', ''], rows, 'ยังไม่มีผล Lab');
}

export function feedingTable(feed, pending) {
  const rows = [
    ...pending.map(
      (it) => `<tr class="pending"><td>${fmtDateTime(it.data.fedAt)}<div>${pendingTag(it)}</div></td><td class="num">${num(it.data.feedKg, 2)}</td><td>${esc(it.data.feedType ?? '–')}</td><td>${it.data.trayCheck ? TRAY_CHECK[it.data.trayCheck] : '–'}</td><td>${esc(it.userName)}</td><td></td></tr>`,
    ),
    ...feed.list.map(
      (r) => `<tr><td>${fmtDateTime(r.fedAt)}</td><td class="num">${num(r.feedKg, 2)}</td><td>${esc(r.feedType ?? '–')}</td><td>${r.trayCheck ? TRAY_CHECK[r.trayCheck] ?? esc(r.trayCheck) : '–'}</td><td>${esc(r.by ?? '–')}</td><td>${delBtn('feeding', r.clientId)}</td></tr>`,
    ),
  ];
  return table(['เวลา', 'อาหาร (kg)', 'ชนิด', 'เช็คยอ', 'ผู้บันทึก', ''], rows, 'ยังไม่มีบันทึกการให้อาหารในรอบนี้');
}

/** Shrimp size in pieces per kg from ABW (g). */
export const sizePerKg = (abw) => (abw > 0 ? Math.round(1000 / abw) : null);

export function growthTable(list, pending) {
  const row = (t, abw, count, surv, by, tag = '', del = '') =>
    `<tr${tag ? ' class="pending"' : ''}><td>${fmtDateTime(t)}${tag ? `<div>${tag}</div>` : ''}</td><td class="num">${num(abw, 2)}</td><td class="num">${sizePerKg(abw) ?? '–'}</td><td class="num">${surv != null ? `${surv}%` : '–'}</td><td class="num">${count ?? '–'}</td><td>${esc(by ?? '–')}</td><td>${del}</td></tr>`;
  const rows = [
    ...pending.map((it) => row(it.data.sampledAt, it.data.abwG, it.data.sampleCount, it.data.survivalPct, it.userName, pendingTag(it))),
    ...list.map((r) => row(r.sampledAt, r.abwG, r.sampleCount, r.survivalPct, r.by, '', delBtn('growth', r.clientId))),
  ];
  return table(['วันที่สุ่ม', 'ABW (g)', 'ขนาด (ตัว/กก.)', 'อัตรารอด', 'สุ่ม (ตัว)', 'ผู้บันทึก', ''], rows, 'ยังไม่มีผลสุ่มน้ำหนักในรอบนี้');
}

const CYCLE_STATUS = { active: 'กำลังเลี้ยง', harvested: 'จับแล้ว', cancelled: 'ยกเลิก' };

export function cycleTable(cycles, pending) {
  const rows = [
    ...pending.map((it) => `<tr class="pending"><td colspan="6">${summarize(it)}</td><td>${pendingTag(it)}</td></tr>`),
    ...cycles.map((c) => {
      const fcr = c.harvestKg > 0 && c.feedKg > 0 ? (c.feedKg / c.harvestKg).toFixed(2) : '–';
      return `<tr><td>#${c.no}</td><td>${fmtDate(c.stockedAt)}</td><td class="num">${fmtInt(c.stockedCount)}</td><td>${c.endedAt ? fmtDate(c.endedAt) : '–'}</td><td class="num">${c.harvestKg != null ? num(c.harvestKg, 1) : '–'}</td><td class="num">${num(c.feedKg, 1)} / ${fcr}</td><td>${CYCLE_STATUS[c.status] ?? c.status}</td></tr>`;
    }),
  ];
  return table(['รอบ', 'ลงกุ้ง', 'จำนวน', 'จบรอบ', 'ผลผลิต (kg)', 'อาหารรวม (kg) / FCR', 'สถานะ'], rows, 'ยังไม่มีประวัติรอบการเลี้ยง');
}

/** Delete buttons (manager+) inside `el`; `after` reloads the page data. */
export function bindDelete(el, after) {
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!confirm(`ลบรายการ${TYPE_LABEL[b.dataset.del] ?? ''}นี้?
การลบจะถูกบันทึกไว้ในประวัติการแก้ไข`)) return;
    b.disabled = true;
    try {
      await api.deleteRecord(b.dataset.del, b.dataset.cid);
      after();
    } catch (err) {
      alert(`ลบไม่สำเร็จ: ${err.message}`);
      b.disabled = false;
    }
  });
}
