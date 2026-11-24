// Device list with remote on / off / auto commands, live command progress, and command history.
// The dot and "ทำงาน/หยุด" always show PLC feedback; a command only shows its own progress line.

import {
  checkCommand,
  CONTROL_MIN_ROLE,
  ACTION_LABEL,
  COMMAND_STATUS_LABEL,
  COMMAND_FINAL,
  reasonText,
  roleAtLeast,
} from '/shared/index.js';
import { api } from './api.js';
import { newClientId } from './outbox.js';
import { esc, fmtDateTime, timeAgo } from './format.js';

const RECENT_MS = 10 * 60_000; // show a device's last command result for this long
const STATE_WAIT_MS = 20_000; // after an ack, real state should follow within this

/** Latest command per device (commands are newest first). */
export function lastCommands(commands) {
  const m = new Map();
  for (const c of commands) if (!m.has(c.deviceId)) m.set(c.deviceId, c);
  return m;
}

/** Does the PLC-reported state reflect what the command asked for? */
function stateMatches(d, c) {
  if (c.action === 'auto') return d.auto === true;
  return d.isOn === (c.action === 'on') && d.auto !== true;
}

const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));

/** One progress line for the device's latest command, or '' when there is nothing recent. */
function progressLine(d, c, now) {
  if (!c) return '';
  const age = now - Date.parse(c.requestedAt);
  const what = `${ACTION_LABEL[c.action]} โดย ${esc(c.requestedBy)}`;
  if (!COMMAND_FINAL.has(c.status)) {
    const left = secs(Date.parse(c.expiresAt) - now);
    return `<div class="cmd-line busy">⏳ ${COMMAND_STATUS_LABEL[c.status]} — ${what} (เหลือ ${left} วินาที)</div>`;
  }
  if (age > RECENT_MS) return '';
  if (c.status === 'acked') {
    if (stateMatches(d, c)) {
      return `<div class="cmd-line ok">✓ ${what} สำเร็จ ยืนยันจากสถานะจริงแล้ว · ${esc(timeAgo(c.ackAt, now))}</div>`;
    }
    const waited = now - Date.parse(c.ackAt);
    return waited < STATE_WAIT_MS
      ? `<div class="cmd-line busy">⏳ PLC รับคำสั่ง ${what} แล้ว รอสถานะจริงจากอุปกรณ์…</div>`
      : `<div class="cmd-line warn">⚠ PLC รับคำสั่ง ${what} แล้ว แต่สถานะจริงยังไม่ตรง — ตรวจที่หน้างาน</div>`;
  }
  const why = reasonText(c.reason, c.message);
  return `<div class="cmd-line bad">✗ ${COMMAND_STATUS_LABEL[c.status]} — ${what}${why ? `: ${esc(why)}` : ''}</div>`;
}

/**
 * Why commands are blocked for the whole pond right now (role, offline, Local, gateway...), or null.
 * Checked with a neutral action; per-device "busy" and low-DO confirmation are handled per button.
 */
export function controlBlock({ user, pond, gatewayOnline, live, now }) {
  if (!roleAtLeast(user?.role, CONTROL_MIN_ROLE)) return { code: 'role', text: 'ดูได้อย่างเดียว — สั่งงานอุปกรณ์ได้เฉพาะ technician ขึ้นไป' };
  if (!navigator.onLine || live === false) return { code: 'offline', text: 'ไม่ได้เชื่อมต่อเซิร์ฟเวอร์ — สั่งงานไม่ได้ตอนออฟไลน์' };
  const r = checkCommand({ role: user.role, action: 'on', device: { kind: 'other' }, pond, gatewayOnline, now });
  return r.ok ? null : { code: r.code, text: reasonText(r.code) };
}

export function deviceListHtml({ devices, commands, block, now }) {
  if (!devices.length) return '<li class="empty">ยังไม่มีอุปกรณ์ในบ่อนี้</li>';
  const last = lastCommands(commands);
  return devices
    .map((d) => {
      const c = last.get(d.id);
      const busy = c && !COMMAND_FINAL.has(c.status);
      const cls = d.fault ? 'fault' : d.isOn ? 'on' : '';
      const state = d.fault ? 'ขัดข้อง' : d.isOn == null ? 'ไม่ทราบสถานะ' : d.isOn ? 'ทำงาน' : 'หยุด';
      const amp = typeof d.currentA === 'number' && d.isOn ? ` · ${d.currentA.toFixed(1)} A` : '';
      const mode = d.auto === true ? ' · อัตโนมัติ' : d.auto === false ? ' · <b>สั่งเอง (Manual)</b>' : '';
      const showButtons = block?.code !== 'role';
      const disabled = block || busy ? ' disabled' : '';
      const btn = (action) => {
        const current = action === 'auto' ? d.auto === true : d.auto === false && d.isOn === (action === 'on');
        return `<button type="button" class="btn" data-cmd="${action}" data-device="${d.id}" aria-pressed="${current}"${disabled}>${action === 'auto' ? 'อัตโนมัติ' : ACTION_LABEL[action]}</button>`;
      };
      return `<li class="device">
        <span class="dot ${cls}" aria-hidden="true"></span>
        <div class="device-body">
          <div class="name">${esc(d.name)}</div>
          <div class="state">${state}${amp}${mode} · ${esc(timeAgo(d.updatedAt, now))}</div>
          ${progressLine(d, c, now)}
        </div>
        ${showButtons ? `<div class="seg device-cmds" role="group" aria-label="สั่ง ${esc(d.name)}">${btn('on')}${btn('off')}${btn('auto')}</div>` : ''}
      </li>`;
    })
    .join('');
}

