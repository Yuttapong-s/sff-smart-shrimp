// Record page (#/manual?type=&pond=&unit=): test-kit water (RAS), feeding, growth sampling,
// lab results and crop cycles. Works with no signal: every save goes to the IndexedDB outbox
// first and is sent when the phone is back online.

import { WATER_PARAMS, LAB_PARAMS, PCR_RESULTS, TRAY_CHECK, validateRecord, parseNumberInput, roleAtLeast, waterRefFlag } from '/shared/index.js';
import { store, subscribe } from '../store.js';
import { enqueue, discard, listOutbox, onOutboxChange, syncNow } from '../outbox.js';
import { TYPE_LABEL, summarize, targetText, recordTime, pendingTag, sizePerKg } from '../records-view.js';
import { esc, fmtDate, fmtDateTime } from '../format.js';

const TABS = [
  { key: 'feeding', label: 'ให้อาหาร' },
  { key: 'water', label: 'ค่าน้ำ RAS' },
  { key: 'growth', label: 'สุ่มน้ำหนัก' },
  { key: 'lab', label: 'ผล Lab' },
  { key: 'cycle', label: 'รอบการเลี้ยง', minRole: 'manager' },
];
const LAST_TYPE = 'sff-rec-type';
const FEED_TYPES = 'sff-feed-types';
const LAB_NAMES = 'sff-lab-names';
const DUMMY_ID = '00000000-0000-4000-8000-000000000000';

const pad = (n) => String(n).padStart(2, '0');
const localDateTime = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toIso = (v) => (v ? new Date(v).toISOString() : null);

function recall(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? [];
  } catch {
    return [];
  }
}
function remember(key, value) {
  if (!value) return;
  try {
    localStorage.setItem(key, JSON.stringify([value, ...recall(key).filter((x) => x !== value)].slice(0, 8)));
  } catch {}
}

