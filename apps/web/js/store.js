// Farm state shared by all pages: one overview load, then live SSE patches.
// Status is re-evaluated locally every 30 s so ponds / RAS that stop reporting turn
// "offline" even when no new event arrives.

import { evaluatePond, evaluateRas, DEFAULT_THRESHOLDS } from '/shared/index.js';
import { api, openStream } from './api.js';

const listeners = new Set();

export const store = {
  farm: null,
  thresholds: DEFAULT_THRESHOLDS,
  openAlarms: 0,
  units: new Map(), // id -> unit json (with .ras)
  unitOrder: [], // unit ids in sort order
  ponds: new Map(), // id -> pond json
  order: [], // pond ids in unit/sort order
  conn: 'connecting',
  serverOffsetMs: 0, // serverTime - clientTime
  loadedAt: 0,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, detail) {
  for (const fn of listeners) fn(type, detail);
}

export const serverNow = () => Date.now() + store.serverOffsetMs;

function syncClock(serverTime) {
  if (serverTime) store.serverOffsetMs = Date.parse(serverTime) - Date.now();
}

function reevaluate(p) {
  const ev = evaluatePond({ latest: p.latest, active: !!p.cycle, now: serverNow(), thresholds: store.thresholds });
  const changed = ev.status !== p.status;
  p.status = ev.status;
  p.metricStatus = ev.metrics;
  p.reasons = ev.reasons;
  return changed;
}

function reevaluateRas(u) {
  const ev = evaluateRas({ latest: u.ras.latest, now: serverNow(), thresholds: store.thresholds });
  const changed = ev.status !== u.ras.status;
  Object.assign(u.ras, { status: ev.status, metricStatus: ev.metrics, reasons: ev.reasons });
  return changed;
}

export const unitByCode = (code) => [...store.units.values()].find((u) => u.code === code);

/** RAS is abnormal: warn / crit / offline. */
export const rasProblem = (u) => ['warn', 'crit', 'offline'].includes(u.ras.status);

let closeStream = null;
let staleTimer = null;

export async function loadFarm(farmId) {
  const o = await api.overview(farmId);
  syncClock(o.serverTime);
  store.farm = o.farm;
  store.units = new Map(o.units.map((u) => [u.id, u]));
  store.unitOrder = o.units.map((u) => u.id);
  store.thresholds = o.thresholds;
  store.openAlarms = o.openAlarms;
  store.ponds = new Map(o.ponds.map((p) => [p.id, p]));
  store.order = o.ponds.map((p) => p.id);
  store.loadedAt = Date.now();
  emit('reset');

  closeStream?.();
  closeStream = openStream(farmId, {
    onState: (s) => {
      store.conn = s;
      emit('conn', s);
    },
    onHello: (d) => syncClock(d.serverTime),
    onPonds: ({ serverTime, ponds }) => {
      syncClock(serverTime);
      const ids = [];
      for (const p of ponds) {
        if (!store.ponds.has(p.id)) continue;
        store.ponds.set(p.id, p);
        ids.push(p.id);
      }
      if (ids.length) emit('ponds', ids);
    },
    onUnits: ({ serverTime, units }) => {
      syncClock(serverTime);
      const ids = [];
      for (const u of units) {
        if (!store.units.has(u.id)) continue;
        store.units.set(u.id, u);
        ids.push(u.id);
      }
      if (ids.length) emit('units', ids);
    },
    onFarm: (f) => {
      Object.assign(store.farm, f);
      emit('farm');
    },
  });

  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    const ids = [];
    for (const p of store.ponds.values()) if (reevaluate(p)) ids.push(p.id);
    if (ids.length) emit('ponds', ids);
    const uids = [];
    for (const u of store.units.values()) if (reevaluateRas(u)) uids.push(u.id);
    if (uids.length) emit('units', uids);
  }, 30_000);
}

/** Reload after the stream was down for a while (e.g. phone woke up) to catch up fully. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.farm && Date.now() - store.loadedAt > 5 * 60_000) {
    loadFarm(store.farm.id).catch(() => {});
  }
});

export function stopFarm() {
  closeStream?.();
  closeStream = null;
  clearInterval(staleTimer);
}

export function counts(ids = store.order) {
  const c = { crit: 0, offline: 0, warn: 0, ok: 0, idle: 0 };
  for (const id of ids) c[store.ponds.get(id).status]++;
  return c;
}
