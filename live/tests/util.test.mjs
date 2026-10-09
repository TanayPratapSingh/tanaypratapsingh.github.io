import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt } from '../assets/util.js';

const MIN = 60e3, HOUR = 3600e3;

test('durations carry rounded minutes into the hour', () => {
  assert.equal(fmt.dur(2 * HOUR + 59.6 * MIN), '3 h');
  assert.equal(fmt.dur(2 * HOUR + 59.4 * MIN), '2 h 59 min');
  assert.equal(fmt.dur(59.6 * MIN), '1 h');
  assert.equal(fmt.dur(59.4 * MIN), '59 min');
  assert.equal(fmt.dur(-(59.6 * MIN)), '−1 h');
});

test('durations below a minute use seconds and milliseconds', () => {
  assert.equal(fmt.dur(850), '850 ms');
  assert.equal(fmt.dur(4200), '4.2 s');
  assert.equal(fmt.dur(42000), '42 s');
  assert.equal(fmt.ago(-5), '0 ms ago');
  assert.equal(fmt.dur(NaN), '–');
});
