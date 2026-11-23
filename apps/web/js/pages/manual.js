// Manual water-test entry. Offline-first form (IndexedDB queue) arrives in phase 3.

import { store } from '../store.js';
import { esc } from '../format.js';

export function render(root, { query }) {
  const pond = store.ponds.get(Number(query.get('pond')));
  root.innerHTML = `
    <h1 style="font-size:20px;margin:4px 0 12px">บันทึกค่าน้ำ${pond ? ` — บ่อ ${esc(pond.code)}` : ''}</h1>
    <div class="card empty">
      ฟอร์มบันทึกค่าน้ำจากชุดทดสอบและผล Lab จะเปิดใช้ในเฟสถัดไป<br>
      (บันทึกได้แม้ไม่มีสัญญาณ แล้วส่งอัตโนมัติเมื่อกลับมาออนไลน์)
      ${pond ? `<div style="margin-top:12px"><a class="btn" href="#/pond/${pond.id}">← กลับไปบ่อ ${esc(pond.code)}</a></div>` : ''}
    </div>`;
  return () => {};
}
