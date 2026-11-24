// Web Push on this device: permission, subscribe / unsubscribe, and re-linking the
// subscription to whoever is logged in (shared farm phones change hands).

import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** iPhone / iPad only deliver Web Push to an app added to the home screen (iOS 16.4+). */
export const needsHomeScreen = () => isIos() && !isStandalone();

function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.ready;
}

/** {supported, permission, subscribed} */
export async function pushState() {
  if (!pushSupported()) return { supported: false, permission: 'unsupported', subscribed: false };
  const sub = await (await registration()).pushManager.getSubscription().catch(() => null);
  return { supported: true, permission: Notification.permission, subscribed: !!sub };
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
  if (needsHomeScreen()) throw new Error('บน iPhone/iPad ต้องกด "แชร์ → เพิ่มไปยังหน้าจอโฮม" แล้วเปิดแอปจากไอคอนก่อน');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้แจ้งเตือน — เปิดได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์');
  const reg = await registration();
  const { publicKey } = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  const current = sub?.options?.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))) !== btoa(String.fromCharCode(...keyBytes(publicKey)))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush() {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** After login: make this device's existing subscription deliver to the current user. */
export async function relinkPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await (await registration()).pushManager.getSubscription().catch(() => null);
  if (sub) await api.pushSubscribe(sub.toJSON()).catch(() => {});
}

/** On logout: stop this device receiving the previous user's alarms. */
export async function unlinkPush() {
  if (!pushSupported()) return;
  const sub = await (await registration()).pushManager.getSubscription().catch(() => null);
  if (sub) await api.pushUnsubscribe(sub.endpoint).catch(() => {});
}
