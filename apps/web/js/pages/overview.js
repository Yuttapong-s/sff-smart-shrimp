// Farm overview: status summary, filters, and one card per unit (= one RAS).
// Card header = RAS pH / ORP / temp with its own status; body = that unit's pond tiles.
// Full render only when filters change; live updates patch tiles / headers in place.

import { METRIC_INFO, RAS_METRICS, STATUS_LABEL, statusRank, worstStatus, normalizePondQuery } from '/shared/index.js';
import { store, subscribe, counts, rasProblem, serverNow } from '../store.js';
import { setQuery, restoreScroll } from '../router.js';
import { esc, fmt, fmtTile, timeAgo, STATUS_ICON } from '../format.js';

const STATUS_ORDER = ['crit', 'offline', 'warn', 'ok', 'idle'];
const VIEW_MODES = [
  { key: 'do', label: 'DO' },
  { key: 'temp', label: 'อุณหภูมิ' },
];
const RAS_LABEL = { ok: 'RAS ปกติ', warn: 'RAS เตือน', crit: 'RAS วิกฤต', offline: 'RAS ขาดการติดต่อ' };

const shortCode = (code) => code.split('-').pop(); // U01-P03 -> P03

export function render(root, { query, path }) {
  const state = {
    status: query.get('s') || '', // pond status, or 'ras' = units whose RAS is abnormal
    unit: query.get('u') || '',
    mode: VIEW_MODES.some((v) => v.key === query.get('m')) ? query.get('m') : 'do',
    q: query.get('q') || '',
    sort: query.get('sort') === 'problem' ? 'problem' : 'unit',
  };

  if (!store.farm) {
    root.innerHTML = `<div class="empty">ยังไม่มีฟาร์มในระบบ</div>`;
    return () => {};
  }

  root.innerHTML = `
    <section class="summary" aria-label="สรุปสถานะ"></section>
    <section class="toolbar" aria-label="ตัวกรอง">
      <div class="chips units-filter" role="group" aria-label="Unit"></div>
      <div class="seg modes" role="group" aria-label="ค่าที่แสดงบนบ่อ"></div>
      <input class="input search" type="search" placeholder="ค้นหาบ่อ เช่น 3-2" aria-label="ค้นหาบ่อ" value="${esc(state.q)}">
      <select class="select sort" aria-label="เรียงลำดับ">
        <option value="unit">เรียงตาม Unit</option>
        <option value="problem">ปัญหาก่อน</option>
      </select>
    </section>
    <section class="units" aria-live="off"></section>
    <div class="legend" aria-label="คำอธิบายสี">
      ${STATUS_ORDER.map((s) => `<span><span class="sw s-${s}"></span>${STATUS_ICON[s]} ${STATUS_LABEL[s]}</span>`).join('')}
      <span>●● เครื่องตีน้ำ (ทึบ = ทำงาน)</span>
      <span>ตัวเลขขีดเส้นใต้ = ค่านั้นผิดเกณฑ์</span>
      <span>หัวการ์ด = ค่าน้ำของระบบ RAS (pH / ORP / อุณหภูมิ)</span>
    </div>
  `;
  const $ = (sel) => root.querySelector(sel);
  const summaryEl = $('.summary');
  const unitsFilterEl = $('.units-filter');
  const modesEl = $('.modes');
  const unitsEl = $('.units');
  const searchEl = $('.search');
  const sortEl = $('.sort');
  sortEl.value = state.sort;

  /** @type {Map<number, HTMLElement>} pond id -> tile */
  let tiles = new Map();
  /** @type {Map<number, HTMLElement>} unit id -> card */
  let cards = new Map();
  let visible = new Set();

  const pondsOfUnit = (u) => store.order.map((id) => store.ponds.get(id)).filter((p) => p.unitId === u.id);

  function searchMatch(p) {
    if (!state.q) return true;
    const n = normalizePondQuery(state.q);
    if (n.pond) return p.code === n.pond;
    if (n.unit) return p.unit === n.unit;
    return p.code.toUpperCase().includes(n.text ?? '');
  }

  function matches(p) {
    if (state.unit && p.unit !== state.unit) return false;
    if (state.status === 'ras') {
      if (!rasProblem(store.units.get(p.unitId))) return false;
    } else if (state.status && p.status !== state.status) return false;
    return searchMatch(p);
  }

  const filtering = () => !!(state.status || state.q);

  /** Worst of the RAS and every pond: used for "problem first" ordering. */
  function unitRank(u) {
    let s = u.ras.status;
    for (const p of pondsOfUnit(u)) s = worstStatus(s, p.status);
    return statusRank(s);
  }

  // ---------- tiles ----------

  function tileHtml(p) {
    const m = state.mode;
    const mStatus = p.metricStatus?.[m];
    let val;
    if (p.status === 'idle') val = 'ว่าง';
    else if (p.status === 'offline') val = 'off';
    else val = fmtTile(m, p.latest?.[m]);

    const a = p.aerators;
    let aer = '';
    if (a.total > 0 && a.total <= 4) {
      for (let i = 0; i < a.total; i++) {
        const cls = i < a.fault ? 'fault' : i < a.fault + a.on ? 'on' : 'off';
        aer += `<span class="${cls}">●</span>`;
      }
    } else if (a.total > 4) {
      aer = `${a.on}/${a.total}`;
    }
    const reason = p.reasons?.map((r) => r.text).join(', ');
    const label = `บ่อ ${p.code} ${STATUS_LABEL[p.status]}${reason ? `: ${reason}` : ''}`;
    const ds = p.status;
    const flag = ds === 'crit' || ds === 'warn' || ds === 'offline' ? STATUS_ICON[ds] : '';
    return {
      cls: `tile s-${ds}`,
      label,
      html: `<span class="code">${esc(shortCode(p.code))}</span><span class="val ${mStatus === 'crit' || mStatus === 'warn' ? `m-${mStatus}` : ''}">${val}</span><span class="aer" aria-hidden="true">${aer}</span>${flag ? `<span class="flag" aria-hidden="true">${flag}</span>` : ''}`,
    };
  }

  function makeTile(p) {
    const el = document.createElement('a');
    el.href = `#/pond/${p.id}`;
    el.id = `t-${p.id}`;
    paintTile(el, p);
    tiles.set(p.id, el);
    return el;
  }

  function paintTile(el, p) {
    const t = tileHtml(p);
    el.className = t.cls;
    el.title = t.label;
    el.setAttribute('aria-label', t.label);
    el.innerHTML = t.html;
  }

  // ---------- unit card header (RAS) ----------

  function rasChips(u) {
    const r = u.ras;
    return RAS_METRICS.map((m) => {
      const ms = r.status === 'offline' ? 'offline' : r.metricStatus?.[m] ?? 'offline';
      const shown = ms === 'offline' && r.status !== 'offline' ? 'warn' : ms; // missing value on live RAS = warn
      const icon = shown === 'crit' || shown === 'warn' ? `<span aria-hidden="true">${STATUS_ICON[shown]}</span>` : '';
      const label = m === 'temp' ? '' : `${METRIC_INFO[m].label} `;
      const unit = m === 'orp' ? ' mV' : m === 'temp' ? '°C' : '';
      return `<span class="ras-chip ms-${shown}" title="${esc(`${METRIC_INFO[m].label} ${STATUS_LABEL[shown]}`)}">${icon}${label}<b class="num">${fmt(m, r.latest?.[m])}</b>${unit}</span>`;
    }).join('');
  }

  function headHtml(u) {
    const r = u.ras;
    const c = counts(pondsOfUnit(u).map((p) => p.id));
    const pondBadges = ['crit', 'offline', 'warn']
      .filter((s) => c[s])
      .map((s) => `<span class="mini s-${s}" title="บ่อ${STATUS_LABEL[s]} ${c[s]}">${STATUS_ICON[s]}${c[s]}</span>`)
      .join('');
    let rasState = '';
    if (r.status !== 'ok') {
      const why = r.status === 'offline' ? timeAgo(r.latest?.time, serverNow()) : r.reasons.map((x) => x.text).join(', ');
      rasState = `<div class="ras-state">${STATUS_ICON[r.status]} ${RAS_LABEL[r.status]}${why ? ` · ${esc(why)}` : ''}</div>`;
    }
    return `
      <div class="uh-top">
        <h2>${esc(u.code)}</h2>
        <span class="muted small">${u.pondCount} บ่อ</span>
        <span class="uh-badges">${pondBadges}</span>
        <span class="uh-go" aria-hidden="true">›</span>
      </div>
      <div class="ras-chips" aria-label="ค่าน้ำ RAS">${rasChips(u)}</div>
      ${rasState}`;
  }

  function paintHead(card, u) {
    const head = card.querySelector('.unit-head');
    card.className = `unit-card ras-${u.ras.status}`;
    head.innerHTML = headHtml(u);
    head.setAttribute('aria-label', `${u.code} ${RAS_LABEL[u.ras.status]} ดูรายละเอียด RAS`);
  }

  // ---------- top bar ----------

  function renderSummary() {
    const scope = store.order.filter((id) => !state.unit || store.ponds.get(id).unit === state.unit);
    const c = counts(scope);
    const unitScope = store.unitOrder.map((id) => store.units.get(id)).filter((u) => !state.unit || u.code === state.unit);
    const rasBad = unitScope.filter(rasProblem);
    const rasCrit = rasBad.some((u) => u.ras.status === 'crit');
    const rasCls = !rasBad.length ? 'zero' : rasCrit ? 's-crit' : rasBad.some((u) => u.ras.status === 'offline') ? 's-offline' : 's-warn';
    summaryEl.innerHTML =
      STATUS_ORDER.map(
        (s) => `<button type="button" class="sum s-${s}${c[s] ? '' : ' zero'}" data-status="${s}" aria-pressed="${state.status === s}" aria-label="บ่อ${STATUS_LABEL[s]} ${c[s]}">
        <span class="n num">${c[s]}</span><span class="l">${STATUS_ICON[s]} ${STATUS_LABEL[s]}</span></button>`,
      ).join('') +
      `<button type="button" class="sum sum-ras ${rasCls}" data-status="ras" aria-pressed="${state.status === 'ras'}" aria-label="RAS ผิดปกติ ${rasBad.length} unit">
        <span class="n num">${rasBad.length}</span><span class="l">${rasBad.length ? STATUS_ICON[rasCrit ? 'crit' : 'warn'] : '✓'} RAS ผิดปกติ</span></button>`;
  }

  function renderUnitFilter() {
    const all = [{ code: '', label: `ทั้งหมด (${store.unitOrder.length})` }, ...store.unitOrder.map((id) => store.units.get(id))];
    unitsFilterEl.innerHTML = all
      .map((u) => {
        let badge = '';
        if (u.code) {
          const crit = counts(pondsOfUnit(u).map((p) => p.id)).crit + (u.ras.status === 'crit' ? 1 : 0);
          if (crit) badge = ` <span class="badge">${crit}</span>`;
          else if (rasProblem(u)) badge = ` <span class="dot-warn" aria-label="RAS ผิดปกติ">!</span>`;
        }
        return `<button type="button" class="chip" data-unit="${esc(u.code)}" aria-pressed="${state.unit === u.code}">${esc(u.code || u.label)}${badge}</button>`;
      })
      .join('');
  }

  function renderModes() {
    modesEl.innerHTML = VIEW_MODES.map(
      (v) => `<button type="button" data-mode="${v.key}" aria-pressed="${state.mode === v.key}">${esc(v.label)}</button>`,
    ).join('');
  }

  // ---------- cards ----------

  function renderGrid() {
    tiles = new Map();
    cards = new Map();
    visible = new Set();
    unitsEl.replaceChildren();

    let list = store.unitOrder
      .map((id) => store.units.get(id))
      .filter((u) => !state.unit || u.code === state.unit)
      .map((u) => ({ u, ponds: pondsOfUnit(u).filter(matches) }))
      // With a status / search filter, only show units that still have something to show.
      .filter(({ u, ponds }) => ponds.length || (!filtering() || (state.status === 'ras' && rasProblem(u) && !state.q)));

    if (!list.length) {
      unitsEl.innerHTML = `<div class="empty">ไม่พบบ่อตามตัวกรอง</div>`;
      return;
    }

    if (state.sort === 'problem') {
      const rank = new Map(list.map(({ u }) => [u.id, unitRank(u)]));
      list = list.sort((a, b) => rank.get(b.u.id) - rank.get(a.u.id) || a.u.code.localeCompare(b.u.code));
      for (const x of list) {
        x.ponds.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.code.localeCompare(b.code));
      }
    }

    const frag = document.createDocumentFragment();
    for (const { u, ponds } of list) {
      const card = document.createElement('section');
      card.dataset.unitId = u.id;
      card.innerHTML = `<a class="unit-head" href="#/unit/${u.id}"></a><div class="grid unit-grid"></div>`;
      paintHead(card, u);
      const grid = card.querySelector('.unit-grid');
      if (ponds.length) {
        grid.append(...ponds.map(makeTile));
        for (const p of ponds) visible.add(p.id);
      } else {
        grid.innerHTML = `<div class="muted small">ไม่มีบ่อตามตัวกรอง</div>`;
      }
      cards.set(u.id, card);
      frag.append(card);
    }
    unitsEl.append(frag);
  }

  function renderAll() {
    renderSummary();
    renderUnitFilter();
    renderModes();
    renderGrid();
  }

  function persist() {
    setQuery({
      s: state.status,
      u: state.unit,
      m: state.mode === 'do' ? '' : state.mode,
      q: state.q,
      sort: state.sort === 'unit' ? '' : state.sort,
    });
  }

  // ---------- events ----------

  summaryEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.status = state.status === b.dataset.status ? '' : b.dataset.status;
    persist();
    renderSummary();
    renderGrid();
  });
  unitsFilterEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (!b) return;
    state.unit = b.dataset.unit;
    persist();
    renderAll();
  });
  modesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    persist();
    renderModes();
    for (const [id, el] of tiles) paintTile(el, store.ponds.get(id));
  });
  let searchTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchEl.value.trim();
      persist();
      renderGrid();
    }, 150);
  });
  searchEl.addEventListener('keydown', (e) => {
    // Enter on an exact or single match jumps straight to that pond.
    if (e.key !== 'Enter') return;
    state.q = searchEl.value.trim();
    const hits = store.order.map((id) => store.ponds.get(id)).filter(searchMatch);
    const n = normalizePondQuery(state.q);
    const exact = n.pond && hits.find((p) => p.code === n.pond);
    const target = exact ?? (hits.length === 1 ? hits[0] : null);
    if (target) location.hash = `#/pond/${target.id}`;
  });
  sortEl.addEventListener('change', () => {
    state.sort = sortEl.value;
    persist();
    renderGrid();
  });

  // ---------- live updates ----------

  let fullRenderPending = false;
  function scheduleFull() {
    if (fullRenderPending) return;
    fullRenderPending = true;
    // Debounce so cards don't jump around on every message.
    setTimeout(() => {
      fullRenderPending = false;
      const y = window.scrollY;
      renderGrid();
      window.scrollTo(0, y);
    }, 3000);
  }

  const unsub = subscribe((type, ids) => {
    if (type === 'reset') return renderAll();
    if (type === 'ponds') {
      const touched = new Set();
      let needFull = state.sort === 'problem'; // a status change also changes position
      for (const id of ids) {
        const p = store.ponds.get(id);
        if (matches(p) !== visible.has(id)) needFull = true;
        const el = tiles.get(id);
        if (el) paintTile(el, p);
        touched.add(p.unitId);
      }
      for (const uid of touched) {
        const card = cards.get(uid);
        if (card) paintHead(card, store.units.get(uid));
      }
      renderSummary();
      renderUnitFilter();
      if (needFull) scheduleFull();
    } else if (type === 'units') {
      for (const id of ids) {
        const card = cards.get(id);
        if (card) paintHead(card, store.units.get(id));
      }
      renderSummary();
      renderUnitFilter();
      if (state.sort === 'problem' || state.status === 'ras') scheduleFull();
    }
  });

  // Keep "RAS offline · N นาที" ages current.
  const ageTimer = setInterval(() => {
    for (const [id, card] of cards) {
      const u = store.units.get(id);
      if (u.ras.status === 'offline') paintHead(card, u);
    }
  }, 60_000);

  renderAll();
  restoreScroll(path);
  return () => {
    unsub();
    clearTimeout(searchTimer);
    clearInterval(ageTimer);
  };
}
