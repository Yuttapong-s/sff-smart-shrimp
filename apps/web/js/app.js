// App shell: auth gate, hash router, theme, connection indicator, service worker.
//   #/              farm overview
//   #/pond/:id      pond detail
//   #/alarms        alarm list
//   #/manual        manual water-test entry

import { api } from './api.js';
import { store, subscribe, loadFarm, stopFarm } from './store.js';
import { timeAgo } from './format.js';
import { parseHash, saveScroll } from './router.js';
import * as overview from './pages/overview.js';
import * as pond from './pages/pond.js';
import * as alarms from './pages/alarms.js';
import * as manual from './pages/manual.js';
import * as login from './pages/login.js';

const view = document.getElementById('view');
const routes = [
  { re: /^\/$/, page: overview, nav: 'overview' },
  { re: /^\/pond\/(\d+)$/, page: pond, nav: 'overview' },
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

document.getElementById('logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  stopFarm();
  user = null;
  if ('caches' in window) caches.delete('sff-api').catch(() => {});
  location.hash = '#/';
  route();
});

window.addEventListener('auth-required', () => {
  if (!user) return;
  user = null;
  stopFarm();
  route();
});

async function start() {
  try {
    user = await api.me();
  } catch {
    user = null;
  }
  if (user) {
    const farms = await api.farms();
    if (farms.length) await loadFarm(farms[0].id);
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
