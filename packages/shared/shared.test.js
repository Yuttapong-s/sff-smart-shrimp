import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMetric,
  evaluatePond,
  parseTopic,
  topics,
  generatePondCodes,
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
  const fresh = { time: '2026-01-01T11:59:00Z', do: 5, ph: 7.9, orp: 250, temp: 29 };
  const old = { ...fresh, time: '2026-01-01T11:00:00Z' };
  assert.equal(evaluatePond({ latest: fresh, active: true, now }).status, STATUS.OK);
  assert.equal(evaluatePond({ latest: old, active: true, now }).status, STATUS.OFFLINE);
  assert.equal(evaluatePond({ latest: null, active: true, now }).status, STATUS.OFFLINE);
  assert.equal(evaluatePond({ latest: old, active: false, now }).status, STATUS.IDLE);
});

test('evaluatePond: worst metric wins and reasons are sorted', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const r = evaluatePond({
    latest: { time: '2026-01-01T11:59:30Z', do: 2.8, ph: 8.7, orp: 250, temp: 29 },
    active: true,
    now,
  });
  assert.equal(r.status, STATUS.CRIT);
  assert.equal(r.reasons[0].metric, 'do');
  assert.equal(r.reasons[1].metric, 'ph');
});

test('evaluatePond: missing single value is a warning', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const r = evaluatePond({
    latest: { time: '2026-01-01T11:59:30Z', do: 5, ph: null, orp: 250, temp: 29 },
    active: true,
    now,
  });
  assert.equal(r.status, STATUS.WARN);
});

test('parseTopic round-trips with topics', () => {
  assert.deepEqual(parseTopic(topics.telemetry('F1', 'A01')), { kind: 'telemetry', farm: 'F1', pond: 'A01' });
  assert.deepEqual(parseTopic(topics.state('F1', 'A01')), { kind: 'state', farm: 'F1', pond: 'A01' });
  assert.deepEqual(parseTopic(topics.cmdAck('F1', 'A01')), { kind: 'cmdAck', farm: 'F1', pond: 'A01' });
  assert.deepEqual(parseTopic(topics.gatewayStatus('F1')), { kind: 'gateway', farm: 'F1' });
  assert.deepEqual(parseTopic(topics.alarm('F1')), { kind: 'alarm', farm: 'F1' });
  assert.equal(parseTopic('other/F1/A01/telemetry'), null);
  assert.equal(parseTopic('sff/F1/A01/unknown'), null);
});

test('generatePondCodes and dayOfCulture', () => {
  const codes = generatePondCodes(2, 3);
  assert.deepEqual(codes.map((c) => c.code), ['A01', 'A02', 'A03', 'B01', 'B02', 'B03']);
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
