import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
const source = fs.readFileSync(new URL('./src/AnalyticsTools.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
vm.runInNewContext(compiled, { exports, require: name => name === './ReportTableTools' ? { reportDeviceLabels: sessions => new Map(sessions.filter(s => s.deviceId != null).map(s => [String(s.deviceId), s.deviceName])) } : {} });
const { analyticsOverview, analyticsProducts, analyticsTables, analyticsTimeline } = exports;

const start = '2026-09-28T00:00';
const end = '2026-09-29T23:59';
const sessions = [
  { deviceId: 1, deviceName: 'Masa 1', startedAt: '2026-09-28T10:00:00', endedAt: '2026-09-28T11:00:00', closedInPeriod: true, totalAmount: 100, ordersTotal: 40, paymentMethod: 'nakit', periodPayments: [{ amount: 100, createdAt: '2026-09-28T10:30:00' }], orderItems: [{ productName: 'Çay', quantity: 2, totalPrice: 40, createdAt: '2026-09-28T10:15:00' }, { productName: 'Tost', quantity: 1, totalPrice: 70, createdAt: '2026-09-27T19:00:00' }] },
  { deviceId: 2, deviceName: 'Masa 2', startedAt: '2026-09-29T10:00:00', endedAt: null, periodPayments: [{ amount: 30, createdAt: '2026-09-29T10:30:00' }], orderItems: [{ productName: 'Çay', quantity: 1, totalPrice: 20, createdAt: '2026-09-29T10:20:00' }] },
  { deviceId: null, deviceName: 'Direkt Adisyon Satışı', startedAt: '2026-09-29T12:00:00', endedAt: '2026-09-29T12:00:00', periodPayments: [{ amount: 20, createdAt: '2026-09-29T12:00:00' }], orderItems: [{ productName: 'Su', quantity: 1, totalPrice: 20, createdAt: '2026-09-29T12:00:00' }] },
];

test('analytics summaries use period receipts, exclude counter from table ranking, and scope products by order time', () => {
  const overview = analyticsOverview(sessions, start, end, Date.parse('2026-09-29T11:00:00'));
  assert.equal(overview.tahsilat, 150);
  assert.equal(overview.closedCount, 1);
  assert.equal(overview.averageBill, 100);
  assert.equal(overview.playMinutes, 120);
  const tables = analyticsTables(sessions);
  assert.deepEqual(Array.from(tables, item => [item.name, item.ciro]), [['Masa 1', 60]]);
  const products = analyticsProducts(sessions, start, end);
  assert.deepEqual(Array.from(products, item => [item.name, item.quantity, item.amount]), [['Çay', 3, 60], ['Su', 1, 20]]);
});

test('multi-day timeline keeps dates separate and measures occupied table time', () => {
  const result = analyticsTimeline(sessions, start, end, Date.parse('2026-09-29T14:00:00'));
  assert.equal(result.granularity, 'day');
  assert.deepEqual(Array.from(result.points, point => [point.key, point.tahsilat]), [['2026-09-28', 100], ['2026-09-29', 50]]);
  assert.ok(result.points[0].doluMasa > 0);
  assert.ok(result.points[1].doluMasa > 0);
});

test('hourly timeline includes zero-payment intervals', () => {
  const result = analyticsTimeline([sessions[0]], '2026-09-28T09:00', '2026-09-28T11:59', Date.parse('2026-09-28T12:00:00'));
  assert.deepEqual(Array.from(result.points, point => point.tahsilat), [0, 100, 0]);
  assert.deepEqual(Array.from(result.points, point => point.doluMasa), [0, 1, 0]);
});

test('free closure is a report payment but never cash revenue or game ranking', () => {
  const free = {
    deviceId: 3, deviceName: 'Masa 3', startedAt: '2026-09-29T10:00:00', endedAt: '2026-09-29T11:00:00',
    closedInPeriod: true, closureMethod: 'ucretsiz', paymentMethod: 'ucretsiz', totalAmount: 200, ordersTotal: 50,
    periodPayments: [
      { amount: 50, paymentMethod: 'nakit', createdAt: '2026-09-29T10:30:00' },
      { amount: 150, paymentMethod: 'ucretsiz', createdAt: '2026-09-29T11:00:00' },
    ],
  };
  const overview = analyticsOverview([free], start, end);
  assert.equal(overview.tahsilat, 50);
  assert.equal(analyticsTables([free]).length, 0);
  const timeline = analyticsTimeline([free], start, end, Date.parse('2026-09-29T12:00:00'));
  assert.equal(timeline.points.find(point => point.key === '2026-09-29').tahsilat, 50);
});
