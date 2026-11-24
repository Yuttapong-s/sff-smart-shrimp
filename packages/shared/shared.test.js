import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMetric,
  evaluatePond,
  evaluateRas,
  parseTopic,
  topics,
  generateLayout,
  normalizePondQuery,
  dayOfCulture,
  thresholdsFromRules,
  STATUS,
} from './index.js';

test('evaluateMetric applies crit before warn', () => {
  assert.equal(evaluateMetric('do', 2.5).status, STATUS.CRIT);
  assert.equal(evaluateMetric('do', 3.5).status, STATUS.WARN);
  assert.equal(evaluateMetric('do', 5.5).status, STATUS.OK);
  assert.equal(evaluateMetric('ph', 9.2).status, STATUS.CRIT);
  assert.equal(evaluateMetric('ph', 9.2).direction, 'high');
  assert.equal(evaluateMetric('ph', null).status, STATUS.OFFLINE);
});

test('evaluatePond: stale data is offline, idle overrides', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const fresh = { time: '2026-01-01T11:59:00Z', do: 5, doPct: 70, temp: 29 };
  const old = { ...fresh, time: '2026-01-01T11:00:00Z' };
  assert.equal(evaluatePond({ latest: fresh, active: true, now }).status, STATUS.OK);
  assert.equal(evaluatePond({ latest: old, active: true, now }).status, STATUS.OFFLINE);
  assert.equal(evaluatePond({ latest: null, active: true, now }).status, STATUS.OFFLINE);
  assert.equal(evaluatePond({ latest: old, active: false, now }).status, STATUS.IDLE);
});

test('evaluatePond: worst metric wins and reasons are sorted', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const r = evaluatePond({
    latest: { time: '2026-01-01T11:59:30Z', do: 3.5, doPct: 50, temp: 35 },
    active: true,
    now,
  });
  assert.equal(r.status, STATUS.CRIT);
  assert.equal(r.reasons[0].metric, 'temp');
  assert.equal(r.reasons[1].metric, 'do');
  assert.equal(r.metrics.ph, undefined, 'pH is a RAS metric, not a pond metric');
});

test('evaluateRas: pH/ORP/temp, stale is offline, never idle', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const t = '2026-01-01T11:59:30Z';
  assert.equal(evaluateRas({ latest: { time: t, ph: 7.9, orp: 250, temp: 29 }, now }).status, STATUS.OK);
  const hi = evaluateRas({ latest: { time: t, ph: 9.3, orp: 120, temp: 29 }, now });
  assert.equal(hi.status, STATUS.CRIT);
  assert.deepEqual(hi.reasons.map((r) => r.metric), ['ph', 'orp']);
  assert.equal(evaluateRas({ latest: { time: t, ph: null, orp: 250, temp: 29 }, now }).status, STATUS.WARN);
  assert.equal(evaluateRas({ latest: { time: '2026-01-01T11:00:00Z', ph: 7.9, orp: 250, temp: 29 }, now }).status, STATUS.OFFLINE);
  assert.equal(evaluateRas({ latest: null, now }).status, STATUS.OFFLINE);
});

test('evaluatePond: missing single value is a warning', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const r = evaluatePond({
    latest: { time: '2026-01-01T11:59:30Z', do: 5, doPct: 70, temp: null },
    active: true,
    now,
  });
  assert.equal(r.status, STATUS.WARN);
});

test('parseTopic round-trips with topics', () => {
  assert.deepEqual(parseTopic(topics.telemetry('F1', 'U01-P01')), { kind: 'telemetry', farm: 'F1', pond: 'U01-P01' });
  assert.deepEqual(parseTopic(topics.rasTelemetry('F1', 'U01')), { kind: 'rasTelemetry', farm: 'F1', unit: 'U01' });
  assert.deepEqual(parseTopic(topics.state('F1', 'A01')), { kind: 'state', farm: 'F1', pond: 'A01' });
  assert.deepEqual(parseTopic(topics.cmdAck('F1', 'A01')), { kind: 'cmdAck', farm: 'F1', pond: 'A01' });
  assert.deepEqual(parseTopic(topics.gatewayStatus('F1')), { kind: 'gateway', farm: 'F1' });
  assert.deepEqual(parseTopic(topics.alarm('F1')), { kind: 'alarm', farm: 'F1' });
  assert.equal(parseTopic('other/F1/A01/telemetry'), null);
  assert.equal(parseTopic('sff/F1/A01/unknown'), null);
});

test('generateLayout: 12 units of 4-6 ponds, unique codes, deterministic', () => {
  const layout = generateLayout({ units: 12, min: 4, max: 6 });
  assert.equal(layout.length, 12);
  assert.equal(layout[0].unit, 'U01');
  assert.equal(layout[11].unit, 'U12');
  for (const u of layout) assert.ok(u.ponds.length >= 4 && u.ponds.length <= 6, `${u.unit}: ${u.ponds.length}`);
  assert.ok(new Set(layout.map((u) => u.ponds.length)).size > 1, 'counts should vary');
  const codes = layout.flatMap((u) => u.ponds.map((p) => p.code));
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes[0], 'U01-P01');
  assert.deepEqual(generateLayout({ units: 12, min: 4, max: 6 }), layout);
  const big = generateLayout({ units: 3, min: 1, max: 99 });
  for (const u of big) assert.ok(u.ponds.length <= 10);
});

test('normalizePondQuery', () => {
  for (const q of ['1-1', 'u1p1', 'U01-P01', ' 01 - 01 ']) assert.equal(normalizePondQuery(q).pond, 'U01-P01', q);
  assert.deepEqual(normalizePondQuery('3-2'), { unit: 'U03', pond: 'U03-P02' });
  assert.deepEqual(normalizePondQuery('u3'), { unit: 'U03' });
  assert.deepEqual(normalizePondQuery('12'), { unit: 'U12' });
  assert.deepEqual(normalizePondQuery('abc'), { text: 'ABC' });
  assert.deepEqual(normalizePondQuery(''), {});
});

test('dayOfCulture', () => {
  const now = new Date(2026, 0, 10, 15).getTime();
  assert.equal(dayOfCulture('2026-01-10', now), 1);
  assert.equal(dayOfCulture('2026-01-01', now), 10);
  assert.equal(dayOfCulture(null, now), null);
});

test('thresholdsFromRules overrides defaults', () => {
  const t = thresholdsFromRules([{ metric: 'do', crit_low: 2.5, warn_low: 3.5, warn_high: null, crit_high: null }]);
  assert.equal(t.do.critLow, 2.5);
  assert.equal(t.ph.critLow, 7.0);
});

test('validateRule', async () => {
  const { validateRule } = await import('./thresholds.js');
  assert.deepEqual(validateRule('do', { critLow: 3, warnLow: 4, warnHigh: null, critHigh: null, holdSeconds: 120 }), []);
  assert.ok(validateRule('do', { critLow: 4, warnLow: 3, holdSeconds: 120 }).length, 'order');
  assert.ok(validateRule('ph', { warnLow: 7.5, critHigh: 15, holdSeconds: 60 }).length, 'range');
  assert.ok(validateRule('temp', { warnLow: 26, holdSeconds: 9999 }).length, 'hold');
  assert.ok(validateRule('temp', { holdSeconds: 60 }).length, 'no limits');
  assert.ok(validateRule('nope', {}).length);
});
