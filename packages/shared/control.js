// Remote device control: who may command, when a command is allowed, and the MQTT contract.
//
// Flow: app -> api (checks below, row in `commands`) -> MQTT sff/{farm}/{pond}/cmd (QoS 1, not
// retained, message expiry = TTL) -> PLC gateway -> sff/{farm}/{pond}/cmd/ack -> ingest updates
// the row. The device's real on/off state only ever comes from PLC feedback on .../state.
//
//   cmd     {id, device, action: 'on'|'off'|'auto', ts, expires_at, ttl_sec, by}
//   cmd/ack {id, ok: boolean, reason?, message?, ts}
//   state   {ts, mode: 'local'|'remote', devices: [{code, on, auto, current_a, fault}]}
//
// The PLC is the final authority: it must drop a command after expires_at, refuse it in Local
// mode, and apply its own interlocks (e.g. never stop the last aerator when DO is low).

import { roleAtLeast } from './records.js';

export const CONTROL_MIN_ROLE = 'technician';
export const COMMAND_ACTIONS = ['on', 'off', 'auto'];
export const DEFAULT_COMMAND_TTL_SEC = 30;
/** Pond mode (Local/Remote from the HMI) older than this is treated as unknown. */
export const MODE_FRESH_SEC = 120;

export const ACTION_LABEL = { on: 'เปิด', off: 'ปิด', auto: 'กลับเป็นอัตโนมัติ' };

export const COMMAND_STATUS_LABEL = {
  pending: 'กำลังส่ง',
  sent: 'รอ PLC ตอบ',
  acked: 'PLC ทำตามแล้ว',
  rejected: 'PLC ปฏิเสธ',
  expired: 'หมดเวลา ไม่มีการตอบ',
  failed: 'ส่งไม่สำเร็จ',
};
export const COMMAND_FINAL = new Set(['acked', 'rejected', 'expired', 'failed']);

/** Reason codes from the api (before sending) and from the PLC ack. */
export const COMMAND_REASON_LABEL = {
  role: 'สิทธิ์ไม่พอ (ต้องเป็น technician ขึ้นไป)',
  gateway_offline: 'Gateway ฟาร์มขาดการเชื่อมต่อ',
  local_mode: 'HMI อยู่โหมด Local ต้องสั่งที่หน้าฟาร์ม',
  mode_unknown: 'ไม่ทราบโหมด Local/Remote (ยังไม่ได้รับสถานะจาก PLC)',
  state_stale: 'สถานะจาก PLC ไม่อัปเดต',
  busy: 'มีคำสั่งก่อนหน้ากำลังรอ PLC ตอบ',
  low_do: 'DO ในบ่อต่ำ ต้องยืนยันก่อนปิดเครื่องตีน้ำ',
  broker_unavailable: 'ระบบส่งคำสั่ง (MQTT) ไม่พร้อม',
  publish_failed: 'ส่งคำสั่งไป MQTT ไม่สำเร็จ',
  no_ack: 'PLC ไม่ตอบภายในเวลาที่กำหนด',
  expired: 'คำสั่งหมดอายุก่อนถึง PLC',
  interlock: 'PLC ไม่อนุญาต (interlock ความปลอดภัย)',
  device_fault: 'อุปกรณ์ขัดข้อง',
  unknown_device: 'PLC ไม่รู้จักอุปกรณ์นี้',
  plc_error: 'PLC ทำคำสั่งไม่สำเร็จ',
};

export const reasonText = (code, message) =>
  [COMMAND_REASON_LABEL[code] ?? code, message].filter(Boolean).join(' — ') || '';

/**
 * Can this command be sent now? Shared by the api (enforced) and the app (button state).
 * @param {object} a
 * @param {string} a.role         user role
 * @param {string} a.action       'on' | 'off' | 'auto'
 * @param {{kind: string, isOn: boolean|null}} a.device
 * @param {{mode: string, modeAt: string|null, metricStatus?: object}} a.pond
 * @param {boolean|null} a.gatewayOnline
 * @param {boolean} [a.busy]      a command for this device is still waiting for the PLC
 * @param {boolean} [a.confirmed] user confirmed the low-DO warning
 * @param {number} [a.now]        epoch ms
 * @returns {{ok: boolean, code?: string, needsConfirm?: boolean}}
 */
export function checkCommand({ role, action, device, pond, gatewayOnline, busy = false, confirmed = false, now = Date.now() }) {
  if (!roleAtLeast(role, CONTROL_MIN_ROLE)) return { ok: false, code: 'role' };
  if (!COMMAND_ACTIONS.includes(action)) return { ok: false, code: 'invalid_action' };
  if (gatewayOnline === false) return { ok: false, code: 'gateway_offline' };
  if (pond.mode === 'local') return { ok: false, code: 'local_mode' };
  if (pond.mode !== 'remote' || !pond.modeAt) return { ok: false, code: 'mode_unknown' };
  if ((now - Date.parse(pond.modeAt)) / 1000 > MODE_FRESH_SEC) return { ok: false, code: 'state_stale' };
  if (busy) return { ok: false, code: 'busy' };
  const doStatus = pond.metricStatus?.do;
  const lowDo = doStatus === 'warn' || doStatus === 'crit';
  if (device.kind === 'aerator' && action === 'off' && lowDo && !confirmed) {
    return { ok: false, code: 'low_do', needsConfirm: true };
  }
  return { ok: true };
}
