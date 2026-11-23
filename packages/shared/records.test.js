import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord, parseNumberInput, waterRefFlag, labFlag } from './records.js';

const NOW = Date.parse('2026-11-24T08:00:00Z');
const ID = '3f2a1c9e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const ok = (type, data) => validateRecord({ type, clientId: ID, data }, NOW);

test('valid records pass', () => {
  assert.deepEqual(ok('water', { unitId: 1, time: '2026-11-24T07:00:00Z', values: { alkalinity: 150, no2: 0.2 } }), []);
  assert.deepEqual(ok('feeding', { pondId: 3, fedAt: '2026-11-24T07:00:00Z', feedKg: 12.5, trayCheck: 'little' }), []);
  assert.deepEqual(ok('growth', { pondId: 3, sampledAt: '2026-11-24T07:00:00Z', abwG: 8.4, sampleCount: 50 }), []);
  assert.deepEqual(ok('lab', { unitId: 2, sampledAt: '2026-11-23T07:00:00Z', results: { vibrio_green: 20, ehp: 'neg' } }), []);
  assert.deepEqual(ok('cycle_start', { pondId: 3, stockedAt: '2026-11-24', stockedCount: 200000 }), []);
  assert.deepEqual(ok('cycle_end', { pondId: 3, cycleId: 9, status: 'harvested', endedAt: '2026-11-24', harvestKg: 1800 }), []);
  assert.deepEqual(ok('cycle_end', { pondId: 3, cycleId: 9, status: 'cancelled', endedAt: '2026-11-24' }), []);
});

test('invalid records are rejected with reasons', () => {
  assert.ok(ok('water', { unitId: 1, time: '2026-11-24T07:00:00Z', values: {} }).length, 'no values');
  assert.ok(ok('water', { unitId: 1, time: '2026-11-24T07:00:00Z', values: { salinity: 99 } }).length, 'out of range');
  assert.ok(ok('water', { unitId: 1, time: '2026-11-25T07:00:00Z', values: { salinity: 10 } }).length, 'future');
  assert.ok(ok('water', { unitId: 1, time: '2026-11-24T07:00:00Z', values: { bogus: 1 } }).length, 'unknown param');
  assert.ok(ok('feeding', { pondId: 3, fedAt: '2026-11-24T07:00:00Z', feedKg: NaN }).length, 'NaN kg');
  assert.ok(ok('lab', { unitId: 2, pondId: 3, sampledAt: '2026-11-23T07:00:00Z', results: { ehp: 'neg' } }).length, 'two targets');
  assert.ok(ok('lab', { unitId: 2, sampledAt: '2026-11-23T07:00:00Z', results: { ehp: 'maybe' } }).length, 'bad pcr');
  assert.ok(ok('cycle_end', { pondId: 3, cycleId: 9, status: 'harvested', endedAt: '2026-11-24' }).length, 'harvest kg required');
  assert.ok(validateRecord({ type: 'feeding', clientId: 'x', data: { pondId: 3, fedAt: '2026-11-24T07:00:00Z', feedKg: 1 } }, NOW).length, 'bad uuid');
  assert.ok(validateRecord({ type: 'nope', clientId: ID, data: {} }, NOW).length);
});

test('number input and flags', () => {
  assert.equal(parseNumberInput(' 1,500.5 '), 1500.5);
  assert.equal(parseNumberInput(''), null);
  assert.ok(Number.isNaN(parseNumberInput('abc')));
  assert.equal(waterRefFlag('alkalinity', 90), 'low');
  assert.equal(waterRefFlag('no2', 2), 'high');
  assert.equal(waterRefFlag('salinity', 15), null);
  assert.equal(labFlag('ehp', 'pos'), true);
  assert.equal(labFlag('vibrio_green', 50), false);
  assert.equal(labFlag('vibrio_green', 500), true);
});
