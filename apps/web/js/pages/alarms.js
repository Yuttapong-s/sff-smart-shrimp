// Alarms. Until the alert engine (phase 4) records alarm history, this lists every RAS and
// pond that is currently outside thresholds or not reporting, worst first.

import { STATUS_LABEL, statusRank } from '/shared/index.js';
import { store, subscribe, serverNow, rasProblem } from '../store.js';
import { esc, timeAgo, STATUS_ICON } from '../format.js';

export function render(root) {
  function draw() {
    const byStatus = (a, b) => statusRank(b.status) - statusRank(a.status) || a.code.localeCompare(b.code);
    const ras = store.unitOrder
      .map((id) => store.units.get(id))
      .filter(rasProblem)
      .map((u) => ({ id: u.id, code: u.code, status: u.ras.status, reasons: u.ras.reasons, time: u.ras.latest?.time }))
      .sort(byStatus);
    const list = store.order
      .map((id) => store.ponds.get(id))
      .filter((p) => ['crit', 'offline', 'warn'].includes(p.status))
      .sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.code.localeCompare(b.code));

    root.innerHTML = `
      <p class="muted small" style="margin:4px 0 12px">ประวัติแจ้งเตือน การรับทราบ และการส่งต่อ (escalation) จะเปิดใช้พร้อมระบบแจ้งเตือน</p>
      <h1 style="font-size:20px;margin:4px 0 8px">ระบบ RAS ที่ผิดปกติ <span class="muted num">(${ras.length})</span></h1>
      <div class="card" style="margin-bottom:16px">
        ${
          ras.length
            ? `<table class="list"><thead><tr><th>Unit</th><th>สถานะ</th><th>สาเหตุ</th><th>อัปเดต</th></tr></thead><tbody>
          ${ras
            .map(
              (u) => `<tr>
              <td><a href="#/unit/${u.id}"><b>${esc(u.code)}</b></a></td>
              <td><span class="status-pill s-${u.status}">${STATUS_ICON[u.status]} ${STATUS_LABEL[u.status]}</span></td>
              <td>${esc(u.reasons.map((r) => r.text).join(', '))}</td>
              <td class="small muted">${esc(timeAgo(u.time, serverNow()))}</td></tr>`,
            )
            .join('')}</tbody></table>`
            : '<div class="empty">✓ RAS ทุก Unit ปกติ</div>'
        }
      </div>
      <h1 style="font-size:20px;margin:4px 0 8px">บ่อที่ผิดปกติ <span class="muted num">(${list.length})</span></h1>
      <div class="card">
        ${
          list.length
            ? `<table class="list"><thead><tr><th>บ่อ</th><th>สถานะ</th><th>สาเหตุ</th><th>อัปเดต</th></tr></thead><tbody>
          ${list
            .map(
              (p) => `<tr>
              <td><a href="#/pond/${p.id}"><b>${esc(p.code)}</b></a></td>
              <td><span class="status-pill s-${p.status}">${STATUS_ICON[p.status]} ${STATUS_LABEL[p.status]}</span></td>
              <td>${esc(p.reasons.map((r) => r.text).join(', '))}</td>
              <td class="small muted">${esc(timeAgo(p.latest?.time, serverNow()))}</td></tr>`,
            )
            .join('')}</tbody></table>`
            : '<div class="empty">✓ ทุกบ่อปกติ</div>'
        }
      </div>`;
  }
  draw();
  return subscribe((type) => {
    if (type === 'ponds' || type === 'units' || type === 'reset') draw();
  });
}