const field = (name, label, inner, hint = '') =>
  `<div class="field" data-field="${name}"><label for="f-${name}">${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const numInput = (name, unit, attrs = '') =>
  `<div class="num-input"><input id="f-${name}" name="${name}" class="input" inputmode="decimal" autocomplete="off" ${attrs}><span class="unit">${esc(unit)}</span></div>`;
const radios = (name, options, checked = '') =>
  `<div class="radio-row" role="radiogroup">${Object.entries(options)
    .map(([v, l]) => `<label class="radio"><input type="radio" name="${name}" value="${v}"${v === checked ? ' checked' : ''}><span>${esc(l)}</span></label>`)
    .join('')}</div>`;
const note = () => field('note', 'หมายเหตุ', '<textarea id="f-note" name="note" class="input" rows="2" maxlength="500"></textarea>');

export function render(root, { query }) {
  const tabs = TABS.filter((t) => !t.minRole || roleAtLeast(store.user?.role, t.minRole));
  let type = query.get('type');
  if (!tabs.some((t) => t.key === type)) type = sessionStorage.getItem(LAST_TYPE) ?? 'feeding';
  if (!tabs.some((t) => t.key === type)) type = 'feeding';
  let pondId = Number(query.get('pond')) || null;
  let unitId = Number(query.get('unit')) || (pondId ? store.ponds.get(pondId)?.unitId : null) || null;
  let outbox = [];
  let toastTimer = null;

  root.innerHTML = `
    <div class="rec-page">
      <h1 class="page-title">บันทึกข้อมูล</h1>
      <div class="seg rec-tabs" role="group" aria-label="ประเภทการบันทึก" data-tabs>
        ${tabs.map((t) => `<button type="button" data-type="${t.key}" aria-pressed="${t.key === type}">${t.label}</button>`).join('')}
      </div>
      <form class="card rec-form" novalidate data-form></form>
      <section class="card section" aria-label="รายการรอส่ง" data-outbox></section>
    </div>
    <div class="toast" role="status" aria-live="polite" data-toast hidden></div>`;

  const formEl = root.querySelector('[data-form]');
  const toastEl = root.querySelector('[data-toast]');

  root.querySelector('[data-tabs]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b || b.dataset.type === type) return;
    type = b.dataset.type;
    sessionStorage.setItem(LAST_TYPE, type);
    for (const x of root.querySelectorAll('[data-type]')) x.setAttribute('aria-pressed', String(x.dataset.type === type));
    renderForm();
  });

  function toast(text, level = 'ok') {
    toastEl.textContent = text;
    toastEl.dataset.level = level;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
  }

  // ---------- target pickers ----------

  const pondsOf = (uid) => store.order.map((id) => store.ponds.get(id)).filter((p) => p.unitId === uid);
  const pendingCycleStart = (pid) => outbox.some((i) => i.type === 'cycle_start' && i.data.pondId === pid && i.state === 'pending');
  const hasCycle = (pid) => !!store.ponds.get(pid)?.cycle || pendingCycleStart(pid);

  function unitSelect() {
    return `<select id="f-unitId" name="unitId" class="select">${store.unitOrder
      .map((id) => store.units.get(id))
      .map((u) => `<option value="${u.id}"${u.id === unitId ? ' selected' : ''}>Unit ${esc(u.code)} (${u.pondCount} บ่อ)</option>`)
      .join('')}</select>`;
  }

  function pondSelect({ markIdle = true } = {}) {
    return `<select id="f-pondId" name="pondId" class="select">${store.unitOrder
      .map((uid) => {
        const u = store.units.get(uid);
        return `<optgroup label="Unit ${esc(u.code)}">${pondsOf(uid)
          .map((p) => {
            const tag = p.cycle ? ` · DOC ${p.cycle.doc}` : markIdle ? ' · บ่อว่าง' : '';
            return `<option value="${p.id}"${p.id === pondId ? ' selected' : ''}>${esc(p.code)}${tag}</option>`;
          })
          .join('')}</optgroup>`;
      })
      .join('')}</select>`;
  }

  // ---------- forms ----------

  const FORMS = {
    feeding: () => `
      ${field('pondId', 'บ่อ', pondSelect(), '<span data-cycle-info></span>')}
      ${field('fedAt', 'เวลาให้อาหาร', `<input id="f-fedAt" name="fedAt" type="datetime-local" class="input" value="${localDateTime()}">`)}
      ${field('feedKg', 'ปริมาณอาหาร', numInput('feedKg', 'kg', 'required'))}
      ${field('feedType', 'ชนิด / เบอร์อาหาร', `<input id="f-feedType" name="feedType" class="input" list="feed-types" maxlength="60" value="${esc(recall(FEED_TYPES)[0] ?? '')}"><datalist id="feed-types">${recall(FEED_TYPES).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`)}
      ${field('trayCheck', 'เช็คยอ (มื้อก่อน)', radios('trayCheck', { '': 'ไม่ได้เช็ค', ...TRAY_CHECK }, ''))}
      ${note()}`,

    water: () => `
      ${field('unitId', 'Unit (น้ำ RAS ที่วัด)', unitSelect())}
      ${field('time', 'เวลาวัด', `<input id="f-time" name="time" type="datetime-local" class="input" value="${localDateTime()}">`)}
      <div class="field-grid">
        ${Object.entries(WATER_PARAMS)
          .map(([k, p]) =>
            field(
              k,
              p.label,
              numInput(k, p.unit),
              p.ref ? `แนะนำ ${p.ref[0] == null ? `ไม่เกิน ${p.ref[1]}` : p.ref[1] == null ? `≥ ${p.ref[0]}` : `${p.ref[0]}–${p.ref[1]}`} <span class="flag-text" data-flag="${k}"></span>` : '',
            ),
          )
          .join('')}
      </div>
      <div class="hint">กรอกเฉพาะค่าที่วัด ช่องว่างจะไม่ถูกบันทึก</div>
      ${note()}`,

    growth: () => `
      ${field('pondId', 'บ่อ', pondSelect(), '<span data-cycle-info></span>')}
      ${field('sampledAt', 'เวลาสุ่ม', `<input id="f-sampledAt" name="sampledAt" type="datetime-local" class="input" value="${localDateTime()}">`)}
      <div class="field-grid">
        ${field('sampleCount', 'จำนวนกุ้งที่สุ่ม', numInput('sampleCount', 'ตัว'))}
        ${field('totalG', 'น้ำหนักรวม', numInput('totalG', 'g'), 'ใส่ 2 ช่องนี้แล้วระบบคำนวณ ABW ให้')}
        ${field('abwG', 'น้ำหนักเฉลี่ย (ABW)', numInput('abwG', 'g/ตัว', 'required'), '<span data-size></span>')}
        ${field('survivalPct', 'อัตรารอดประเมิน', numInput('survivalPct', '%'))}
      </div>
      ${note()}`,

    lab: () => `
      ${field('target', 'ตัวอย่างจาก', radios('target', { unit: 'น้ำ RAS ของ Unit', pond: 'กุ้งจากบ่อ' }, pondId && query.get('type') === 'lab' ? 'pond' : 'unit'))}
      <div data-target-unit>${field('unitId', 'Unit', unitSelect())}</div>
      <div data-target-pond>${field('pondId', 'บ่อ', pondSelect({ markIdle: false }))}</div>
      ${field('sampledAt', 'เวลาเก็บตัวอย่าง', `<input id="f-sampledAt" name="sampledAt" type="datetime-local" class="input" value="${localDateTime()}">`)}
      ${field('labName', 'ชื่อ Lab', `<input id="f-labName" name="labName" class="input" list="lab-names" maxlength="100" value="${esc(recall(LAB_NAMES)[0] ?? '')}"><datalist id="lab-names">${recall(LAB_NAMES).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`)}
      <div class="field-grid">
        ${Object.entries(LAB_PARAMS)
          .map(([k, p]) =>
            p.kind === 'count'
              ? field(k, p.label, numInput(k, p.unit), p.warnAbove != null ? `ควรไม่เกิน ${p.warnAbove.toLocaleString('th-TH')}` : '')
              : field(k, `${p.label} (PCR)`, radios(k, { '': 'ไม่ได้ตรวจ', ...PCR_RESULTS }, '')),
          )
          .join('')}
      </div>
      ${note()}`,

    cycle: () => {
      const p = store.ponds.get(pondId);
      const c = p?.cycle;
      const waiting = outbox.some((i) => (i.type === 'cycle_start' || i.type === 'cycle_end') && i.data.pondId === pondId && i.state === 'pending');
      const head = field('pondId', 'บ่อ', pondSelect());
      if (waiting) {
        return `${head}<div class="note warn-note">บ่อนี้มีรายการรอบการเลี้ยงที่รอส่งอยู่ — รอให้ส่งสำเร็จก่อนแล้วค่อยแก้ไขรอบอีกครั้ง</div>`;
      }
      if (c) {
        return `${head}
          <input type="hidden" name="cycleId" value="${c.id}">
          <div class="note">รอบ <b>#${c.no}</b> · ลงกุ้ง ${fmtDate(c.stockedAt)} · DOC <b>${c.doc}</b> วัน · ${Number(c.stockedCount ?? 0).toLocaleString('th-TH')} ตัว</div>
          ${field('status', 'ปิดรอบเพราะ', radios('status', { harvested: 'จับกุ้ง', cancelled: 'ยกเลิกรอบ (กุ้งตาย/ปัญหา)' }, 'harvested'))}
          ${field('endedAt', 'วันที่', `<input id="f-endedAt" name="endedAt" type="date" class="input" value="${localDate()}">`)}
          ${field('harvestKg', 'ผลผลิตรวม', numInput('harvestKg', 'kg'))}
          ${note()}`;
      }
      return `${head}
        <div class="note">บ่อนี้ว่าง — เริ่มรอบการเลี้ยงใหม่</div>
        ${field('stockedAt', 'วันลงกุ้ง', `<input id="f-stockedAt" name="stockedAt" type="date" class="input" value="${localDate()}">`)}
        ${field('stockedCount', 'จำนวนลูกกุ้ง', numInput('stockedCount', 'ตัว', 'required'))}
        ${note()}`;
    },
  };

  const SUBMIT_TEXT = {
    feeding: 'บันทึกการให้อาหาร',
    water: 'บันทึกค่าน้ำ',
    growth: 'บันทึกผลสุ่มน้ำหนัก',
    lab: 'บันทึกผล Lab',
  };

  function renderForm() {
    if (!store.units.size) {
      formEl.innerHTML = '<div class="empty">ยังไม่มีข้อมูลฟาร์มในเครื่องนี้ — ต้องเปิดแอปตอนมีอินเทอร์เน็ตอย่างน้อยหนึ่งครั้ง</div>';
      return;
    }
    if (!pondId || !store.ponds.has(pondId)) pondId = store.order.find((id) => store.ponds.get(id).unitId === unitId) ?? store.order[0];
    if (!unitId || !store.units.has(unitId)) unitId = store.ponds.get(pondId)?.unitId ?? store.unitOrder[0];

    let submit = SUBMIT_TEXT[type];
    if (type === 'cycle') submit = store.ponds.get(pondId)?.cycle ? 'ปิดรอบการเลี้ยง' : 'เริ่มรอบการเลี้ยง';
    formEl.innerHTML = `
      ${FORMS[type]()}
      <div class="form-errors" role="alert" data-errors></div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">${submit}</button>
        <span class="small muted">${navigator.onLine ? 'บันทึกแล้วส่งทันที' : 'ไม่มีสัญญาณ — จะเก็บไว้ในเครื่องแล้วส่งเมื่อออนไลน์'}</span>
      </div>`;
    if (type === 'cycle' && formEl.querySelector('.warn-note')) formEl.querySelector('[type=submit]').disabled = true;
    afterRender();
  }

  function afterRender() {
    const f = formEl;
    if (f.pondId) f.pondId.value = String(pondId);
    if (f.unitId) f.unitId.value = String(unitId);
    updateCycleInfo();
    if (type === 'lab') updateLabTarget();
    if (type === 'water') for (const k of Object.keys(WATER_PARAMS)) updateWaterFlag(k);
  }

  function updateCycleInfo() {
    const el = formEl.querySelector('[data-cycle-info]');
    if (!el) return;
    const p = store.ponds.get(pondId);
    const btn = formEl.querySelector('[type=submit]');
    if (p?.cycle) {
      el.innerHTML = `รอบ #${p.cycle.no} · DOC ${p.cycle.doc} วัน`;
      el.className = '';
      btn.disabled = false;
    } else if (pendingCycleStart(pondId)) {
      el.textContent = 'รอบใหม่ของบ่อนี้รอส่งอยู่ — บันทึกต่อได้';
      el.className = '';
      btn.disabled = false;
    } else {
      el.textContent = 'บ่อนี้ไม่มีรอบการเลี้ยง — ต้องลงกุ้ง (เริ่มรอบ) ก่อน';
      el.className = 'flag-text';
      btn.disabled = true;
    }
  }

  function updateLabTarget() {
    const t = formEl.querySelector('[name=target]:checked')?.value ?? 'unit';
    formEl.querySelector('[data-target-unit]').hidden = t !== 'unit';
    formEl.querySelector('[data-target-pond]').hidden = t !== 'pond';
  }

  function updateWaterFlag(k) {
    const el = formEl.querySelector(`[data-flag="${k}"]`);
    if (!el) return;
    const v = parseNumberInput(formEl[k].value);
    const f = waterRefFlag(k, v);
    el.textContent = f === 'low' ? '· ต่ำกว่าช่วงแนะนำ' : f === 'high' ? '· สูงกว่าช่วงแนะนำ' : '';
    formEl[k].classList.toggle('input-warn', !!f);
  }

  function updateAbw(e) {
    const count = parseNumberInput(formEl.sampleCount.value);
    const total = parseNumberInput(formEl.totalG.value);
    if (e && (e.target.name === 'sampleCount' || e.target.name === 'totalG') && count > 0 && total > 0) {
      formEl.abwG.value = String(Math.round((total / count) * 100) / 100);
    }
    const abw = parseNumberInput(formEl.abwG.value);
    formEl.querySelector('[data-size]').textContent = abw > 0 ? `ขนาดประมาณ ${sizePerKg(abw)} ตัว/กก.` : '';
  }

  formEl.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n === 'pondId') {
      pondId = Number(e.target.value);
      unitId = store.ponds.get(pondId)?.unitId ?? unitId;
      if (type === 'cycle') renderForm();
      else updateCycleInfo();
    } else if (n === 'unitId') {
      unitId = Number(e.target.value);
    } else if (n === 'target') {
      updateLabTarget();
    }
  });
  formEl.addEventListener('input', (e) => {
    if (type === 'water' && WATER_PARAMS[e.target.name]) updateWaterFlag(e.target.name);
    if (type === 'growth') updateAbw(e);
    formEl.querySelector('[data-errors]').innerHTML = '';
  });

  // ---------- collect + submit ----------

  const numVal = (name) => parseNumberInput(formEl[name]?.value);
  const text = (name) => formEl[name]?.value.trim() || null;
  const radioVal = (name) => formEl.querySelector(`[name="${name}"]:checked`)?.value || null;

  function collect() {
    switch (type) {
      case 'feeding': {
        const p = store.ponds.get(pondId);
        return {
          type: 'feeding',
          data: { pondId, cycleId: p?.cycle?.id ?? null, fedAt: toIso(formEl.fedAt.value), feedKg: numVal('feedKg'), feedType: text('feedType'), trayCheck: radioVal('trayCheck'), note: text('note') },
        };
      }
      case 'water':
        return {
          type: 'water',
          data: {
            unitId,
            time: toIso(formEl.time.value),
            values: Object.fromEntries(Object.keys(WATER_PARAMS).map((k) => [k, numVal(k)]).filter(([, v]) => v !== null)),
            note: text('note'),
          },
        };
      case 'growth': {
        const p = store.ponds.get(pondId);
        return {
          type: 'growth',
          data: { pondId, cycleId: p?.cycle?.id ?? null, sampledAt: toIso(formEl.sampledAt.value), abwG: numVal('abwG'), sampleCount: numVal('sampleCount'), survivalPct: numVal('survivalPct'), note: text('note') },
        };
      }
      case 'lab': {
        const t = radioVal('target') ?? 'unit';
        const results = {};
        for (const [k, p] of Object.entries(LAB_PARAMS)) {
          const v = p.kind === 'count' ? numVal(k) : radioVal(k);
          if (v !== null) results[k] = v;
        }
        return {
          type: 'lab',
          data: { unitId: t === 'unit' ? unitId : null, pondId: t === 'pond' ? pondId : null, sampledAt: toIso(formEl.sampledAt.value), labName: text('labName'), results, note: text('note') },
        };
      }
      case 'cycle':
        if (formEl.cycleId) {
          return {
            type: 'cycle_end',
            data: { pondId, cycleId: Number(formEl.cycleId.value), status: radioVal('status'), endedAt: formEl.endedAt.value || null, harvestKg: numVal('harvestKg'), note: text('note') },
          };
        }
        return { type: 'cycle_start', data: { pondId, stockedAt: formEl.stockedAt.value || null, stockedCount: numVal('stockedCount'), note: text('note') } };
    }
    return null;
  }

  function nextPondWithCycle() {
    const i = store.order.indexOf(pondId);
    for (let k = 1; k < store.order.length; k++) {
      const id = store.order[(i + k) % store.order.length];
      if (hasCycle(id)) return id;
    }
    return pondId;
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rec = collect();
    if (!rec) return;
    const errors = validateRecord({ ...rec, clientId: DUMMY_ID });
    const errEl = formEl.querySelector('[data-errors]');
    if (errors.length) {
      errEl.innerHTML = `<ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      return;
    }
    if (rec.type === 'cycle_end') {
      const p = store.ponds.get(pondId);
      const what = rec.data.status === 'harvested' ? `จับกุ้ง ${rec.data.harvestKg} kg` : 'ยกเลิกรอบ';
      if (!confirm(`ปิดรอบ #${p.cycle.no} ของบ่อ ${p.code} (${what})?\nหลังปิดรอบ บ่อจะเป็นบ่อว่าง`)) return;
    }
    const btn = formEl.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await enqueue(rec.type, rec.data);
    } catch (err) {
      errEl.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
      btn.disabled = false;
      return;
    }
    const offlineNote = navigator.onLine ? '' : ' · เก็บไว้ในเครื่อง รอส่ง';
    let msg = `บันทึก${TYPE_LABEL[rec.type]} ${targetText(rec.data)} แล้ว${offlineNote}`;

    if (rec.type === 'feeding') {
      remember(FEED_TYPES, rec.data.feedType);
      pondId = nextPondWithCycle(); // feeding goes pond by pond: move on to the next one
      unitId = store.ponds.get(pondId)?.unitId ?? unitId;
    }
    if (rec.type === 'lab') remember(LAB_NAMES, rec.data.labName);
    renderForm();
    if (rec.type === 'feeding') {
      const sel = formEl.pondId;
      sel.classList.add('just-moved');
      setTimeout(() => sel.classList.remove('just-moved'), 1200);
      formEl.feedKg.focus();
      msg += ` · ถัดไป ${store.ponds.get(pondId)?.code ?? ''}`;
    }
    toast(msg);
  });

  // ---------- outbox list ----------

  function renderOutbox(items, { syncing } = {}) {
    outbox = items;
    const el = root.querySelector('[data-outbox]');
    const mine = items.filter((i) => i.userId === store.user?.id);
    const others = items.length - mine.length;
    const pending = mine.filter((i) => i.state === 'pending').length;
    el.innerHTML = `
      <div class="section-head">
        <h2>รายการในเครื่องที่ยังไม่ส่ง</h2>
        <button type="button" class="btn" data-sync ${!pending || !navigator.onLine || syncing ? 'disabled' : ''}>${syncing ? 'กำลังส่ง…' : 'ส่งเดี๋ยวนี้'}</button>
      </div>
      ${
        mine.length
          ? `<ul class="outbox-list">${mine
              .slice()
              .reverse()
              .map(
                (it) => `<li class="${it.state}">
                  <div class="ob-top">${pendingTag(it)} <b>${TYPE_LABEL[it.type]}</b> · ${esc(targetText(it.data))} <span class="muted small">${fmtDateTime(recordTime(it))}</span></div>
                  <div class="ob-sum">${summarize(it)}</div>
                  ${it.state === 'rejected' ? `<div class="ob-err">เซิร์ฟเวอร์ไม่รับ: ${esc((it.errors ?? []).join(', '))} <button type="button" class="btn btn-sm" data-discard="${it.clientId}">ลบทิ้ง</button></div>` : ''}
                </li>`,
              )
              .join('')}</ul>`
          : '<div class="empty">ส่งครบแล้ว ไม่มีรายการค้าง</div>'
      }
      ${others ? `<div class="note small">มีอีก ${others} รายการของผู้ใช้อื่นในเครื่องนี้ จะส่งเมื่อผู้ใช้นั้นเข้าสู่ระบบ</div>` : ''}`;
    if (type === 'cycle' || type === 'feeding' || type === 'growth') {
      // Pending cycle changes affect which ponds can take records.
      if (type === 'cycle') {
        const waiting = !!formEl.querySelector('.warn-note');
        const nowWaiting = items.some((i) => (i.type === 'cycle_start' || i.type === 'cycle_end') && i.data.pondId === pondId && i.state === 'pending');
        if (waiting !== nowWaiting) renderForm();
      } else updateCycleInfo();
    }
  }

  root.querySelector('[data-outbox]').addEventListener('click', async (e) => {
    if (e.target.closest('[data-sync]')) syncNow();
    const d = e.target.closest('[data-discard]');
    if (d && confirm('ลบรายการนี้ออกจากเครื่อง? ข้อมูลนี้จะไม่ถูกส่ง')) await discard(d.dataset.discard);
  });

  const onSent = (e) => toast(`ส่งถึงเซิร์ฟเวอร์แล้ว ${e.detail.length} รายการ`);
  window.addEventListener('outbox-sent', onSent);
  const offOutbox = onOutboxChange(renderOutbox);
  const unsub = subscribe((t, ids) => {
    // Cycle started / closed elsewhere (or our own outbox item landed): refresh cycle state.
    if (t === 'reset' || (t === 'ponds' && ids.includes(pondId))) {
      if (type === 'cycle' && !formEl.contains(document.activeElement)) renderForm();
      else updateCycleInfo();
    }
  });

  listOutbox()
    .then((items) => {
      renderOutbox(items);
      renderForm();
    })
    .catch(() => renderForm());

  return () => {
    clearTimeout(toastTimer);
    window.removeEventListener('outbox-sent', onSent);
    offOutbox();
    unsub();
  };
}
