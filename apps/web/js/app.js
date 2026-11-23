// App shell: auth gate, hash router, theme, connection indicator, service worker.
//   #/              farm overview
//   #/pond/:id      pond detail
//   #/unit/:id      unit (RAS) detail
//   #/alarms        alarm list
//   #/manual        manual records (water test, feeding, growth, lab, crop cycle) + outbox

import { api, HttpError } from './api.js';
import { setOutboxUser, onOutboxChange, listOutbox } from './outbox.js';
import { store, subscribe, loadFarm, stopFarm } from './store.js';
import { timeAgo } from './format.js';
import { parseHash, saveScroll } from './router.js';
import * as overview from './pages/overview.js';
import * as pond from './pages/pond.js';
import * as unit from './pages/unit.js';
import * as alarms from './pages/alarms.js';
import * as manual from './pages/manual.js';
import * as login from './pages/login.js';

const view = document.getElementById('view');
const routes = [
  { re: /^\/$/, page: overview, nav: 'overview' },
  { re: /^\/pond\/(\d+)$/, page: pond, nav: 'overview' },
  { re: /^\/unit\/(\d+)$/, page: unit, nav: 'overview' },
  { re: /^\/alarms$/, page: alarms, nav: 'alarms' },
  { re: /^\/manual$/, page: manual, nav: 'manual' },
];

let cleanup = null;
let user = null;
let currentPath = null;
let navDepth = 0; // in-app navigations, so "back" knows whether history.back() stays in the app

function route() {
  const { path, query } = parseHash();
  saveScroll(currentPath);
  cleanup?.();
  cleanup = null;

  if (!user) {
    currentPath = null;
    setNav(null);
    cleanup = login.render(view, { onLogin: start });
    return;
  }

  const r = routes.find((x) => x.re.test(path)) ?? routes[0];
  const params = path.match(r.re)?.slice(1) ?? [];
  currentPath = path;
  setNav(r.nav);
  window.scrollTo(0, 0);
  cleanup = r.page.render(view, { params, query, path });
  view.focus({ preventScroll: true });
}

function setNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.querySelector('.bottomnav').hidden = !name;
  document.getElementById('logout').hidden = !user;
}

// ---------- header widgets ----------

const connEl = document.getElementById('conn');
const banner = document.getElementById('banner');
const CONN_TEXT = { live: 'สด', connecting: 'กำลังเชื่อมต่อ', offline: 'ออฟไลน์' };

// Outbox badge: records saved on this phone that the server has not confirmed yet.
const outboxEl = document.getElementById('outbox-badge');
onOutboxChange((items, { syncing }) => {
  const rejected = items.filter((i) => i.state === 'rejected').length;
  const pending = items.length - rejected;
  outboxEl.hidden = !items.length || !user;
  outboxEl.dataset.level = rejected ? 'crit' : 'warn';
  outboxEl.textContent = rejected ? `✕ ส่งไม่สำเร็จ ${rejected}` : `${syncing ? '↻' : '⏳'} รอส่ง ${pending}`;
  outboxEl.title = rejected ? 'มีรายการที่เซิร์ฟเวอร์ไม่รับ — แตะเพื่อดู' : 'บันทึกไว้ในเครื่องแล้ว จะส่งอัตโนมัติเมื่อมีสัญญาณ';
});

function renderHeader() {
  const online = navigator.onLine;
  const state = online ? store.conn : 'offline';
  connEl.dataset.state = state;
  connEl.textContent = CONN_TEXT[state];

  if (store.farm) document.getElementById('farm-name').textContent = store.farm.name;
  for (const b of document.querySelectorAll('[data-alarm-count]')) {
    b.textContent = store.openAlarms;
    b.hidden = !store.openAlarms;
  }

  // Gateway down is a farm-wide emergency: every pond's data is stale.
  if (!online) {
    showBanner('warn', 'ไม่มีอินเทอร์เน็ต — แสดงข้อมูลล่าสุดที่บันทึกไว้');
  } else if (store.farm && store.farm.gatewayOnline === false) {
    showBanner('crit', `Gateway ฟาร์มขาดการเชื่อมต่อ (${timeAgo(store.farm.gatewaySeenAt)}) — ข้อมูลไม่อัปเดต`);
  } else {
    banner.hidden = true;
  }
}

function showBanner(level, text) {
  banner.dataset.level = level;
  banner.textContent = text;
  banner.hidden = false;
}

subscribe((type) => {
  if (type === 'conn' || type === 'farm' || type === 'reset') renderHeader();
});
window.addEventListener('online', renderHeader);
window.addEventListener('offline', renderHeader);

// ---------- theme ----------

const THEME_KEY = 'sff-theme';
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {}
document.getElementById('theme-toggle').addEventListener('click', () => {
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
  window.dispatchEvent(new CustomEvent('theme-change'));
});

// ---------- auth ----------

const USER_KEY = 'sff-user';
const cacheUser = (u) => {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch {}
};

function setUser(u) {
  user = u;
  store.user = u;
  cacheUser(u);
  setOutboxUser(u);
}

document.getElementById('logout').addEventListener('click', async () => {
  const waiting = (await listOutbox().catch(() => [])).filter((i) => i.userId === user?.id && i.state === 'pending').length;
  if (
    waiting &&
    !confirm(`มีรายการรอส่ง ${waiting} รายการ
ออกจากระบบแล้วรายการจะยังอยู่ในเครื่อง และจะส่งเมื่อคุณเข้าสู่ระบบอีกครั้ง

ออกจากระบบต่อไหม?`)
  ) {
    return;
  }
  await api.logout().catch(() => {});
  stopFarm();
  setUser(null);
  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sff-api')).map((k) => caches.delete(k))))
      .catch(() => {});
  }
  location.hash = '#/';
  route();
});

window.addEventListener('auth-required', () => {
  if (!user) return;
  setUser(null);
  stopFarm();
  route();
});

async function start() {
  let u = null;
  try {
    u = await api.me();
  } catch (err) {
    // No signal at the ponds: keep working as the last user (the session cookie is still
    // checked by the server when the outbox syncs).
    if (!(err instanceof HttpError)) {
      try {
        u = JSON.parse(localStorage.getItem(USER_KEY));
      } catch {}
    }
  }
  setUser(u);
  if (user) {
    try {
      const farms = await api.farms();
      if (farms.length) await loadFarm(farms[0].id);
    } catch (err) {
      console.warn('farm load failed', err);
    }
  }
  renderHeader();
  currentPath = null;
  route();
}

window.addEventListener('hashchange', () => {
  sessionStorage.setItem('sff-nav-depth', String(++navDepth));
  route();
});
window.addEventListener('pagehide', () => saveScroll(currentPath));
sessionStorage.setItem('sff-nav-depth', '0');
history.scrollRestoration = 'manual';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
}

start();
