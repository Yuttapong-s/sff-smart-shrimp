// Farm overview: status summary, filters, and a grid of every pond grouped by zone.
// Built for hundreds of tiles: full render only when filters change; live updates patch
// individual tiles in place.

import { METRICS, METRIC_INFO, STATUS_LABEL, statusRank } from '/shared/index.js';
import { store, subscribe, counts } from '../store.js';
import { setQuery, restoreScroll } from '../router.js';
import { esc, fmtTile, STATUS_ICON } from '../format.js';

const STATUS_ORDER = ['crit', 'offline', 'warn', 'ok', 'idle'];
const VIEW_MODES = [{ key: 'all', label: 'รวม' }, ...METRICS.map((m) => ({ key: m, label: METRIC_INFO[m].label }))];

export function render(root, { query, path }) {
  const state = {
    status: query.get('s') || '',
    zone: query.get('z') || '',
    mode: VIEW_MODES.some((v) => v.key === query.get('m')) ? query.get('m') : 'all',
    q: query.get('q') || '',
    sort: query.get('sort') === 'problem' ? 'problem' : 'zone',
  };

  if (!store.farm) {
    root.innerHTML = `<div class="empty">ยังไม่มีฟาร์มในระบบ</div>`;
    return () => {};
  }

  root.innerHTML = `
    <section class="summary" aria-label="สรุปสถานะบ่อ"></section>
    <section class="toolbar" aria-label="ตัวกรอง">
      <div class="chips zones" role="group" aria-label="โซน"></div>
      <div class="seg modes" role="group" aria-label="ค่าที่แสดง"></div>
      <input class="input search" type="search" placeholder="ค้นหาบ่อ เช่น A12" aria-label="ค้นหาบ่อ" value="${esc(state.q)}">
      <select class="select sort" aria-label="เรียงลำดับ">
        <option value="zone">เรียงตามโซน</option>
        <option value="problem">ปัญหาก่อน</option>
      </select>
    </section>
    <section class="ponds" aria-live="off"></section>
    <div class="legend" aria-label="คำอธิบายสี">
      ${STATUS_ORDER.map((s) => `<span><span class="sw s-${s}"></span>${STATUS_ICON[s]} ${STATUS_LABEL[s]}</span>`).join('')}
      <span>●● เครื่องตีน้ำ (ทึบ = ทำงาน)</span>
      <span>ตัวเลขขีดเส้นใต้ = ค่านั้นผิดเกณฑ์</span>
    </div>
  `;
  const $ = (sel) => root.querySelector(sel);
  const summaryEl = $('.summary');
  const zonesEl = $('.zones');
  const modesEl = $('.modes');
  const pondsEl = $('.ponds');
  const searchEl = $('.search');
  const sortEl = $('.sort');
  sortEl.value = state.sort;

  /** @type {Map<number, HTMLElement>} */
  let tiles = new Map();
  let visible = new Set();

  const matches = (p) =>
    (!state.zone || p.zone === state.zone) &&
    (!state.status || p.status === state.status) &&
    (!state.q || p.code.toLowerCase().includes(state.q.toLowerCase()));

  function displayStatus(p) {
    if (state.mode === 'all' || p.status === 'idle' || p.status === 'offline') return p.status;
    const ms = p.metricStatus[state.mode];
    return ms === 'offline' ? 'offline' : ms;
  }

  function tileValueMetric() {
    return state.mode === 'all' ? 'do' : state.mode;
  }

  function tileHtml(p) {
    const ds = displayStatus(p);
    const m = tileValueMetric();
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
    const flag = ds === 'crit' || ds === 'warn' || ds === 'offline' ? STATUS_ICON[ds] : '';
    return {
      cls: `tile s-${ds}`,
      label,
      html: `<span class="code">${esc(p.code)}</span><span class="val ${mStatus === 'crit' || mStatus === 'warn' ? `m-${mStatus}` : ''}">${val}</span><span class="aer" aria-hidden="true">${aer}</span>${flag ? `<span class="flag" aria-hidden="true">${flag}</span>` : ''}`,
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

  function renderSummary() {
    const scope = store.order.filter((id) => !state.zone || store.ponds.get(id).zone === state.zone);
    const c = counts(scope);
    summaryEl.innerHTML = STATUS_ORDER.map(
      (s) => `<button type="button" class="sum s-${s}${c[s] ? '' : ' zero'}" data-status="${s}" aria-pressed="${state.status === s}">
        <span class="n num">${c[s]}</span><span class="l">${STATUS_ICON[s]} ${STATUS_LABEL[s]}</span></button>`,
    ).join('');
  }

  function renderZones() {
    const all = [{ code: '', name: `ทั้งหมด (${store.order.length})` }, ...store.zones];
    zonesEl.innerHTML = all
      .map((z) => {
        const crit = z.code ? zoneCounts(z.code).crit : 0;
        return `<button type="button" class="chip" data-zone="${esc(z.code)}" aria-pressed="${state.zone === z.code}">${esc(z.code ? z.code : z.name)}${crit ? ` <span class="badge">${crit}</span>` : ''}</button>`;
      })
      .join('');
  }

  function zoneCounts(zone) {
    return counts(store.order.filter((id) => store.ponds.get(id).zone === zone));
  }

  function renderModes() {
    modesEl.innerHTML = VIEW_MODES.map(
      (v) => `<button type="button" data-mode="${v.key}" aria-pressed="${state.mode === v.key}">${esc(v.label)}</button>`,
    ).join('');
  }

  function renderGrid() {
    tiles = new Map();
    visible = new Set();
    pondsEl.replaceChildren();
    const list = store.order.map((id) => store.ponds.get(id)).filter(matches);
    for (const p of list) visible.add(p.id);

    if (!list.length) {
      pondsEl.innerHTML = `<div class="empty">ไม่พบบ่อตามตัวกรอง</div>`;
      return;
    }

    if (state.sort === 'problem') {
      list.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.code.localeCompare(b.code));
      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.append(...list.map(makeTile));
      pondsEl.append(grid);
      return;
    }

    const byZone = new Map();
    for (const p of list) {
      if (!byZone.has(p.zone)) byZone.set(p.zone, []);
      byZone.get(p.zone).push(p);
    }
    const frag = document.createDocumentFragment();
    for (const z of store.zones) {
      const ps = byZone.get(z.code);
      if (!ps) continue;
      const sec = document.createElement('section');
      sec.className = 'zone';
      sec.dataset.zone = z.code;
      sec.innerHTML = `<div class="zone-head"><h2>${esc(z.name)}</h2><span class="counts"></span></div>`;
      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.append(...ps.map(makeTile));
      sec.append(grid);
      frag.append(sec);
    }
    pondsEl.append(frag);
    renderZoneHeads();
  }

  function renderZoneHeads() {
    for (const sec of pondsEl.querySelectorAll('.zone')) {
      const c = zoneCounts(sec.dataset.zone);
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      const parts = [`${total} บ่อ`];
      for (const s of ['crit', 'offline', 'warn']) if (c[s]) parts.push(`${STATUS_ICON[s]} ${STATUS_LABEL[s]} ${c[s]}`);
      sec.querySelector('.counts').textContent = parts.join(' · ');
    }
  }

  function renderAll() {
    renderSummary();
    renderZones();
    renderModes();
    renderGrid();
  }

  function persist() {
    setQuery({
      s: state.status,
      z: state.zone,
      m: state.mode === 'all' ? '' : state.mode,
      q: state.q,
      sort: state.sort === 'zone' ? '' : state.sort,
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
  zonesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-zone]');
    if (!b) return;
    state.zone = b.dataset.zone;
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
    const q = searchEl.value.trim().toLowerCase();
    const hits = store.order.map((id) => store.ponds.get(id)).filter((p) => p.code.toLowerCase().includes(q));
    const exact = hits.find((p) => p.code.toLowerCase() === q);
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
  const unsub = subscribe((type, ids) => {
    if (type === 'reset') return renderAll();
    if (type !== 'ponds') return;
    let needFull = false;
    for (const id of ids) {
      const p = store.ponds.get(id);
      const shouldShow = matches(p);
      if (shouldShow !== visible.has(id)) needFull = true;
      const el = tiles.get(id);
      if (el) paintTile(el, p);
    }
    // In "problem first" order a status change also changes position.
    if (state.sort === 'problem') needFull = true;
    renderSummary();
    renderZones();
    if (state.sort === 'zone') renderZoneHeads();
    if (needFull && !fullRenderPending) {
      fullRenderPending = true;
      // Debounce so tiles don't jump around on every message.
      setTimeout(() => {
        fullRenderPending = false;
        const y = window.scrollY;
        renderGrid();
        window.scrollTo(0, y);
      }, 3000);
    }
  });

  renderAll();
  restoreScroll(path);
  return () => {
    unsub();
    clearTimeout(searchTimer);
  };
}
