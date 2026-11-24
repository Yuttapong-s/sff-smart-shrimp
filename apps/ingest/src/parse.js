// Payload validation. Bad input is dropped (with a reason) rather than crashing ingest.

import { PHYSICAL_RANGE } from '@sff/shared';

export const BACKFILL = 16;

// Field spec per probe set: payload key -> sample key, and its quality bit (value out of range).
export const POND_FIELDS = [
  { src: 'do', key: 'do', bit: 1 },
  { src: 'do_pct', key: 'doPct', bit: 2 },
  { src: 'temp', key: 'temp', bit: 4 },
];
export const RAS_FIELDS = [
  { src: 'ph', key: 'ph', bit: 1 },
  { src: 'orp', key: 'orp', bit: 2 },
  { src: 'temp', key: 'temp', bit: 4 },
];

const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 30 * 86400 * 1000; // edge buffer may replay up to 30 days

function parseTime(ts, now) {
  if (ts === undefined || ts === null) return null;
  const t = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms > now + MAX_FUTURE_MS || ms < now - MAX_PAST_MS) return null;
  return t;
}

function parseSample(s, fields, now) {
  if (!s || typeof s !== 'object') return null;
  const time = parseTime(s.ts, now);
  if (!time) return null;
  const out = { time, quality: s.backfill ? BACKFILL : 0 };
  let any = false;
  for (const f of fields) {
    const v = s[f.src];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out[f.key] = null;
      continue;
    }
    const [lo, hi] = PHYSICAL_RANGE[f.key];
    if (v < lo || v > hi) {
      out[f.key] = null;
      out.quality |= f.bit;
    } else {
      out[f.key] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function json(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

function parseSamples(buf, fields, now) {
  const body = json(buf);
  if (body === undefined) return { samples: [], dropped: 1 };
  const list = Array.isArray(body?.samples) ? body.samples : [body];
  const samples = [];
  for (const s of list) {
    const p = parseSample(s, fields, now);
    if (p) samples.push(p);
  }
  return { samples, dropped: list.length - samples.length };
}

/**
 * Pond telemetry (DO probe): one sample `{ts, do, do_pct, temp}` or a batch `{samples: [...]}`
 * (edge buffer flush / backfill). `ts` is ISO string or epoch (s or ms), taken at the source.
 * @returns {{samples: {time, quality, do, doPct, temp}[], dropped: number}}
 */
export function parseTelemetry(buf, now = Date.now()) {
  return parseSamples(buf, POND_FIELDS, now);
}

/**
 * RAS telemetry (pH + ORP probes of a unit): `{ts, ph, orp, temp}` or `{samples: [...]}`.
 * @returns {{samples: {time, quality, ph, orp, temp}[], dropped: number}}
 */
export function parseRasTelemetry(buf, now = Date.now()) {
  return parseSamples(buf, RAS_FIELDS, now);
}

/**
 * State payload from PLC feedback:
 * `{ts, mode: 'local'|'remote', devices: [{code, on, current_a, fault}]}`
 */
export function parseState(buf, now = Date.now()) {
  const body = json(buf);
  if (!body || typeof body !== 'object') return null;
  const time = parseTime(body.ts, now) ?? new Date(now);
  const mode = ['local', 'remote'].includes(body.mode) ? body.mode : null;
  const devices = (Array.isArray(body.devices) ? body.devices : [])
    .filter((d) => d && typeof d.code === 'string')
    .map((d) => ({
      code: d.code,
      on: typeof d.on === 'boolean' ? d.on : null,
      auto: typeof d.auto === 'boolean' ? d.auto : null,
      currentA: typeof d.current_a === 'number' && Number.isFinite(d.current_a) ? d.current_a : null,
      fault: d.fault === true,
    }));
  return { time, mode, devices };
}

/** Gateway status (retained + LWT): `{online: boolean, ts}` */
export function parseGateway(buf, now = Date.now()) {
  const body = json(buf);
  if (!body || typeof body.online !== 'boolean') return null;
  return { online: body.online, time: parseTime(body.ts, now) ?? new Date(now) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Command result from the PLC: `{id, ok, reason?, message?, ts}` */
export function parseCmdAck(buf, now = Date.now()) {
  const body = json(buf);
  if (!body || typeof body.id !== 'string' || !UUID_RE.test(body.id) || typeof body.ok !== 'boolean') return null;
  const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return {
    id: body.id.toLowerCase(),
    ok: body.ok,
    reason: body.ok ? null : str(body.reason, 40) ?? 'plc_error',
    message: str(body.message, 200),
    time: parseTime(body.ts, now) ?? new Date(now),
  };
}