/** True while any command is waiting for the PLC or an acked one waits for real state. */
export function needsTicking(devices, commands, now) {
  const last = lastCommands(commands);
  return devices.some((d) => {
    const c = last.get(d.id);
    if (!c) return false;
    if (!COMMAND_FINAL.has(c.status)) return true;
    return c.status === 'acked' && !stateMatches(d, c) && now - Date.parse(c.ackAt) < STATE_WAIT_MS + 2000;
  });
}

/**
 * Ask for confirmation, then send. Returns the command (or throws with a Thai message).
 * @param {{device: object, action: string, pond: object}} a
 */
export async function sendCommand({ device, action, pond }) {
  const doStatus = pond.metricStatus?.do;
  const lowDo = device.kind === 'aerator' && action === 'off' && (doStatus === 'warn' || doStatus === 'crit');
  const head = `${ACTION_LABEL[action]} "${device.name}" บ่อ ${pond.code}`;
  const text = lowDo
    ? `⚠ DO ในบ่อ ${pond.code} ต่ำ (${pond.latest?.do ?? '–'} mg/L)\nการปิดเครื่องตีน้ำอาจทำให้กุ้งตายได้\n\nยืนยัน${head}?`
    : action === 'auto'
      ? `ให้ "${device.name}" บ่อ ${pond.code} กลับไปทำงานตามโปรแกรมอัตโนมัติของ PLC?`
      : `ยืนยัน${head}?\nคำสั่งนี้จะค้างเป็นโหมดสั่งเอง (Manual) จนกว่าจะกด "อัตโนมัติ"`;
  if (!confirm(text)) return null;
  const body = { id: newClientId(), deviceId: device.id, action, confirm: lowDo };
  try {
    return await api.command(body);
  } catch (err) {
    if (err.status === 403) throw new Error(reasonText('role'));
    if (err.code) throw new Error(reasonText(err.code));
    if (err.body?.status) return err.body; // 502: recorded as failed, show it in the list
    throw new Error(navigator.onLine ? `ส่งคำสั่งไม่สำเร็จ (${err.message})` : 'ไม่มีอินเทอร์เน็ต — สั่งงานไม่ได้');
  }
}

export function commandTable(commands) {
  if (!commands.length) return '<div class="empty">ยังไม่มีการสั่งงานจากระบบ</div>';
  const rows = commands.map((c) => {
    const ms = c.ackReceivedAt ? Date.parse(c.ackReceivedAt) - Date.parse(c.requestedAt) : null;
    const took = ms == null ? '–' : ms < 1000 ? `${Math.max(1, ms)} ms` : `${(ms / 1000).toFixed(1)} วินาที`;
    const why = reasonText(c.reason, c.message);
    const flag = c.status === 'acked' ? 'ok' : COMMAND_FINAL.has(c.status) ? 'bad' : 'busy';
    return `<tr>
      <td>${fmtDateTime(c.requestedAt)}</td>
      <td>${esc(c.deviceName)}</td>
      <td>${ACTION_LABEL[c.action]}${c.confirmedLowDo ? ' <span class="status-pill s-warn">! ยืนยันตอน DO ต่ำ</span>' : ''}</td>
      <td>${esc(c.requestedBy)}</td>
      <td><span class="cmd-st ${flag}">${COMMAND_STATUS_LABEL[c.status]}</span>${why ? `<div class="small muted">${esc(why)}</div>` : ''}${c.late ? '<div class="small muted">PLC ตอบช้ากว่ากำหนด</div>' : ''}</td>
      <td class="num">${took}</td>
    </tr>`;
  });
  return `<table class="list"><thead><tr><th>เวลา</th><th>อุปกรณ์</th><th>คำสั่ง</th><th>ผู้สั่ง</th><th>ผล</th><th>PLC ตอบใน</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
