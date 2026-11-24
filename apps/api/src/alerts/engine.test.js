import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlarmEngine, dueEscalations } from './engine.js';

const S = 1000;
const obs = (level, extra = {}) => ({ key: 'pond:1:do', level, hold: 120, clearHold: 60, ...extra });

test('one-sample spike never opens an alarm', () => {
  const e = new AlarmEngine();
  assert.deepEqual(e.step([obs('crit')], 0), []);
  assert.deepEqual(e.step([obs('ok')], 10 * S), []);
  assert.deepEqual(e.step([obs('crit')], 20 * S), []);
  assert.deepEqual(e.step([obs('crit')], 100 * S), []); // only 80 s since it came back
  assert.equal(e.step([obs('crit')], 140 * S)[0].op, 'open');
});

test('opens after hold, raises warn to crit, clears after clearHold', () => {
  const e = new AlarmEngine();
  e.step([obs('warn')], 0);
  const [open] = e.step([obs('warn')], 120 * S);
  assert.deepEqual([open.op, open.severity], ['open', 'warn']);
  e.applied(open, 7);
  assert.deepEqual(e.step([obs('warn')], 130 * S), []); // already open
  e.step([obs('crit')], 200 * S);
  const [raise] = e.step([obs('crit')], 320 * S);
  assert.deepEqual([raise.op, raise.alarmId], ['raise', 7]);
  e.applied(raise);
  e.step([obs('ok')], 400 * S);
  assert.deepEqual(e.step([obs('warn')], 430 * S), []); // flapping: stays open
  e.step([obs('ok')], 440 * S);
  assert.deepEqual(e.step([obs('ok')], 470 * S), []);
  const [clear] = e.step([obs('ok')], 500 * S);
  assert.deepEqual([clear.op, clear.alarmId], ['clear', 7]);
  e.applied(clear);
  assert.equal(e.state.size, 0);
});

test('straight to crit opens as crit; hold 0 opens at once', () => {
  const e = new AlarmEngine();
  e.step([obs('crit')], 0);
  assert.equal(e.step([obs('crit')], 120 * S)[0].severity, 'crit');
  const e2 = new AlarmEngine();
  assert.equal(e2.step([obs('warn', { hold: 0 })], 0)[0].op, 'open');
});

test('restored alarms do not reopen and clear normally', () => {
  const e = new AlarmEngine();
  e.restore([{ id: 3, key: 'pond:1:do', severity: 'crit' }], 0);
  assert.deepEqual(e.step([obs('crit')], 10 * S), []);
  e.step([obs('ok')], 20 * S);
  assert.equal(e.step([obs('ok')], 80 * S)[0].op, 'clear');
});

test('missing observations freeze state', () => {
  const e = new AlarmEngine();
  e.step([obs('warn')], 0);
  assert.deepEqual(e.step([], 500 * S), []);
  assert.equal(e.state.size, 1);
});

test('escalation: crit repeats until acked, warn escalates once', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const base = { started_at: new Date(t0).toISOString(), last_notified_at: null, escalation_level: 0, acked_at: null, cleared_at: null };
  const crit = { ...base, id: 1, severity: 'crit' };
  const warn = { ...base, id: 2, severity: 'warn' };
  assert.equal(dueEscalations([crit, warn], t0 + 60 * S).length, 0);
  const due = dueEscalations([crit, warn], t0 + 301 * S);
  assert.deepEqual(due.map((d) => d.reason), ['renotify']);
  assert.ok(due[0].roles.includes('worker'));
  assert.deepEqual(dueEscalations([warn], t0 + 1801 * S).map((d) => d.roles), [['manager', 'owner']]);
  assert.equal(dueEscalations([{ ...warn, escalation_level: 1 }], t0 + 9000 * S).length, 0);
  assert.equal(dueEscalations([{ ...crit, acked_at: 'x' }], t0 + 9000 * S).length, 0);
});
