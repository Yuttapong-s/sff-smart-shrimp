// Unit detail (= one RAS): RAS status, pH / ORP / temp cards and charts, test-kit water tests,
// water lab results, its ponds, calibration.

import { RAS_METRICS, METRIC_INFO, STATUS_LABEL } from '/shared/index.js';
import { api } from '../api.js';
import { store, subscribe, serverNow, counts } from '../store.js';
import { goBack } from '../router.js';
import { createChart } from '../components/ts-chart.js';
import { metricCard } from '../components/metric-card.js';
import { esc, fmtDate, fmtDateTime, fmtTile, timeAgo, STATUS_ICON } from '../format.js';
import { listOutbox, onOutboxChange } from '../outbox.js';
import { waterTable, labTable, bindDelete } from '../records-view.js';

const RANGES = [
  { key: '24h', label: '24 ชม.' },
  { key: '7d', label: '7 วัน' },
  { key: '30d', label: '30 วัน' },
];
const RAS_TEXT = { ok: 'RAS ปกติ', warn: 'RAS เตือน', crit: 'RAS วิกฤต', offline: 'RAS ขาดการติดต่อ' };

export function render(root, { params }) {
  const unitId = Number(params[0]);
  let destroyed = false;
  let detail = null;
  let day = null;
  let range = '24h';
  let charts = [];
  let outbox = [];

  root.innerHTML = `<div class="skeleton">กำลังโหลดข้อมูล Unit…</div>`;

  const unitJson = () => store.units.get(unitId) ?? detail?.unit;
  const ponds = () => {
    const live = store.order.map((id) => store.ponds.get(id)).filter((p) => p.unitId === unitId);
    return live.length ? live : detail.ponds;
  };

  async function load() {
    try {
      [detail, day] = await Promise.all([api.unit(unitId), api.unitReadings(unitId, '24h')]);
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

      <section class="metrics metrics-3" data-metrics aria-label="ค่าน้ำ RAS ล่าสุด"></section>

      <section class="card section">
        <div class="section-head">
          <h2>กราฟน้ำระบบ RAS</h2>
          <div class="seg" role="group" aria-label="ช่วงเวลา" data-ranges>
            ${RANGES.map((r) => `<button type="button" data-range="${r.key}" aria-pressed="${r.key === range}">${r.label}</button>`).join('')}
          </div>
        </div>
        <div class="charts">
          ${RAS_METRICS.map(
            (m) => `<div class="chart-block"><div class="chart-title">${METRIC_INFO[m].label} ${METRIC_INFO[m].unit ? `(${METRIC_INFO[m].unit})` : ''}</div><div class="chart-wrap" data-chart="${m}"></div></div>`,
          ).join('')}
        </div>
        <div class="note small" data-range-note></div>
      </section>

      <section class="card section" aria-label="ค่าน้ำชุดทดสอบ">
        <div class="section-head">
          <h2>ค่าน้ำชุดทดสอบ (RAS)</h2>
          <a class="btn" href="#/manual?type=water&unit=${unitId}">+ บันทึกค่าน้ำ</a>
        </div>
        <div data-water></div>
      </section>

      <section class="card section" aria-label="ผล Lab น้ำ RAS">
        <div class="section-head">
          <h2>ผล Lab น้ำ RAS</h2>
          <a class="btn" href="#/manual?type=lab&unit=${unitId}">+ บันทึกผล Lab</a>
        </div>
        <div data-lab></div>
      </section>

      <section class="card section" aria-label="บ่อใน Unit นี้">
        <div class="section-head"><h2>บ่อใน Unit นี้</h2><span class="small muted" data-pond-counts></span></div>
        <div class="grid unit-grid" data-ponds></div>
      </section>

      <section class="card section" aria-label="Calibrate หัววัด RAS">
        <div class="section-head"><h2>Calibrate หัววัด RAS</h2></div>
        <div data-calib></div>
      </section>
    `;

    root.querySelector('[data-back]').addEventListener('click', () => goBack('#/'));
    root.querySelector('[data-ranges]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-range]');
      if (!b || b.dataset.range === range) return;
      range = b.dataset.range;
      for (const x of root.querySelectorAll('[data-range]')) x.setAttribute('aria-pressed', String(x.dataset.range === range));
      renderRangeNote();
      loadChart();
    });

    charts = RAS_METRICS.map((m) => ({
      metric: m,
      chart: createChart(root.querySelector(`[data-chart="${m}"]`), { metric: m, threshold: detail.thresholds[m], syncKey: 'unit' }),
    }));

    renderHead();
    renderCards();
    renderPonds();
    renderCalib();
    renderRecords();
    bindDelete(root.querySelector('[data-water]'), reloadRecords);
    bindDelete(root.querySelector('[data-lab]'), reloadRecords);
    renderRangeNote();
    setChartData(day);
  }

  function renderRangeNote() {
    const src = range === '24h' ? 'ข้อมูลดิบ' : range === '7d' ? 'ค่าเฉลี่ยทุก 5 นาที' : 'ค่าเฉลี่ยรายชั่วโมง';
    root.querySelector('[data-range-note]').textContent = `แถบเหลือง = ช่วงเตือน · แถบแดง = ช่วงวิกฤต · ${src}`;
  }

  function renderHead() {
    const u = unitJson();
    const r = u.ras;
    root.querySelector('h1').textContent = `Unit ${u.code} · RAS`;
    const pill = root.querySelector('[data-status-pill]');
    pill.className = `status-pill s-${r.status}`;
    pill.textContent = `${STATUS_ICON[r.status]} ${RAS_TEXT[r.status]}`;
    document.title = `${u.code} · ${RAS_TEXT[r.status]} — SFF`;
    root.querySelector('[data-reasons]').innerHTML = r.reasons
      .map((x) => `<span class="status-pill s-${x.status}">${STATUS_ICON[x.status]} ${esc(x.text)}</span>`)
      .join('');
    root.querySelector('[data-meta]').innerHTML = [
      `<span>ระบบน้ำหมุนเวียน (RAS) ใช้ร่วมกัน <b class="num">${u.pondCount}</b> บ่อ</span>`,
      `<span>หัววัด pH (pH + อุณหภูมิ) และ ORP</span>`,
      `<span>อัปเดต ${esc(timeAgo(r.latest?.time, serverNow()))}</span>`,
    ].join('');
  }

  function renderCards() {
    const r = unitJson().ras;
    root.querySelector('[data-metrics]').innerHTML = RAS_METRICS.map((m) =>
      metricCard({
        metric: m,
        value: r.latest?.[m],
        ownerStatus: r.status,
        metricStatus: r.metricStatus?.[m],
        series: day,
        missingText: m === 'orp' ? 'RAS ยังส่งข้อมูล แต่ไม่มีค่า ORP — ตรวจหัววัด ORP' : 'RAS ยังส่งข้อมูล แต่ไม่มีค่านี้ — ตรวจหัววัด pH',
      }),
    ).join('');
  }

  function renderPonds() {
    const list = ponds();
    const c = counts(list.filter((p) => store.ponds.has(p.id)).map((p) => p.id));
    root.querySelector('[data-pond-counts]').textContent = ['crit', 'offline', 'warn']
      .filter((s) => c[s])
      .map((s) => `${STATUS_ICON[s]} ${STATUS_LABEL[s]} ${c[s]}`)
      .join(' · ');
    root.querySelector('[data-ponds]').innerHTML = list
      .map((p) => {
        const val = p.status === 'idle' ? 'ว่าง' : p.status === 'offline' ? 'off' : fmtTile('do', p.latest?.do);
        const reason = p.reasons?.map((x) => x.text).join(', ');
        const label = `บ่อ ${p.code} ${STATUS_LABEL[p.status]}${reason ? `: ${reason}` : ''}`;
        const flag = ['crit', 'warn', 'offline'].includes(p.status) ? `<span class="flag" aria-hidden="true">${STATUS_ICON[p.status]}</span>` : '';
        return `<a class="tile s-${p.status}" href="#/pond/${p.id}" title="${esc(label)}" aria-label="${esc(label)}">
          <span class="code">${esc(p.code.split('-').pop())}</span><span class="val">${val}</span><span class="aer small">DO</span>${flag}</a>`;
      })
      .join('');
  }

  function renderCalib() {
    const rows = [
      ['ph', 'หัววัด pH (pH + อุณหภูมิ)'],
      ['orp', 'หัววัด ORP'],
    ].map(([m, label]) => {
      const c = detail.calibrations.find((x) => x.metric === m);
      const due = c?.next_due && Date.parse(c.next_due) < Date.now();
      return `<tr><td>${label}</td><td>${c ? fmtDateTime(c.calibrated_at) : '<span class="muted">ไม่มีบันทึก</span>'}</td>
        <td>${c?.next_due ? `${fmtDate(c.next_due)}${due ? ' <span class="status-pill s-warn">! เลยกำหนด</span>' : ''}` : '–'}</td></tr>`;
    });
    root.querySelector('[data-calib]').innerHTML =
      `<table class="list"><thead><tr><th>หัววัด</th><th>Calibrate ล่าสุด</th><th>ครบกำหนด</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderRecords() {
    const mine = (types) => outbox.filter((i) => types.includes(i.type) && i.data.unitId === unitId).reverse();
    root.querySelector('[data-water]').innerHTML = waterTable(detail.records.water, mine(['water']));
    root.querySelector('[data-lab]').innerHTML = labTable(detail.records.lab, mine(['lab']));
  }

  function reloadRecords() {
    api
      .unit(unitId)
      .then((d) => {
        if (destroyed) return;
        detail = d;
        renderRecords();
        renderCalib();
      })
      .catch(() => {});
  }

  function setChartData(d) {
    const to = Math.max(d.to ?? 0, d.t.at(-1) ?? 0, serverNow() / 1000);
    const from = d === day ? to - 24 * 3600 : d.from;
    for (const { metric, chart } of charts) chart.setData(d.t, d[metric], [from, to]);
  }

  let chartReq = 0;
  async function loadChart() {
    const req = ++chartReq;
    const d = range === '24h' ? day : await api.unitReadings(unitId, range).catch(() => null);
    if (destroyed || req !== chartReq || !d) return;
    setChartData(d);
  }

  // ---------- live updates ----------

  const unsub = subscribe((type, ids) => {
    if (!detail) return;
    if (type === 'ponds') {
      if (ponds().some((p) => ids.includes(p.id))) renderPonds();
      return;
    }
    if (type === 'records') {
      if (ids.unitId === unitId && (ids.type === 'water' || ids.type === 'lab')) reloadRecords();
      return;
    }
    if (type !== 'units' && type !== 'reset') return;
    if (type === 'units' && !ids.includes(unitId)) return;
    const r = unitJson().ras;
    const t = r.latest ? Date.parse(r.latest.time) / 1000 : null;
    if (t && t > (day.t.at(-1) ?? 0)) {
      day.t.push(t);
      for (const m of RAS_METRICS) day[m].push(r.latest[m] ?? null);
      const cutoff = t - 24 * 3600;
      while (day.t.length && day.t[0] < cutoff) {
        day.t.shift();
        for (const m of RAS_METRICS) day[m].shift();
      }
      if (range === '24h') setChartData(day);
    }
    renderHead();
    renderCards();
    if (type === 'reset') renderPonds();
  });

  // Keep "updated N minutes ago" honest when the RAS stops reporting.
  const ageTimer = setInterval(() => detail && renderHead(), 30_000);

  const offOutbox = onOutboxChange((items) => {
    const sent = items.length < outbox.length;
    outbox = items;
    if (!detail) return;
    renderRecords();
    if (sent) setTimeout(reloadRecords, 300);
  });
  listOutbox()
    .then((items) => (outbox = items))
    .catch(() => {});

  load();
  return () => {
    destroyed = true;
    offOutbox();
    unsub();
    clearInterval(ageTimer);
    for (const c of charts) c.chart.destroy();
    document.title = 'SFF Smart Shrimp';
  };
}
