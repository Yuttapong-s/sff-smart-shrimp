// Alarms (#/alarms): open alarms from the alert engine with acknowledge, and 30-day history.
// Unacknowledged critical alarms first. Updates live via the SSE 'alarms' event.

import { STATUS_LABEL } from '/shared/index.js';
import { api } from '../api.js';
import { store, subscribe, serverNow } from '../store.js';
import { esc, fmtDateTime, timeAgo, STATUS_ICON } from '../format.js';
import { pushState, enablePush, needsHomeScreen } from '../push.js';

const KIND_LABEL = { sensor: 'เซนเซอร์', offline: 'ขาดการติดต่อ', gateway: 'Gateway', water: 'ค่าน้ำชุดทดสอบ', lab: 'ผล Lab' };

function duration(fromIso, toMs) {
  const s = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.floor(s / 60)} นาที`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม. ${Math.floor((s % 3600) / 60)} นาที`;
  return `${Math.floor(s / 86400)} วัน`;
}

export function render(root) {
  let state = 'open';
  let data = null;
  let destroyed = false;
  let loading = null;

  root.innerHTML = `
    <div class="alarms-page">
      <div class="page-head">
        <h1 class="page-title">แจ้งเตือน</h1>
        <div class="seg" role="group" aria-label="มุมมอง" data-state>
          <button type="button" data-s="open" aria-pressed="true">เปิดอยู่ <span data-open-n></span></button>
          <button type="button" data-s="history" aria-pressed="false">ประวัติ 30 วัน</button>
        </div>
      </div>
      <div data-callouts></div>
      <div data-list><div class="skeleton">กำลังโหลด…</div></div>
    </div>`;

  root.querySelector('[data-state]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b || b.dataset.s === state) return;
    state = b.dataset.s;
    for (const x of root.querySelectorAll('[data-s]')) x.setAttribute('aria-pressed', String(x.dataset.s === state));
    load();
  });

  async function renderCallouts() {
    const el = root.querySelector('[data-callouts]');
    const parts = [];
    const st = store.alarmStats;
    if (st && !st.alerterOk) {
      parts.push(`<div class="callout crit">‼ ระบบแจ้งเตือนหยุดทำงาน${st.alerterAt ? ` (ล่าสุด ${esc(timeAgo(st.alerterAt, serverNow()))})` : ''} — จะไม่มีการแจ้งเตือนใหม่ ติดต่อผู้ดูแลระบบ</div>`);
    }
    const ps = await pushState().catch(() => ({ supported: false }));
    if (!ps.subscribed) {
      const why = !ps.supported
        ? 'เบราว์เซอร์นี้รับการแจ้งเตือนไม่ได้ ใช้ Chrome บน Android หรือคอมพิวเตอร์'
        : needsHomeScreen()
          ? 'บน iPhone/iPad ต้องกด "แชร์ → เพิ่มไปยังหน้าจอโฮม" แล้วเปิดแอปจากไอคอนก่อน'
          : ps.permission === 'denied'
            ? 'การแจ้งเตือนถูกบล็อก — เปิดได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์'
            : 'เครื่องนี้ยังไม่ได้เปิดรับการแจ้งเตือน จะไม่ได้รับแจ้งตอนปิดแอป';
      const can = ps.supported && ps.permission !== 'denied' && !needsHomeScreen();
      parts.push(`<div class="callout warn"><span>🔔 ${why}</span>${can ? '<button type="button" class="btn btn-primary" data-enable-push>เปิดรับการแจ้งเตือน</button>' : ''}</div>`);
    }
    if (destroyed) return;
    el.innerHTML = parts.join('');
    el.querySelector('[data-enable-push]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await enablePush();
        renderCallouts();
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    });
  }

  function card(a) {
    const now = serverNow();
    const link = a.pondId ? `#/pond/${a.pondId}` : a.unitId ? `#/unit/${a.unitId}` : '#/';
    const target = a.pondCode ? `บ่อ ${a.pondCode}` : a.unitCode ? `RAS ${a.unitCode}` : 'ทั้งฟาร์ม';
    const status = a.clearedAt
      ? `<span class="ok-text">✓ หายแล้ว ${esc(fmtDateTime(a.clearedAt))}</span> (นาน ${duration(a.startedAt, Date.parse(a.clearedAt))})`
      : `เปิดอยู่ ${duration(a.startedAt, now)}`;
    const ack = a.ackedAt
      ? `รับทราบโดย <b>${esc(a.ackedBy ?? '–')}</b> ${esc(timeAgo(a.ackedAt, now))}`
      : a.clearedAt
        ? 'ไม่มีผู้รับทราบ'
        : `<b class="unacked-text">ยังไม่มีผู้รับทราบ</b>${a.escalationLevel ? ` · แจ้งซ้ำแล้ว ${a.escalationLevel} ครั้ง` : ''}`;
    const sent = a.pushedDevices ? `ส่ง push แล้ว ${a.pushedDevices} ครั้ง` : 'ยังไม่ได้ส่ง push (ไม่มีเครื่องที่เปิดรับ)';
    const canAck = !a.ackedAt && !a.clearedAt;
    return `<article class="alarm-card sev-${a.severity}${canAck ? ' unacked' : ''}${a.clearedAt ? ' cleared' : ''}">
      <div class="ac-top">
        <span class="status-pill s-${a.severity}">${STATUS_ICON[a.severity]} ${STATUS_LABEL[a.severity]}</span>
        <a href="${link}" class="ac-target">${esc(target)}</a>
        <span class="mini">${KIND_LABEL[a.kind] ?? a.kind}</span>
        <span class="muted small ac-time">${esc(fmtDateTime(a.startedAt))}</span>
      </div>
      <div class="ac-msg">${esc(a.message)}</div>
      <div class="ac-foot">
        <div class="small">${status} · ${ack} · <span class="muted">${sent}</span></div>
        ${canAck ? `<button type="button" class="btn btn-primary" data-ack="${a.id}">รับทราบ</button>` : ''}
      </div>
    </article>`;
  }

  function draw() {
    if (!data) return;
    const list = root.querySelector('[data-list]');
    root.querySelector('[data-open-n]').textContent = `(${data.stats.open})`;
    if (!data.alarms.length) {
      list.innerHTML = `<div class="card empty">${state === 'open' ? '✓ ไม่มีการแจ้งเตือนที่เปิดอยู่' : 'ไม่มีการแจ้งเตือนใน 30 วัน'}</div>`;
      return;
    }
    list.innerHTML = `<div class="alarm-list">${data.alarms.map(card).join('')}</div>`;
  }

  async function load() {
    const req = (loading = api.alarms(state));
    try {
      const d = await req;
      if (destroyed || req !== loading) return;
      data = d;
      draw();
    } catch (err) {
      if (!destroyed) root.querySelector('[data-list]').innerHTML = `<div class="card empty">โหลดไม่สำเร็จ (${esc(err.message)})</div>`;
    }
  }

  root.querySelector('[data-list]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ack]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'กำลังบันทึก…';
    try {
      await api.ackAlarm(Number(b.dataset.ack));
      await load();
    } catch (err) {
      alert(navigator.onLine ? `รับทราบไม่สำเร็จ: ${err.message}` : 'ไม่มีอินเทอร์เน็ต — รับทราบไม่ได้ตอนออฟไลน์');
      b.disabled = false;
      b.textContent = 'รับทราบ';
    }
  });

  let debounce = null;
  const unsub = subscribe((type) => {
    if (type === 'alarms' || type === 'reset') {
      clearTimeout(debounce);
      debounce = setTimeout(load, 500);
      renderCallouts();
    }
  });
  const tickTimer = setInterval(draw, 30_000); // durations

  renderCallouts();
  load();
  return () => {
    destroyed = true;
    unsub();
    clearTimeout(debounce);
    clearInterval(tickTimer);
  };
}
