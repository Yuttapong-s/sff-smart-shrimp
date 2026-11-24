import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand, MODE_FRESH_SEC } from './control.js';

const NOW = Date.parse('2026-11-24T08:00:00Z');
const aerator = { kind: 'aerator', isOn: true };
const pond = (o = {}) => ({ mode: 'remote', modeAt: new Date(NOW - 10_000).toISOString(), metricStatus: { do: 'ok' }, ...o });
const base = { role: 'technician', action: 'off', device: aerator, gatewayOnline: true, now: NOW };

test('allowed command in Remote mode', () => {
  assert.deepEqual(checkCommand({ ...base, pond: pond() }), { ok: true });
  assert.deepEqual(checkCommand({ ...base, role: 'owner', action: 'auto', pond: pond() }), { ok: true });
});

test('blocked: role, gateway, Local, unknown or stale mode, busy', () => {
  const code = (o) => checkCommand({ ...base, pond: pond(), ...o }).code;
  assert.equal(code({ role: 'worker' }), 'role');
  assert.equal(code({ action: 'toggle' }), 'invalid_action');
  assert.equal(code({ gatewayOnline: false }), 'gateway_offline');
  assert.equal(code({ pond: pond({ mode: 'local' }) }), 'local_mode');
  assert.equal(code({ pond: pond({ mode: 'unknown', modeAt: null }) }), 'mode_unknown');
  assert.equal(code({ pond: pond({ modeAt: new Date(NOW - (MODE_FRESH_SEC + 5) * 1000).toISOString() }) }), 'state_stale');
  assert.equal(code({ busy: true }), 'busy');
});

test('stopping an aerator on low DO needs confirmation', () => {
  const low = pond({ metricStatus: { do: 'crit' } });
  assert.deepEqual(checkCommand({ ...base, pond: low }), { ok: false, code: 'low_do', needsConfirm: true });
  assert.deepEqual(checkCommand({ ...base, pond: low, confirmed: true }), { ok: true });
  assert.deepEqual(checkCommand({ ...base, action: 'on', pond: low }), { ok: true });
  assert.deepEqual(checkCommand({ ...base, device: { kind: 'pump' }, pond: low }), { ok: true });
});
