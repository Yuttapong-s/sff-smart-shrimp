import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTelemetry, parseRasTelemetry, parseState, parseGateway, BACKFILL } from './parse.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const b = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));

test('single sample with ISO timestamp', () => {
  const { samples, dropped } = parseTelemetry(b({ ts: '2026-01-01T11:59:00Z', do: 5.2, do_pct: 71, temp: 29 }), now);
  assert.equal(dropped, 0);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].do, 5.2);
  assert.equal(samples[0].doPct, 71);
  assert.equal(samples[0].ph, undefined);
  assert.equal(samples[0].quality, 0);
});

test('epoch seconds and ms both accepted', () => {
  const s = parseTelemetry(b({ ts: now / 1000 - 10, do: 5 }), now).samples[0];
  const ms = parseTelemetry(b({ ts: now - 10_000, do: 5 }), now).samples[0];
  assert.equal(s.time.getTime(), now - 10_000);
  assert.equal(ms.time.getTime(), now - 10_000);
});

test('batch with backfill flag', () => {
  const { samples } = parseTelemetry(
    b({ samples: [{ ts: now - 60_000, do: 5, backfill: true }, { ts: now, do: 6 }] }),
    now,
  );
  assert.equal(samples.length, 2);
  assert.equal(samples[0].quality & BACKFILL, BACKFILL);
});

test('out-of-range values are nulled and flagged', () => {
  const [s] = parseTelemetry(b({ ts: now, do: 99, temp: 28.5 }), now).samples;
  assert.equal(s.do, null);
  assert.equal(s.temp, 28.5);
  assert.equal(s.quality, 1);
});

test('RAS telemetry: pH/ORP/temp with ranges', () => {
  const [s] = parseRasTelemetry(b({ ts: now, ph: 7.8, orp: -150, temp: 28 }), now).samples;
  assert.deepEqual({ ph: s.ph, orp: s.orp, temp: s.temp, q: s.quality }, { ph: 7.8, orp: -150, temp: 28, q: 0 });
  const [bad] = parseRasTelemetry(b({ ts: now, ph: 15, orp: 2500, temp: 28 }), now).samples;
  assert.equal(bad.ph, null);
  assert.equal(bad.orp, null);
  assert.equal(bad.quality, 1 | 2);
  assert.equal(parseRasTelemetry(b({ ts: now, do: 5 }), now).samples.length, 0, 'pond fields are not RAS fields');
});

test('drops garbage, missing/future timestamps and all-null samples', () => {
  assert.equal(parseTelemetry(b('not json'), now).dropped, 1);
  assert.equal(parseTelemetry(b({ do: 5 }), now).samples.length, 0);
  assert.equal(parseTelemetry(b({ ts: now + 3600_000, do: 5 }), now).samples.length, 0);
  assert.equal(parseTelemetry(b({ ts: now, do: 'x' }), now).samples.length, 0);
});

test('state and gateway payloads', () => {
  const st = parseState(b({ ts: now, mode: 'remote', devices: [{ code: 'AE1', on: true, current_a: 12.1 }, { bad: 1 }] }), now);
  assert.equal(st.mode, 'remote');
  assert.deepEqual(st.devices, [{ code: 'AE1', on: true, currentA: 12.1, fault: false }]);
  assert.equal(parseState(b({ mode: 'weird' }), now).mode, null);
  assert.equal(parseGateway(b({ online: false }), now).online, false);
  assert.equal(parseGateway(b({}), now), null);
});
