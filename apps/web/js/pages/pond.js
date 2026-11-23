// Pond detail: status, crop cycle, DO-probe cards, the unit's RAS values, charts, devices, tabs.

import { POND_VALUES, RAS_METRICS, METRIC_INFO, STATUS_LABEL } from '/shared/index.js';
import { api } from '../api.js';
import { store, subscribe, serverNow } from '../store.js';
import { goBack } from '../router.js';
import { createChart } from '../components/ts-chart.js';
import { metricCard } from '../components/metric-card.js';
import { esc, fmt, fmtInt, fmtDate, fmtDateTime, timeAgo, STATUS_ICON, statusText } from '../format.js';

const RANGES = [
  { key: '24h', label: '24 ชม.' },
  { key: '7d', label: '7 วัน' },
  { key: 'cycle', label: 'ทั้งรอบ' },
];
const MODE_TEXT = { remote: 'Remote (สั่งจากระบบได้)', local: 'Local (สั่งที่ HMI หน้าฟาร์มเท่านั้น)', unknown: 'ไม่ทราบ' };

export function render(root, { params }) {
  const pondId = Number(params[0]);
  let destroyed = false;
  let detail = null;
  let day = null; // 24h readings for cards + default chart
  let range = '24h';
  let charts = [];
  let tab = 'alarms';

  root.innerHTML = `<div class="skeleton">กำลังโหลดข้อมูลบ่อ…</div>`;

  const pondJson = () => store.ponds.get(pondId) ?? detail?.pond;
  const unitJson = () => (detail?.unit ? store.units.get(detail.unit.id) ?? detail.unit : null);

  async function load() {
    try {
      [detail, day] = await Promise.all([api.pond(pondId), api.readings(pondId, '24h')]);
    } catch (err) {
      if (!destroyed) root.innerHTML = `<div class="empty">โหลดข้อมูลไม่สำเร็จ (${esc(err.message)}) <a href="#/">กลับหน้าภาพรวม</a></div>`;
      return;
    }
    if (destroyed) return;
    layout();
  }

  function layout() {
    root.innerHTML = `
      <div class="pond-head">
        <button type="button" class="btn back" data-back>← ภาพรวม</button>
        <h1></h1>
        <span class="status-pill" data-status-pill></span>
      </div>
      <div class="reasons" data-reasons></div>
      <div class="pond-meta" data-meta></div>

      <section class="metrics metrics-3" data-metrics aria-label="ค่าน้ำล่าสุดของบ่อ"></section>
      <a class="card ras-panel" data-ras href="#/unit/${detail.unit?.id ?? ''}"></a>

      <section class="card section">
        <div class="section-head">
          <h2>กราฟคุณภาพน้ำ</h2>
          <div class="seg" role="group" aria-label="ช่วงเวลา" data-ranges>
            ${RANGES.map((r) => `<button type="button" data-range="${r.key}" aria-pressed="${r.key === range}">${r.label}</button>`).join('')}
          </div>
        </div>
        <div class="charts" data-charts>
          ${POND_VALUES.map(
            (m) => `<div class="chart-block"><div class="chart-title">${METRIC_INFO[m].label} ${METRIC_INFO[m].unit ? `(${METRIC_INFO[m].unit})` : ''}</div><div class="chart-wrap" data-chart="${m}"></div></div>`,
          ).join('')}
        </div>
        <div class="note small">แถบเหลือง = ช่วงเตือน · แถบแดง = ช่วงวิกฤต · ${esc(rangeNote())}</div>
      </section>

      <section class="card section" aria-label="อุปกรณ์">
        <div class="section-head"><h2>อุปกรณ์</h2><span class="small muted" data-mode></span></div>
        <ul class="devices" data-devices></ul>
        <div class="note" data-control-note></div>
      </section>

      <section class="card section">
        <div class="tabs" role="tablist" data-tabs>
          ${[
            ['alarms', 'แจ้งเตือน'],
            ['manual', 'ค่าน้ำ (ชุดทดสอบ)'],
            ['lab', 'ผล Lab'],
            ['calibrations', 'Calibrate'],
          ]
            .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`)
            .join('')}
        </div>
        <div data-tab-body></div>
      </section>

      <a class="fab" href="#/manual?pond=${pondId}">✎ บันทึกค่าน้ำบ่อนี้</a>
    `;

    root.querySelector('[data-back]').addEventListener('click', () => goBack('#/'));
    root.querySelector('[data-ranges]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-range]');
      if (!b || b.dataset.range === range) return;
      range = b.dataset.range;
      for (const x of root.querySelectorAll('[data-range]')) x.setAttribute('aria-pressed', String(x.dataset.range === range));
      root.querySelector('.charts + .note').textContent = `แถบเหลือง = ช่วงเตือน · แถบแดง = ช่วงวิกฤต · ${rangeNote()}`;
      loadChart();
    });
    root.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      tab = b.dataset.tab;
      for (const x of root.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x.dataset.tab === tab));
      renderTab();
    });

    const th = detail.thresholds;
    charts = POND_VALUES.map((m) => ({
      metric: m,
      chart: createChart(root.querySelector(`[data-chart="${m}"]`), { metric: m, threshold: th[m] }),
    }));

    renderHead();
    renderCards();
    renderRas();
    renderDevices();
    renderTab();
    setChartData(day);
  }

  function rangeNote() {
    return range === '24h' ? 'ข้อมูลดิบ' : range === '7d' ? 'ค่าเฉลี่ยทุก 5 นาที' : 'ค่าเฉลี่ยรายชั่วโมง';
  }

  function renderHead() {
    const p = pondJson();
    root.querySelector('h1').textContent = `บ่อ ${p.code}`;
    const pill = root.querySelector('[data-status-pill]');
    pill.className = `status-pill s-${p.status}`;
    pill.textContent = statusText(p.status);
    document.title = `${p.code} · ${STATUS_LABEL[p.status]} — SFF`;

    root.querySelector('[data-reasons]').innerHTML = (p.reasons ?? [])
      .map((r) => `<span class="status-pill s-${r.status}">${STATUS_ICON[r.status]} ${esc(r.text)}</span>`)
      .join('');

    const c = p.cycle;
    const g = detail.growth;
    const parts = [`<span>Unit <b>${esc(p.unit)}</b></span>`];
    if (c) {
      parts.push(`<span>รอบเลี้ยง <b>#${c.no}</b></span>`);
      parts.push(`<span>DOC <b class="num">${c.doc}</b> วัน</span>`);
      parts.push(`<span>ปล่อย <b class="num">${fmtInt(c.stockedCount)}</b> ตัว (${fmtDate(c.stockedAt)})</span>`);
      parts.push(g ? `<span>ABW <b class="num">${g.abw_g}</b> g</span>` : `<span class="muted">ยังไม่มีผลสุ่มน้ำหนัก</span>`);
      if (g?.survival_pct) parts.push(`<span>อัตรารอดประเมิน <b class="num">${g.survival_pct}%</b></span>`);
    } else {
      parts.push('<span><b>บ่อว่าง</b> — ไม่มีรอบการเลี้ยง</span>');
    }
    parts.push(`<span>อัปเดต ${esc(timeAgo(p.latest?.time, serverNow()))}</span>`);
    root.querySelector('[data-meta]').innerHTML = parts.join('');
  }

  function renderCards() {
    const p = pondJson();
    root.querySelector('[data-metrics]').innerHTML = POND_VALUES.map((m) =>
      metricCard({
        metric: m,
        value: p.latest?.[m],
        ownerStatus: p.status,
        metricStatus: p.metricStatus?.[m],
        series: day,
        missingText: 'บ่อยังส่งข้อมูล แต่ไม่มีค่านี้ — ตรวจหัววัด DO',
      }),
    ).join('');
  }

  /** The unit's shared RAS water: pH / ORP / temp (read-only here, details on the unit page). */
  function renderRas() {
    const u = unitJson();
    const el = root.querySelector('[data-ras]');
    if (!u) {
      el.hidden = true;
      return;
    }
    const r = u.ras;
    const vals = RAS_METRICS.map((m) => {
      const ms = r.status === 'offline' ? 'offline' : r.metricStatus?.[m] ?? 'offline';
      const shown = ms === 'offline' && r.status !== 'offline' ? 'warn' : ms;
      const unit = METRIC_INFO[m].unit;
      return `<span class="ras-chip ms-${shown}">${shown === 'crit' || shown === 'warn' ? STATUS_ICON[shown] : ''}${METRIC_INFO[m].label} <b class="num">${fmt(m, r.latest?.[m])}</b>${unit ? ` ${unit}` : ''}</span>`;
    }).join('');
    el.className = `card ras-panel ras-${r.status}`;
    el.innerHTML = `
      <div class="ras-panel-head">
        <b>น้ำระบบ RAS · Unit ${esc(u.code)}</b>
        <span class="status-pill s-${r.status}">${STATUS_ICON[r.status]} ${STATUS_LABEL[r.status]}</span>
        <span class="muted small">${esc(timeAgo(r.latest?.time, serverNow()))}</span>
        <span class="uh-go" aria-hidden="true">›</span>
      </div>
      <div class="ras-chips">${vals}</div>
      ${r.reasons.length ? `<div class="small" style="margin-top:6px">${esc(r.reasons.map((x) => x.text).join(', '))}</div>` : ''}`;
  }

  function renderDevices() {
    const p = pondJson();
    root.querySelector('[data-mode]').textContent = `โหมดควบคุม: ${MODE_TEXT[p.mode] ?? p.mode}`;
    const list = root.querySelector('[data-devices]');
    if (!detail.devices.length) {
      list.innerHTML = '<li class="empty">ยังไม่มีอุปกรณ์ในบ่อนี้</li>';
    } else {
      list.innerHTML = detail.devices
        .map((d) => {
          const cls = d.fault ? 'fault' : d.isOn ? 'on' : '';
          const state = d.fault ? 'ขัดข้อง' : d.isOn == null ? 'ไม่ทราบสถานะ' : d.isOn ? 'ทำงาน' : 'หยุด';
          const amp = typeof d.currentA === 'number' && d.isOn ? ` · ${d.currentA.toFixed(1)} A` : '';
          return `<li class="device">
            <span class="dot ${cls}" aria-hidden="true"></span>
            <div><div class="name">${esc(d.name)}</div>
            <div class="state">${state}${amp} · ${esc(timeAgo(d.updatedAt, serverNow()))}</div></div>
            <button type="button" class="btn" disabled>${d.isOn ? 'ปิด' : 'เปิด'}</button>
          </li>`;
        })
        .join('');
    }
    root.querySelector('[data-control-note]').textContent =
      p.mode === 'local'
        ? 'HMI อยู่โหมด Local — สั่งงานจากระบบไม่ได้ ต้องสั่งที่หน้าฟาร์ม'
        : 'สถานะมาจากสัญญาณตอบกลับจริงของ PLC · การสั่งงานจากแอปจะเปิดใช้ในเฟสควบคุมอุปกรณ์ (มีการยืนยันและบันทึกทุกคำสั่ง)';
  }

  function renderTab() {
    const body = root.querySelector('[data-tab-body]');
    const table = (head, rows) =>
      rows.length
        ? `<table class="list"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
        : '<div class="empty">ยังไม่มีข้อมูล</div>';

    if (tab === 'alarms') {
      body.innerHTML = table(
        ['เวลา', 'ระดับ', 'รายละเอียด', 'สถานะ'],
        detail.alarms.map(
          (a) => `<tr><td>${fmtDateTime(a.started_at)}</td><td><span class="status-pill s-${a.severity}">${STATUS_ICON[a.severity]} ${STATUS_LABEL[a.severity]}</span></td>
          <td>${esc(a.message)}</td><td>${a.cleared_at ? 'หายแล้ว' : a.acked_at ? 'รับทราบแล้ว' : 'ยังเปิดอยู่'}</td></tr>`,
        ),
      );
    } else if (tab === 'manual') {
      body.innerHTML = table(
        ['เวลา', 'ค่า', 'ผล', 'วิธี'],
        detail.manual.map(
          (r) => `<tr><td>${fmtDateTime(r.time)}</td><td>${esc(r.param)}</td><td class="num">${r.value} ${esc(r.unit ?? '')}</td><td>${esc(r.method)}</td></tr>`,
        ),
      );
    } else if (tab === 'lab') {
      body.innerHTML = table(
        ['วันที่เก็บ', 'Lab', 'รายการ', 'ผล'],
        detail.lab.map(
          (r) => `<tr><td>${fmtDateTime(r.sampled_at)}</td><td>${esc(r.lab_name ?? '–')}</td><td>${esc(r.param)}</td><td class="num">${esc(r.value_text ?? r.value)} ${esc(r.unit ?? '')}</td></tr>`,
        ),
      );
    } else {
      body.innerHTML = table(
        ['หัววัด', 'Calibrate ล่าสุด', 'ครบกำหนด'],
        ['do'].map((m) => {
          const c = detail.calibrations.find((x) => x.metric === m);
          const due = c?.next_due && Date.parse(c.next_due) < Date.now();
          return `<tr><td>${METRIC_INFO[m].label} (หัววัด DO ในบ่อ)</td><td>${c ? fmtDateTime(c.calibrated_at) : '<span class="muted">ไม่มีบันทึก</span>'}</td>
            <td>${c?.next_due ? `${fmtDate(c.next_due)}${due ? ' <span class="status-pill s-warn">! เลยกำหนด</span>' : ''}` : '–'}</td></tr>`;
        }),
      );
    }
  }

  function setChartData(d) {
    // Live-extended 24h window ends "now", not at the original request time.
    const to = Math.max(d.to ?? 0, d.t.at(-1) ?? 0, serverNow() / 1000);
    const from = d === day ? to - 24 * 3600 : d.from;
    for (const { metric, chart } of charts) chart.setData(d.t, d[metric], [from, to]);
  }

  let chartReq = 0;
  async function loadChart() {
    const req = ++chartReq;
    const d = range === '24h' ? day : await api.readings(pondId, range).catch(() => null);
    if (destroyed || req !== chartReq || !d) return;
    setChartData(d);
  }

  // ---------- live updates ----------

  let lastDeviceFetch = 0;
  const unsub = subscribe((type, ids) => {
    if (!detail) return;
    if (type === 'units') {
      if (detail.unit && ids.includes(detail.unit.id)) renderRas();
      return;
    }
    if (type !== 'ponds' && type !== 'reset') return;
    if (type === 'ponds' && !ids.includes(pondId)) return;
    const p = pondJson();
    const t = p.latest ? Date.parse(p.latest.time) / 1000 : null;
    if (t && t > (day.t.at(-1) ?? 0)) {
      day.t.push(t);
      for (const m of POND_VALUES) day[m].push(p.latest[m] ?? null);
      const cutoff = t - 24 * 3600;
      while (day.t.length && day.t[0] < cutoff) {
        day.t.shift();
        for (const m of POND_VALUES) day[m].shift();
      }
      if (range === '24h') setChartData(day);
    }
    renderHead();
    renderCards();
    renderRas();
    renderDevices();
    if (Date.now() - lastDeviceFetch > 15_000) {
      lastDeviceFetch = Date.now();
      api
        .pond(pondId)
        .then((d) => {
          if (destroyed) return;
          detail = d;
          renderDevices();
          if (tab !== 'calibrations') renderTab();
        })
        .catch(() => {});
    }
  });

  load();
  return () => {
    destroyed = true;
    unsub();
    for (const c of charts) c.chart.destroy();
    document.title = 'SFF Smart Shrimp';
  };
}
