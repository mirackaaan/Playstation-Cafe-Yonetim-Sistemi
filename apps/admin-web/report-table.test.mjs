import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const exports = {};
const source = fs.readFileSync(new URL('./src/ReportTableTools.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const nativeRequire = createRequire(import.meta.url);
const requireControls = name => name === './SiteControls' ? { FilterIcon: () => null, SiteSelect: () => null, SiteDateTime: () => null } : nativeRequire(name);
vm.runInNewContext(compiled, { exports, require: requireControls });
const { filterReport, reportDuration, reportDeviceLabels, reportRevenueByDevice } = exports;
function tableRows(sessions, sort = null, initial) {
  const result = {};
  let stateIndex = 0;
  vm.runInNewContext(compiled, { exports: result, require: name => name === 'react' ? {
    useMemo: fn => fn(),
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useState: initial => [stateIndex++ === 7 ? sort : initial, () => {}],
  } : requireControls(name) });
  return Array.from(result.useReportTable(sessions, [], at, initial).filteredSessions, s => s.id);
}
const at = Date.parse('2026-09-27T15:00:00Z');
const row = { deviceId: 1, startedAt: '2026-09-27T12:00:00Z', endedAt: '2026-09-27T13:30:00Z', controllerCount: 3, targetMinutes: 60, ordersTotal: 50, totalAmount: 200, paymentMethod: 'nakit', ledgerPayments: [{ amount: 70, paymentMethod: 'nakit' }, { amount: 130, paymentMethod: 'kredi_karti' }] };
test('mixed payments match both payment filters, excluding refunded methods', () => {
  for (const method of ['nakit', 'kredi_karti', 'mixed']) assert.equal(filterReport(row, { method }, at), true);
  const refunded = { ...row, ledgerPayments: [...row.ledgerPayments, { amount: -70, paymentMethod: 'nakit' }] };
  assert.equal(filterReport(refunded, { method: 'nakit' }, at), false);
  assert.equal(filterReport(refunded, { method: 'mixed' }, at), false);
  assert.equal(filterReport(refunded, { method: 'kredi_karti' }, at), true);
});
test('duration matches displayed package cap, controller and range filters combine', () => {
  assert.equal(reportDuration(row, at), 60);
  assert.equal(filterReport(row, { durationMin: '60', durationMax: '60', controllers: '3', package: 'timed', orders: 'yes', ordersMin: '50', amountMax: '200' }, at), true);
  assert.equal(filterReport(row, { durationMin: '61' }, at), false);
  assert.equal(filterReport(row, { orders: 'no' }, at), false);
  assert.equal(filterReport(row, { controllers: '2' }, at), false);
  assert.equal(filterReport(row, { amountMin: '201' }, at), false);
});
test('open status, date boundaries and counter-sale exclusions', () => {
  const open = { ...row, endedAt: null };
  assert.equal(filterReport(open, { status: 'open' }, at), true);
  assert.equal(filterReport(open, { status: 'closed' }, at), false);
  assert.equal(filterReport(open, { endMin: '2026-09-27T00:00:00Z' }, at), false);
  assert.equal(filterReport(row, { endMin: row.endedAt, endMax: row.endedAt }, at), true);
  assert.equal(filterReport(row, { startMin: '2026-09-28T00:00:00Z' }, at), false);
  const sale = { ...row, deviceId: null };
  assert.equal(filterReport(sale, {}, at), true);
  assert.equal(filterReport(sale, { package: 'unlimited' }, at), false);
  assert.equal(filterReport(sale, { durationMax: '100' }, at), false);
});
test('default order puts open tables first then closing and sale times, without mutating input', () => {
  const sessions = [
    { ...row, id: 1, startedAt: '2026-09-27T10:00:00Z', endedAt: '2026-09-27T14:00:00Z' },
    { ...row, id: 2, endedAt: null },
    { ...row, id: -1, deviceId: null, startedAt: '2026-09-27T13:45:00Z', endedAt: '2026-09-27T13:45:00Z' },
    { ...row, id: 3 },
  ];
  assert.deepEqual(tableRows(sessions), [2, 1, -1, 3]);
  assert.deepEqual(tableRows(sessions, { column: 'end', direction: 1 }), [3, -1, 1, 2]);
  assert.deepEqual(tableRows(sessions, { column: 'end', direction: -1 }), [1, -1, 3, 2]);
  assert.deepEqual(sessions.map(s => s.id), [1, 2, -1, 3]);
});

test('same-name tables keep separate report labels and revenue totals by device ID', () => {
  const sessions = [
    { ...row, id: 10, deviceId: 1, deviceName: 'Masa 1', periodPayments: [{ amount: 50 }] },
    { ...row, id: 11, deviceId: 2, deviceName: 'Masa 1', periodPayments: [{ amount: 80 }] },
    { ...row, id: 12, deviceId: 1, deviceName: 'Masa 1', periodPayments: [{ amount: 20 }] },
  ];
  const labels = reportDeviceLabels(sessions, [{ id: 2, name: 'Masa 1' }]);
  assert.equal(labels.get('1'), 'Masa 1 · #1');
  assert.equal(labels.get('2'), 'Masa 1 · #2');
  assert.deepEqual(Array.from(reportRevenueByDevice(sessions), item => ({ name: item.name, ciro: item.ciro })), [
    { name: 'Masa 1 · #2', ciro: 80 },
    { name: 'Masa 1 · #1', ciro: 70 },
  ]);
  assert.equal(reportDeviceLabels([{ ...row, deviceId: 8, deviceName: null }]).get('8'), 'Silinmiş masa #8');
});

test('analytics drilldown opens only the selected table or product orders in its date range', () => {
  const sessions = [
    { ...row, id: 1, deviceId: 1, orderItems: [{ productName: 'Çay', createdAt: '2026-09-27T10:00:00Z' }] },
    { ...row, id: 2, deviceId: 2, orderItems: [{ productName: 'Çay', createdAt: '2026-09-26T10:00:00Z' }] },
    { ...row, id: 3, deviceId: 2, orderItems: [{ productName: 'Su', createdAt: '2026-09-27T10:00:00Z' }] },
  ];
  const range = { start: '2026-09-27T00:00:00Z', end: '2026-09-27T23:59:00Z' };
  assert.deepEqual(tableRows(sessions, null, { ...range, deviceId: '1' }), [1]);
  assert.deepEqual(tableRows(sessions, null, { ...range, productName: 'Çay' }), [1]);
});
