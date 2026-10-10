import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateSessionSettlement } from './payment-allocation.mjs';

const payment = (amount, kind = 'partial', gameCredit = null) => ({ amount, kind, gameCredit, paymentMethod: 'nakit' });
const amounts = result => [result.paidGameAmount, result.paidOrdersAmount, result.freeGameAmount, result.freeOrdersAmount, result.unallocatedAmount];

test('general payment covers game first; free closure separates the remaining bill', () => {
  assert.deepEqual(amounts(allocateSessionSettlement(150, 50, [payment(50, 'partial', 50)], true)), [50, 0, 100, 50, 0]);
  assert.deepEqual(amounts(allocateSessionSettlement(150, 50, [], true)), [0, 0, 150, 50, 0]);
  assert.deepEqual(amounts(allocateSessionSettlement(150, 50, [payment(50, 'partial', 50), payment(150, 'checkout')], false)), [150, 50, 0, 0, 0]);
});

test('explicit order payment stays with orders while later game charges are added', () => {
  assert.deepEqual(amounts(allocateSessionSettlement(180, 50, [payment(50, 'orders')], true)), [0, 50, 180, 0, 0]);
  assert.deepEqual(amounts(allocateSessionSettlement(180, 50, [payment(100, 'partial', 75)], true)), [75, 25, 105, 25, 0]);
});

test('refunds reduce actual collected cash and never create a paid amount above the bill', () => {
  assert.deepEqual(amounts(allocateSessionSettlement(50, 0, [payment(100, 'prepaid'), payment(-50, 'refund')], false)), [50, 0, 0, 0, 0]);
  assert.deepEqual(amounts(allocateSessionSettlement(100, 50, [payment(50, 'orders'), payment(150, 'checkout'), payment(-50, 'undo')], false)), [100, 50, 0, 0, 0]);
});
