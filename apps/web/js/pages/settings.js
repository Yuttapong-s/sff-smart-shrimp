// Settings (#/settings): Web Push on this device, in-app alarm sound, and alarm thresholds
// (editable by manager+, read-only for others).

import { ALARM_METRICS, METRIC_INFO, validateRule, roleAtLeast, parseNumberInput } from '/shared/index.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { esc } from '../format.js';
import { pushState, enablePush, disablePush, needsHomeScreen } from '../push.js';
import { soundEnabled, setSoundEnabled, beep } from '../alarm-sound.js';

const FIELDS = [
  ['critLow', 'วิกฤตต่ำกว่า'],
  ['warnLow', 'เตือนต่ำกว่า'],
  ['warnHigh', 'เตือนสูงกว่า'],
  ['critHigh', 'วิกฤตสูงกว่า'],
];

export function render(root) {
  let destroyed = false;
  const canEdit = roleAtLeast(store.user?.role, 'manager');

  root.innerHTML = `
    <div class="rec-page">
      <h1 class="page-title">ตั้งค่า</h1>

      <section class="card section" aria-label="การแจ้งเตือนบนเครื่องนี้">
        <div class="section-head"><h2>การแจ้งเตือนบนเครื่องนี้</h2></div>
        <div class="pad" data-push></div>
      </section>

      <section class="card section" aria-label="เสียงเตือน">
        <div class="section-head"><h2>เสียงเตือนในแอป</h2></div>
        <div class="pad">
          <label class="check"><input type="checkbox" data-sound ${soundEnabled() ? 'checked' : ''}> ส่งเสียงเมื่อมีแจ้งเตือนวิกฤตที่ยังไม่มีผู้รับทราบ (ดังซ้ำทุก 30 วินาทีขณะเปิดแอป)</label>
          <div style="margin-top:8px"><button type="button" class="btn" data-beep>ทดลองเสียง</button></div>
        </div>
      </section>

      <section class="card section" aria-label="เกณฑ์แจ้งเตือน">
        <div class="section-head"><h2>เกณฑ์แจ้งเตือน (ค่าจากหัววัด)</h2></div>
        <form data-rules novalidate><div class="skeleton">กำลังโหลด…</div></form>
      </section>

      <section class="card section" aria-label="ลำดับการแจ้ง">
        <div class="section-head"><h2>ลำดับการแจ้งเตือน</h2></div>
        <ul class="policy">
          <li><b>วิกฤต</b> — ส่งถึงทุกคนทันที และส่งซ้ำทุก 5 นาทีจนกว่าจะมีคนกด "รับทราบ"</li>
          <li><b>เตือน</b> — ส่งถึง technician, manager, owner ถ้า 30 นาทียังไม่มีคนรับทราบ ส่งต่อถึง manager และ owner อีกครั้ง</li>
          <li>ค่าต้องผิดเกณฑ์ต่อเนื่องเท่ากับ "เวลายืนยัน" ก่อนแจ้ง และต้องกลับเป็นปกติต่อเนื่อง 1 นาทีจึงปิดการแจ้งเตือน</li>
          <li>Gateway ขาดการเชื่อมต่อเป็นการแจ้งเตือนเดียวของทั้งฟาร์ม (ไม่แจ้งทีละบ่อ)</li>
          <li>ค่าน้ำชุดทดสอบนอกช่วงแนะนำ และผล Lab ที่พบเชื้อ/เกินเกณฑ์ ก็แจ้งเตือนด้วย</li>
          <li class="muted">ตั้งระยะเวลาส่งซ้ำได้ที่ ALERT_CRIT_REPEAT_MIN / ALERT_WARN_ESCALATE_MIN ในไฟล์ .env ของเซิร์ฟเวอร์</li>
        </ul>
      </section>
      <div class="toast" role="status" aria-live="polite" data-toast hidden></div>
    </div>`;

  const toastEl = root.querySelector('[data-toast]');
  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
  }

  // ---------- push ----------

  async function renderPush() {
    const el = root.querySelector('[data-push]');
    const ps = await pushState().catch(() => ({ supported: false }));
    const server = await api.pushStatus().catch(() => null);
    if (destroyed) return;
    let text;
    let actions = '';
    if (!ps.supported) text = 'เบราว์เซอร์นี้รับการแจ้งเตือนไม่ได้ ใช้ Chrome บน Android หรือคอมพิวเตอร์';
    else if (needsHomeScreen()) text = 'บน iPhone/iPad ต้องกด "แชร์ → เพิ่มไปยังหน้าจอโฮม" แล้วเปิดแอปจากไอคอนก่อน จึงจะเปิดรับการแจ้งเตือนได้';
    else if (ps.permission === 'denied') text = 'การแจ้งเตือนถูกบล็อกในเบราว์เซอร์ — เปิดได้ที่การตั้งค่าเว็บไซต์ (ไอคอนแม่กุญแจข้างที่อยู่เว็บ)';
    else if (ps.subscribed) {
      text = '✓ เครื่องนี้รับการแจ้งเตือนแล้ว — แจ้งได้แม้ปิดแอปหรือล็อกหน้าจอ';
      actions = `<button type="button" class="btn btn-primary" data-test>ส่งการแจ้งเตือนทดสอบ</button>
        <button type="button" class="btn" data-off>ปิดการแจ้งเตือนบนเครื่องนี้</button>`;
    } else {
      text = 'เครื่องนี้ยังไม่รับการแจ้งเตือน';
      actions = '<button type="button" class="btn btn-primary" data-on>เปิดรับการแจ้งเตือน</button>';
    }
    el.innerHTML = `<p style="margin:0 0 10px">${text}</p><div class="form-actions">${actions}</div>
      ${server ? `<p class="small muted" style="margin:10px 0 0">บัญชีของคุณรับการแจ้งเตือนได้ ${server.devices} เครื่อง</p>` : ''}`;
  }

  root.querySelector('[data-push]').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.matches('[data-on]')) {
        await enablePush();
        toast('เปิดรับการแจ้งเตือนแล้ว');
      } else if (b.matches('[data-off]')) {
        await disablePush();
        toast('ปิดการแจ้งเตือนบนเครื่องนี้แล้ว');
      } else if (b.matches('[data-test]')) {
        const r = await api.pushTest();
        toast(r.devices ? `ส่งแล้ว ${r.devices} เครื่อง — ควรเห็นการแจ้งเตือนภายในไม่กี่วินาที` : 'ส่งไม่สำเร็จ — ลองปิดแล้วเปิดการแจ้งเตือนใหม่');
      }
    } catch (err) {
      alert(err.message);
    }
    renderPush();
  });

  // ---------- sound ----------

  root.querySelector('[data-sound]').addEventListener('change', (e) => setSoundEnabled(e.target.checked));
  root.querySelector('[data-beep]').addEventListener('click', () => beep('crit'));

  // ---------- rules ----------

  const form = root.querySelector('[data-rules]');
  async function loadRules() {
    let rules;
    try {
      rules = await api.alarmRules();
    } catch (err) {
      form.innerHTML = `<div class="empty">โหลดไม่สำเร็จ (${esc(err.message)})</div>`;
      return;
    }
    if (destroyed) return;
    const cell = (m, k, v) =>
      `<td><input class="input rule-in" name="${m}.${k}" inputmode="decimal" value="${v ?? ''}" ${canEdit ? '' : 'readonly'} aria-label="${METRIC_INFO[m].label} ${k}"></td>`;
    form.innerHTML = `
      <div class="table-wrap"><table class="list rules">
        <thead><tr><th>ค่า</th>${FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th>เวลายืนยัน (วินาที)</th></tr></thead>
        <tbody>${ALARM_METRICS.map((m) => {
          const r = rules[m] ?? {};
          const unit = METRIC_INFO[m].unit;
          return `<tr><th scope="row">${METRIC_INFO[m].label}${unit ? ` <span class="muted small">(${unit})</span>` : ''}</th>
            ${FIELDS.map(([k]) => cell(m, k, r[k])).join('')}${cell(m, 'holdSeconds', r.holdSeconds ?? 300)}</tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="pad">
        <div class="hint">ช่องว่าง = ไม่ใช้เกณฑ์นั้น · อุณหภูมิใช้ร่วมกันทั้งน้ำในบ่อและน้ำ RAS · ค่าเริ่มต้นเป็นค่ามาตรฐานกุ้งขาว</div>
        <div class="form-errors" role="alert" data-errors></div>
        ${canEdit ? '<div class="form-actions"><button type="submit" class="btn btn-primary">บันทึกเกณฑ์</button></div>' : '<p class="small muted">เฉพาะ manager ขึ้นไปแก้เกณฑ์ได้</p>'}
      </div>`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const rules = {};
    const errors = [];
    for (const m of ALARM_METRICS) {
      const r = {};
      for (const [k] of [...FIELDS, ['holdSeconds']]) {
        const v = parseNumberInput(form.elements[`${m}.${k}`].value);
        r[k] = v;
      }
      errors.push(...validateRule(m, r));
      rules[m] = r;
    }
    const errEl = form.querySelector('[data-errors]');
    if (errors.length) {
      errEl.innerHTML = `<ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      return;
    }
    errEl.innerHTML = '';
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api.saveAlarmRules(store.farm?.id ?? 1, rules);
      toast('บันทึกเกณฑ์แล้ว — มีผลกับสีบ่อและการแจ้งเตือนทันที');
    } catch (err) {
      errEl.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
    }
    btn.disabled = false;
  });

  renderPush();
  loadRules();
  return () => {
    destroyed = true;
    clearTimeout(toastTimer);
  };
}
