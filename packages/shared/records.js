// Manual records (phase 3): definitions and validation shared by the PWA form, the offline
// outbox and the API. Browser-compatible (no Node imports).
//
// Record types (one outbox item each, idempotent by clientId):
//   water        test-kit water test of a unit's RAS: several params at one time
//   lab          lab results for RAS water (unitId) or a pond's shrimp sample (pondId)
//   feeding      one meal for a pond's active cycle
//   growth       ABW sampling for a pond's active cycle
//   cycle_start  stock a pond (manager+)
//   cycle_end    harvest / cancel the active cycle (manager+)

// Test-kit params measured on the RAS. `ref` = recommended range for L. vannamei
// (display guidance only; alarms on manual values come with the alert engine).
export const WATER_PARAMS = {
  alkalinity: { label: 'อัลคาไลน์', unit: 'mg/L', digits: 0, min: 0, max: 1000, ref: [120, 200] },
  salinity: { label: 'ความเค็ม', unit: 'ppt', digits: 1, min: 0, max: 60, ref: [5, 30] },
  tan: { label: 'แอมโมเนียรวม (TAN)', unit: 'mg/L', digits: 2, min: 0, max: 50, ref: [null, 1] },
  no2: { label: 'ไนไตรท์ (NO₂)', unit: 'mg/L', digits: 2, min: 0, max: 50, ref: [null, 1] },
  hardness: { label: 'ความกระด้าง', unit: 'mg/L', digits: 0, min: 0, max: 20000, ref: null },
  ca: { label: 'แคลเซียม (Ca)', unit: 'mg/L', digits: 0, min: 0, max: 5000, ref: null },
  mg: { label: 'แมกนีเซียม (Mg)', unit: 'mg/L', digits: 0, min: 0, max: 10000, ref: null },
};

// Lab params. kind 'count' = numeric CFU/mL, 'pcr' = negative / positive.
export const LAB_PARAMS = {
  vibrio_green: { label: 'Vibrio โคโลนีเขียว', kind: 'count', unit: 'CFU/mL', warnAbove: 100 },
  vibrio_yellow: { label: 'Vibrio โคโลนีเหลือง', kind: 'count', unit: 'CFU/mL', warnAbove: 1000 },
  ehp: { label: 'EHP', kind: 'pcr' },
  ahpnd: { label: 'AHPND (EMS)', kind: 'pcr' },
  wssv: { label: 'WSSV (ตัวแดงดวงขาว)', kind: 'pcr' },
};
export const PCR_RESULTS = { neg: 'ลบ (ไม่พบ)', pos: 'บวก (พบ)' };

// Feed tray check (เช็คยอ).
export const TRAY_CHECK = { empty: 'หมดยอ', little: 'เหลือเล็กน้อย', much: 'เหลือมาก' };

export const RECORD_TYPES = {
  water: { label: 'ค่าน้ำ RAS', minRole: 'worker' },
  feeding: { label: 'ให้อาหาร', minRole: 'worker' },
  growth: { label: 'สุ่มน้ำหนัก', minRole: 'worker' },
  lab: { label: 'ผล Lab', minRole: 'worker' },
  cycle_start: { label: 'ลงกุ้ง (เริ่มรอบ)', minRole: 'manager' },
  cycle_end: { label: 'จบรอบ / จับกุ้ง', minRole: 'manager' },
};

export const ROLE_LADDER = ['worker', 'technician', 'manager', 'owner'];
export const roleAtLeast = (role, min) => ROLE_LADDER.indexOf(role) >= ROLE_LADDER.indexOf(min);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => Number.isInteger(v) && v > 0;
const MAX_FUTURE_MS = 10 * 60_000; // phone clocks drift a little
const MAX_PAST_MS = 400 * 86_400_000;

function checkTime(errors, field, iso, now) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) errors.push(`${field}: เวลาไม่ถูกต้อง`);
  else if (t > now + MAX_FUTURE_MS) errors.push(`${field}: เวลาอยู่ในอนาคต`);
  else if (t < now - MAX_PAST_MS) errors.push(`${field}: เวลาเก่าเกินไป`);
}

function checkDate(errors, field, d, now) {
  if (typeof d !== 'string' || !DATE_RE.test(d) || !Number.isFinite(Date.parse(d))) errors.push(`${field}: วันที่ไม่ถูกต้อง`);
  else if (Date.parse(d) > now + 86_400_000) errors.push(`${field}: วันที่อยู่ในอนาคต`);
}

function checkRange(errors, field, v, min, max, { required = true } = {}) {
  if (v == null) {
    if (required) errors.push(`${field}: ต้องกรอก`);
    return;
  }
  if (!isNum(v)) errors.push(`${field}: ต้องเป็นตัวเลข`);
  else if (v < min || v > max) errors.push(`${field}: ต้องอยู่ระหว่าง ${min}–${max}`);
}

function checkNote(errors, note) {
  if (note != null && (typeof note !== 'string' || note.length > 500)) errors.push('หมายเหตุยาวเกิน 500 ตัวอักษร');
}

/**
 * Validate one record. Returns a list of Thai error messages (empty = valid).
 * @param {{type: string, clientId: string, data: object}} rec
 */
