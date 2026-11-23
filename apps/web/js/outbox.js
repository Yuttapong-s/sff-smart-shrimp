// Offline outbox: every manual record is saved to IndexedDB first, then sent to POST /api/records.
// Items survive app restarts and lost signal at the ponds; each has a clientId (UUID) so a
// re-send after a timeout never creates a duplicate on the server.
//
// Item: {clientId, type, data, userId, userName, createdAt, state: 'pending'|'rejected', errors, attempts}
// Items are only sent while their author is logged in, so recorded_by is always the real author.

import { request, HttpError } from './api.js';

const DB_NAME = 'sff-outbox';
const STORE = 'items';
const BATCH = 50;

let dbPromise = null;
let memory = null; // fallback when IndexedDB is unavailable (some private modes)
let user = null;
let syncing = null;
let retryTimer = null;
let backoffMs = 0;
let lastError = null;
const listeners = new Set();

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      console.warn('IndexedDB unavailable, outbox kept in memory only', err);
      memory = new Map();
      return null;
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

async function putItem(item) {
  await tx('readwrite', (s) => (s ? reqP(s.put(item)) : memory.set(item.clientId, item)));
}

async function deleteItem(clientId) {
  await tx('readwrite', (s) => (s ? reqP(s.delete(clientId)) : memory.delete(clientId)));
}

/** All items on this device, oldest first. */
export async function listOutbox() {
  const all = await tx('readonly', (s) => (s ? reqP(s.getAll()) : [...memory.values()]));
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function onOutboxChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function changed() {
  const items = await listOutbox().catch(() => []);
  for (const fn of listeners) fn(items, { syncing: !!syncing, lastError });
}

export function newClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Save a validated record locally, then try to send it. Returns the stored item. */
export async function enqueue(type, data) {
  if (!user) throw new Error('not logged in');
  const item = {
    clientId: newClientId(),
    type,
    data,
    userId: user.id,
    userName: user.name,
    createdAt: new Date().toISOString(),
    state: 'pending',
    errors: null,
    attempts: 0,
  };
  await putItem(item);
  await changed();
  syncNow();
  return item;
}

/** Discard an item (used for rejected items the user has read). */
export async function discard(clientId) {
  await deleteItem(clientId);
  await changed();
}

/** Send pending items of the logged-in user. Single-flight; safe to call any time. */
export function syncNow() {
  if (!syncing) {
    clearTimeout(retryTimer);
    syncing = runSync().finally(() => {
      syncing = null;
      changed();
    });
    changed();
  }
  return syncing;
}

async function runSync() {
  if (!user || !navigator.onLine) return;
  const mine = (await listOutbox()).filter((i) => i.state === 'pending' && i.userId === user.id);
  for (let i = 0; i < mine.length; i += BATCH) {
    const batch = mine.slice(i, i + BATCH);
    let res;
    try {
      res = await request('/records', {
        method: 'POST',
        body: { items: batch.map(({ type, clientId, data }) => ({ type, clientId, data })) },
      });
    } catch (err) {
      lastError = err instanceof HttpError ? `เซิร์ฟเวอร์ตอบ ${err.status}` : 'ส่งไม่ได้ (เครือข่าย)';
      for (const it of batch) await putItem({ ...it, attempts: it.attempts + 1 });
      if (err instanceof HttpError && err.status === 401) return; // wait for login
      scheduleRetry();
      return;
    }
    lastError = null;
    backoffMs = 0;
    const byId = new Map(res.results.map((r) => [r.clientId, r]));
    const accepted = [];
    for (const it of batch) {
      const r = byId.get(it.clientId);
      if (!r) continue;
      if (r.status === 'ok' || r.status === 'duplicate') {
        await deleteItem(it.clientId);
        accepted.push(it.clientId);
      } else {
        await putItem({ ...it, state: 'rejected', errors: r.errors ?? ['ถูกปฏิเสธ'], attempts: it.attempts + 1 });
      }
    }
    if (accepted.length) window.dispatchEvent(new CustomEvent('outbox-sent', { detail: accepted }));
  }
}

function scheduleRetry() {
  backoffMs = Math.min(backoffMs ? backoffMs * 2 : 10_000, 5 * 60_000);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(syncNow, backoffMs);
}

let started = false;
/** Called after login (and with null on logout). */
export function setOutboxUser(u) {
  user = u;
  if (!started) {
    started = true;
    window.addEventListener('online', () => {
      backoffMs = 0;
      syncNow();
    });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
    setInterval(() => navigator.onLine && syncNow(), 60_000);
  }
  if (u) syncNow();
  else changed();
}

export const outboxUser = () => user;
