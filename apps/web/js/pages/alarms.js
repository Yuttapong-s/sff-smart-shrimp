// Alarms. Until the alert engine (phase 4) records alarm history, this lists every pond
// that is currently outside thresholds or not reporting, worst first.

import { STATUS_LABEL, statusRank } from '/shared/index.js';
import { store, subscribe, serverNow } from '../store.js';
import { esc, timeAgo, STATUS_ICON } from '../format.js';

export function render(root) {
  function draw() {
    const list = store.order
      .map((id) => store.ponds.get(id))
      .filter((p) => ['crit', 'offline', 'warn'].includes(p.status))
      .sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.code.localeCompare(b.code));

    root.innerHTML = `
      <h1 style="font-size:20px;margin:4px 0 4px">บ่อที่ผิดปกติขณะนี้ <span class="muted num">(${list.length})</span></h1>
      <p class="muted small" style="margin:0 0 12px">ประวัติแจ้งเตือน การรับทราบ และการส่งต่อ (escalation) จะเปิดใช้พร้อมระบบแจ้งเตือน</p>
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
    if (type === 'ponds' || type === 'reset') draw();
  });
}