export function validateRecord(rec, now = Date.now()) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return ['รูปแบบข้อมูลไม่ถูกต้อง'];
  if (!RECORD_TYPES[rec.type]) return [`ไม่รู้จักประเภท ${rec.type}`];
  if (typeof rec.clientId !== 'string' || !UUID_RE.test(rec.clientId)) errors.push('clientId ไม่ถูกต้อง');
  const d = rec.data ?? {};
  checkNote(errors, d.note);

  switch (rec.type) {
    case 'water': {
      if (!isId(d.unitId)) errors.push('ต้องเลือก Unit');
      checkTime(errors, 'เวลาวัด', d.time, now);
      const entries = Object.entries(d.values ?? {}).filter(([, v]) => v != null);
      if (!entries.length) errors.push('กรอกค่าอย่างน้อย 1 รายการ');
      for (const [k, v] of entries) {
        const p = WATER_PARAMS[k];
        if (!p) errors.push(`ไม่รู้จักค่า ${k}`);
        else checkRange(errors, p.label, v, p.min, p.max);
      }
      break;
    }
    case 'lab': {
      if (isId(d.unitId) === isId(d.pondId)) errors.push('ต้องเลือกน้ำ RAS ของ Unit หรือบ่อ อย่างใดอย่างหนึ่ง');
      checkTime(errors, 'เวลาเก็บตัวอย่าง', d.sampledAt, now);
      if (d.labName != null && (typeof d.labName !== 'string' || d.labName.length > 100)) errors.push('ชื่อ Lab ยาวเกินไป');
      const entries = Object.entries(d.results ?? {}).filter(([, v]) => v != null && v !== '');
      if (!entries.length) errors.push('กรอกผลอย่างน้อย 1 รายการ');
      for (const [k, v] of entries) {
        const p = LAB_PARAMS[k];
        if (!p) errors.push(`ไม่รู้จักรายการ ${k}`);
        else if (p.kind === 'count') checkRange(errors, p.label, v, 0, 1e9);
        else if (!PCR_RESULTS[v]) errors.push(`${p.label}: ต้องเป็น ลบ หรือ บวก`);
      }
      break;
    }
    case 'feeding':
      if (!isId(d.pondId)) errors.push('ต้องเลือกบ่อ');
      checkTime(errors, 'เวลาให้อาหาร', d.fedAt, now);
      checkRange(errors, 'ปริมาณอาหาร (kg)', d.feedKg, 0, 500);
      if (d.feedType != null && (typeof d.feedType !== 'string' || d.feedType.length > 60)) errors.push('ชนิดอาหารยาวเกินไป');
      if (d.trayCheck != null && !TRAY_CHECK[d.trayCheck]) errors.push('ผลเช็คยอไม่ถูกต้อง');
      break;
    case 'growth':
      if (!isId(d.pondId)) errors.push('ต้องเลือกบ่อ');
      checkTime(errors, 'เวลาสุ่ม', d.sampledAt, now);
      checkRange(errors, 'น้ำหนักเฉลี่ย (g)', d.abwG, 0.01, 100);
      checkRange(errors, 'จำนวนที่สุ่ม', d.sampleCount, 1, 10000, { required: false });
      if (d.sampleCount != null && !Number.isInteger(d.sampleCount)) errors.push('จำนวนที่สุ่มต้องเป็นจำนวนเต็ม');
      checkRange(errors, 'อัตรารอด (%)', d.survivalPct, 0, 100, { required: false });
      break;
    case 'cycle_start':
      if (!isId(d.pondId)) errors.push('ต้องเลือกบ่อ');
      checkDate(errors, 'วันลงกุ้ง', d.stockedAt, now);
      checkRange(errors, 'จำนวนลูกกุ้ง', d.stockedCount, 1, 100_000_000);
      if (d.stockedCount != null && !Number.isInteger(d.stockedCount)) errors.push('จำนวนลูกกุ้งต้องเป็นจำนวนเต็ม');
      break;
    case 'cycle_end':
      if (!isId(d.pondId)) errors.push('ต้องเลือกบ่อ');
      if (!isId(d.cycleId)) errors.push('ไม่ทราบรอบการเลี้ยง');
      if (!['harvested', 'cancelled'].includes(d.status)) errors.push('ต้องเลือก จับกุ้ง หรือ ยกเลิกรอบ');
      checkDate(errors, 'วันที่จบรอบ', d.endedAt, now);
      checkRange(errors, 'ผลผลิต (kg)', d.harvestKg, 0, 1_000_000, { required: d.status === 'harvested' });
      break;
  }
  return errors;
}

/** Recommended-range check for display: 'low' | 'high' | null. */
export function waterRefFlag(param, value) {
  const ref = WATER_PARAMS[param]?.ref;
  if (!ref || !isNum(value)) return null;
  if (ref[0] != null && value < ref[0]) return 'low';
  if (ref[1] != null && value > ref[1]) return 'high';
  return null;
}

/** Lab result needing attention: count over warnAbove, or PCR positive. */
export function labFlag(param, value) {
  const p = LAB_PARAMS[param];
  if (!p) return false;
  if (p.kind === 'pcr') return value === 'pos';
  return isNum(value) && p.warnAbove != null && value > p.warnAbove;
}

/** Parse a number typed by a field worker: Thai style "1,500.5" (comma = thousands). Empty -> null, junk -> NaN. */
export function parseNumberInput(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
