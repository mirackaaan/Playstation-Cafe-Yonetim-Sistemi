import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePriceForMinutes } from '../shared/pricing.mjs';

test('timed price cannot exceed the exact first-30-minute tariff before minute 30', () => {
  assert.equal(calculatePriceForMinutes(29, 150, 75, 10), 75);
  assert.equal(calculatePriceForMinutes(30, 150, 75, 10), 75);
  assert.equal(calculatePriceForMinutes(31, 150, 75, 10), 80);
});

test('timed prices stay nondecreasing across tariff and rounding combinations', () => {
  for (const hourly of [75, 100, 150, 225, 300]) {
    for (const first30 of [hourly / 2, hourly * 0.6, hourly * 0.8]) {
      for (const step of [1, 5, 10, 25]) {
        let previous = 0;
        for (let minute = 1; minute <= 240; minute++) {
          const amount = calculatePriceForMinutes(minute, hourly, first30, step);
          assert.ok(amount >= previous, `${hourly}/${first30}/${step}: ${minute - 1} dk ${previous} > ${minute} dk ${amount}`);
          previous = amount;
        }
        assert.equal(calculatePriceForMinutes(30, hourly, first30, step), first30);
        assert.equal(calculatePriceForMinutes(60, hourly, first30, step), hourly);
      }
    }
  }
});
