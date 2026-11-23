// Payload validation. Bad input is dropped (with a reason) rather than crashing ingest.

import { METRICS, PHYSICAL_RANGE } from '@sff/shared';

export const QUALITY = { do: 1, ph: 2, orp: 4, temp: 8, BACKFILL: 16 };

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

function parseSample(s, now) {
  if (!s || typeof s !== 'object') return null;
  const time = parseTime(s.ts, now);
  if (!time) return null;
  const out = { time, quality: s.backfill ? QUALITY.BACKFILL : 0 };
  let any = false;
  for (const m of METRICS) {
    const v = s[m];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out[m] = null;
      continue;
    }
    const [lo, hi] = PHYSICAL_RANGE[m];
    if (v < lo || v > hi) {
      out[m] = null;
      out.quality |= QUALITY[m];
    } else {
      out[m] = v;
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

/**
 * Telemetry payload: one sample `{ts, do, ph, orp, temp}` or a batch `{samples: [...]}`
 * (edge buffer flush / backfill). `ts` is ISO string or epoch (s or ms), taken at the source.
 * @returns {{samples: object[], dropped: number}}
 */
export function parseTelemetry(buf, now = Date.now()) {
  const body = json(buf);
  if (body === undefined) return { samples: [], dropped: 1 };
  const list = Array.isArray(body?.samples) ? body.samples : [body];
  const samples = [];
  for (const s of list) {
    const p = parseSample(s, now);
    if (p) samples.push(p);
  }
  return { samples, dropped: list.length - samples.length };
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
