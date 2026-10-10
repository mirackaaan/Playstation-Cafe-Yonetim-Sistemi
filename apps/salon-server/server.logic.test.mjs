import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { attachExpectedSession } from './attach-expected-session.mjs';

test('payment ledger, tariff snapshots, report periods and persistent login', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-logic-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const clockFile = path.join(temp, 'clock.txt');
  const clockModule = path.join(temp, 'clock.mjs');
  let current = Date.parse('2026-09-26T12:00:00+03:00');
  const clock = value => { current = Date.parse(value); fs.writeFileSync(clockFile, String(current)); };
  clock('2026-09-26T12:00:00+03:00');
  fs.writeFileSync(clockModule, `import fs from 'node:fs'; const RealDate=Date; const time=()=>Number(fs.readFileSync(process.env.TEST_CLOCK,'utf8')); globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time()]));} static now(){return time();}};`);
  const port = 35000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  let child, token, serial = 0, stderr = '';
  async function stopServer() {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  }
  async function startServer() {
    child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'server.mjs'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, PORT: String(port), SALON_DB_PATH: dbPath, SALON_ADMIN_PASSWORD: 'logic-test', TEST_CLOCK: clockFile, TZ: 'Europe/Istanbul' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    throw new Error('Server unavailable: ' + stderr);
  }
  t.after(async () => { await stopServer(); fs.rmSync(temp, { recursive: true, force: true }); });
  async function api(endpoint, method = 'GET', body, expected) {
    body = await attachExpectedSession(base, token, endpoint, method, body);
    const response = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = response.status === 204 ? null : await response.json();
    if (expected) assert.equal(response.status, expected, JSON.stringify(data));
    else assert.ok(response.ok, endpoint + ': ' + JSON.stringify(data));
    return data;
  }
  const post = (p,b,e) => api(p,'POST',b,e);
  const put = (p,b,e) => api(p,'PUT',b,e);
  const category = (rate, first) => post('/api/categories', { name: `Tariff ${++serial}`, baseRate: rate, first30Rate: first });
  const table = c => post('/api/devices', { name: `Table ${++serial}`, categoryId: c.id });
  const start = (d, opts = {}) => post(`/api/devices/${d.id}/start`, { controllerCount: 2, ...opts });
  const close = (d, paymentMethod = 'nakit') => post(`/api/devices/${d.id}/stop`, { paymentMethod });
  const summary = () => api('/api/summary');
  const reports = (date = '2026-09-26') => api(`/api/reports?startDate=${date}T00:00&endDate=${date}T23:59`);
  const report = async (id,date) => (await reports(date)).sessions.find(s => s.id === id);
  const revenue = report => Math.round(report.sessions.reduce((sum,s) => sum + s.periodPayments.filter(p => p.paymentMethod !== 'ucretsiz').reduce((sum,p) => sum + p.amount,0),0) * 100) / 100;
  await startServer();
  token = (await post('/api/auth/login', { password: 'logic-test' })).token;
  const c = await category(100,50), d = await table(c);

  await t.test('backdated start rejects invalid times without opening the table; accepts12hour boundary', async () => {
    for (const [startedAt, message] of [
      [new Date(current - 12 * 60 * 60 * 1000 - 1).toISOString(), /12 saat/],
      [new Date(current + 60000).toISOString(), /gelecekte/],
      ['invalid-date', /geçersiz/],
    ]) {
      const error = await post(`/api/devices/${d.id}/start`, { controllerCount: 2, startedAt }, 400);
      assert.match(error.error, message);
    }
    const startedAt = new Date(current - 12 * 60 * 60 * 1000).toISOString();
    const opened = await start(d, { startedAt });
    assert.equal(opened.activeSession.startedAt, startedAt);
    await close(d);
  });

  await t.test('prepayment is collected now, checkout cannot count it twice', async () => {
    const before = (await summary()).dailyRevenue;
    const s = (await start(d, { targetMinutes: 60, isPaid: true, paymentMethod: 'kredi_karti' })).activeSession;
    assert.equal((await summary()).dailyRevenue-before, 100);
    assert.deepEqual((await report(s.id)).periodPayments.map(p => [p.amount,p.paymentMethod,p.kind]), [[100,'kredi_karti','prepaid']]);
    await close(d);
    assert.equal((await summary()).dailyRevenue-before, 100);
    assert.equal((await report(s.id)).periodPayments.length,1);
  });

  await t.test('free close keeps the full game and order bill while recording the unpaid part separately', async () => {
    const before = (await summary()).dailyRevenue;
    const s = (await start(d, { targetMinutes: 90 })).activeSession;
    await post(`/api/sessions/${s.id}/orders`, { productName: 'Su', unitPrice: 50, quantity: 1 }, 201);
    await post(`/api/sessions/${s.id}/payments`, { amount: 50, paymentMethod: 'nakit' }, 201);
    const closed = await close(d, 'ucretsiz');
    assert.equal(closed.timeAmount, 150);
    assert.equal(closed.ordersTotal, 50);
    assert.equal(closed.amount, 200);
    const r = await report(s.id);
    assert.equal(r.totalAmount, 200);
    assert.equal(r.timeAmount, 150);
    assert.equal(r.closureMethod, 'ucretsiz');
    assert.deepEqual([r.paidGameAmount, r.paidOrdersAmount, r.freeGameAmount, r.freeOrdersAmount], [50, 0, 100, 50]);
    assert.deepEqual(r.ledgerPayments.map(p => [p.amount, p.paymentMethod, p.kind]), [[50, 'nakit', 'partial'], [150, 'ucretsiz', 'waiver']]);
    assert.equal((await summary()).dailyRevenue - before, 50);
    await post(`/api/devices/${d.id}/undo`);
    assert.equal((await report(s.id)).paidGameAmount, null);
    assert.equal((await summary()).dailyRevenue - before, 50);
    assert.equal((await report(s.id)).ledgerPayments.filter(p => p.paymentMethod === 'ucretsiz').reduce((sum, p) => sum + p.amount, 0), 0);
    await close(d);
    assert.equal((await report(s.id)).closureMethod, 'nakit');
    const settled = await report(s.id);
    assert.deepEqual([settled.paidGameAmount, settled.paidOrdersAmount, settled.freeGameAmount, settled.freeOrdersAmount], [150, 50, 0, 0]);
  });

  await t.test('free close after prepayment keeps the original cash method when reopened', async () => {
    const before = (await summary()).dailyRevenue;
    const s = (await start(d, { targetMinutes: 60, isPaid: true, paymentMethod: 'kredi_karti' })).activeSession;
    await post(`/api/sessions/${s.id}/orders`, { productName: 'Çay', unitPrice: 50, quantity: 1 }, 201);
    await close(d, 'ucretsiz');
    const r = await report(s.id);
    assert.equal(r.totalAmount, 150);
    assert.equal(r.paymentMethod, 'ucretsiz');
    assert.deepEqual(r.ledgerPayments.map(p => [p.amount, p.paymentMethod]), [[100, 'kredi_karti'], [50, 'ucretsiz']]);
    assert.equal((await summary()).dailyRevenue - before, 100);
    const reopened = await post(`/api/devices/${d.id}/undo`);
    assert.equal(reopened.device.activeSession.paymentMethod, 'kredi_karti');
    await close(d);
  });

  await t.test('duration reduction records an automatic refund in the original method', async () => {
    const before = (await summary()).dailyRevenue;
    const s = (await start(d, { targetMinutes: 60, isPaid: true, paymentMethod: 'kredi_karti' })).activeSession;
    await put(`/api/sessions/${s.id}`, { targetMinutes: 30 });
    const settled = await close(d,'nakit');
    assert.equal(settled.refundAmount,50);
    assert.equal((await summary()).dailyRevenue-before,50);
    const r = await report(s.id);
    assert.equal(r.totalAmount,50);
    assert.deepEqual(r.periodPayments.map(p => [p.amount,p.paymentMethod]), [[100,'kredi_karti'],[-50,'kredi_karti']]);
    await post(`/api/devices/${d.id}/undo`);
    assert.equal((await summary()).dailyRevenue-before,100);
    await close(d);
    assert.equal((await summary()).dailyRevenue-before,50);
  });

  await t.test('mixed partial payments are refunded once and keep their methods', async () => {
    const s = (await start(d,{targetMinutes:60})).activeSession;
    await post(`/api/sessions/${s.id}/payments`,{amount:60,paymentMethod:'nakit'});
    await post(`/api/sessions/${s.id}/payments`,{amount:40,paymentMethod:'kredi_karti'});
    await put(`/api/sessions/${s.id}`,{targetMinutes:30});
    await close(d);
    const totals = (await report(s.id)).periodPayments.reduce((a,p) => {a[p.paymentMethod]=(a[p.paymentMethod]||0)+p.amount;return a;},{});
    assert.deepEqual(totals,{nakit:10,kredi_karti:40});
    await post(`/api/devices/${d.id}/stop`,{paymentMethod:'nakit'},400);
    assert.equal((await report(s.id)).ledgerPayments.filter(p=>p.kind==='refund').length,1);
  });

  await t.test('same-tariff transfers preserve deadline and rounding state', async () => {
    const same = await category(300,100), a = await table(same), b = await table(same);
    await put('/api/settings/rounding-step',{roundingStep:7});
    const original = (await start(a,{targetMinutes:60,startedAt:new Date(current-20*60000).toISOString()})).activeSession;
    let moved = (await post(`/api/devices/${a.id}/transfer`,{targetDeviceId:b.id})).target.activeSession;
    assert.equal(moved.targetMinutes,60);
    assert.equal(moved.startedAt,original.startedAt);
    assert.equal(moved.segmentStartedAt,original.segmentStartedAt);
    moved=(await post(`/api/devices/${b.id}/transfer`,{targetDeviceId:a.id})).target.activeSession;
    assert.equal(moved.targetMinutes,60);
    assert.equal((await close(a)).timeAmount,300);
    await put('/api/settings/rounding-step',{roundingStep:1});
  });

  await t.test('timed controller change splits the first30 proportionally', async () => {
    const s = (await start(d,{targetMinutes:30,startedAt:new Date(current-10*60000).toISOString()})).activeSession;
    const updated = (await put(`/api/sessions/${s.id}`,{controllerCount:4})).activeSession;
    assert.equal(updated.hourlyRate,200);
    assert.equal(updated.first30Rate,100);
    assert.equal((await close(d)).timeAmount,84);
  });

  await t.test('open-session tariff survives category edits and duration/controller edits', async () => {
    const cat=await category(100,50), a=await table(cat);
    const s=(await start(a,{targetMinutes:60})).activeSession;
    await put(`/api/categories/${cat.id}`,{name:cat.name,baseRate:200,first30Rate:100});
    let updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:90})).activeSession;
    assert.equal(updated.hourlyRate,100);
    assert.equal(updated.first30Rate,50);
    assert.equal((await report(s.id)).timeAmount,150);
    updated=(await put(`/api/sessions/${s.id}`,{controllerCount:3})).activeSession;
    assert.equal(updated.hourlyRate,150);
    assert.equal(updated.first30Rate,75);
    await close(a);
    updated=(await start(a,{targetMinutes:60})).activeSession;
    assert.equal(updated.hourlyRate,200);
    await close(a);
  });

  await t.test('conversion quote matches actual prepaid charge after transfer', async () => {
    const dear=await table(await category(200,100));
    const s=(await start(d,{startedAt:new Date(current-10*60000).toISOString()})).activeSession;
    await post(`/api/devices/${d.id}/transfer`,{targetDeviceId:dear.id});
    const quote=await post(`/api/sessions/${s.id}/quote`,{targetMinutes:60});
    assert.equal(quote.timeAmount,184);
    const byPrice=await post(`/api/sessions/${s.id}/quote`,{targetPrice:200});
    assert.ok(byPrice.timeAmount<=200);
    assert.equal((await post(`/api/sessions/${s.id}/quote`,{targetMinutes:byPrice.targetMinutes})).timeAmount,byPrice.timeAmount);
    const updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:quote.targetMinutes,isPaid:true,paymentMethod:'nakit'})).activeSession;
    assert.equal(updated.prepaidAmount,quote.timeAmount);
    assert.equal((await close(dear)).timeAmount,quote.timeAmount);
  });

  await t.test('zero opening fee is rejected on create and edit', async () => {
    await post('/api/categories',{name:'Zero',baseRate:300,first30Rate:0},400);
    await put(`/api/categories/${c.id}`,{name:c.name,baseRate:100,first30Rate:0},400);
  });

  await t.test('product cents and direct sale item totals are consistent', async () => {
    const s=(await start(d)).activeSession;
    const orders=await post(`/api/sessions/${s.id}/orders`,{productName:'Tea',unitPrice:15.5,quantity:1});
    assert.equal(orders[0].totalPrice,15.5);
    const sale=await post('/api/direct-sales',{paymentMethod:'nakit',items:[{productName:'A',unitPrice:15.5,quantity:1},{productName:'B',unitPrice:15.5,quantity:1}]});
    const r=await report(-sale.saleId);
    assert.equal(r.totalAmount,31);
    assert.equal(r.orderItems.reduce((sum,p)=>sum+p.totalPrice,0),31);
    await close(d);
    assert.equal(revenue(await reports()),(await summary()).dailyRevenue);
  });

  await t.test('midnight receipts, refunds and last-minute sales use actual payment dates', async () => {
    clock('2026-09-27T23:59:30+03:00');
    const s=(await start(d,{targetMinutes:60,isPaid:true,paymentMethod:'nakit'})).activeSession;
    await post('/api/direct-sales',{paymentMethod:'nakit',items:[{productName:'Late',unitPrice:10,quantity:1}]});
    assert.equal(revenue(await reports('2026-09-27')),110);
    clock('2026-09-28T00:30:00+03:00');
    await put(`/api/sessions/${s.id}`,{targetMinutes:30});
    await close(d);
    assert.equal(revenue(await reports('2026-09-27')),110);
    assert.equal(revenue(await reports('2026-09-28')),-50);
    assert.equal((await summary()).dailyRevenue,-50);
    const next=(await start(d,{targetMinutes:60})).activeSession;
    await post(`/api/sessions/${next.id}/payments`,{amount:30,paymentMethod:'nakit'});
    clock('2026-09-29T00:01:00+03:00');
    await close(d,'kredi_karti');
    assert.equal((await report(next.id,'2026-09-28')).periodPayments.reduce((sum,p)=>sum+p.amount,0),30);
    assert.equal(revenue(await reports('2026-09-29')),70);
  });

  await t.test('reports include all501 sales and agree with dashboard', async () => {
    clock('2026-09-30T12:00:00+03:00');
    for(let i=0;i<501;i++) await post('/api/direct-sales',{paymentMethod:'nakit',items:[{productName:'Limit',unitPrice:1,quantity:1}]});
    const all=await reports('2026-09-30');
    assert.equal(all.sessions.length,501);
    assert.equal(revenue(all),501);
    assert.equal((await summary()).dailyRevenue,501);
  });

  await t.test('session history preserves transfers, tariff snapshots and payments after log deletion and restart', async () => {
    const original = await category(120,60), destination = await category(240,120);
    const a = await table(original), b = await table(destination), same = await table(destination);
    const opened = await start(a, { targetMinutes:60 });
    const id = opened.activeSession.id;
    const history = () => api(`/api/sessions/${id}/history`);
    assert.equal((await history()).complete,true);
    await put(`/api/sessions/${id}`,{controllerCount:4});
    await put(`/api/sessions/${id}`,{targetMinutes:90});
    await post(`/api/sessions/${id}/payments`,{amount:30,paymentMethod:'nakit'});
    await post(`/api/devices/${a.id}/transfer`,{targetDeviceId:b.id});
    await post(`/api/devices/${b.id}/transfer`,{targetDeviceId:same.id});
    await close(same,'kredi_karti');
    const result = await history();
    assert.deepEqual(result.events.filter(e=>e.type!=='payment').map(e=>e.type),['start','update','update','transfer','transfer','close']);
    const transfers=result.events.filter(e=>e.type==='transfer');
    assert.equal(transfers[0].before.hourlyRate,240);
    assert.equal(transfers[0].after.hourlyRate,480);
    assert.equal(transfers[0].before.deviceName,a.name);
    assert.equal(transfers[0].after.deviceName,b.name);
    assert.equal(transfers[1].before.targetMinutes,transfers[1].after.targetMinutes);
    assert.ok(result.events.some(e=>e.type==='payment' && e.message.includes('30.00') && e.message.includes('Nakit')));
    await put(`/api/categories/${destination.id}`,{name:destination.name,baseRate:999,first30Rate:500});
    for(const log of await api('/api/logs')) await api(`/api/logs/${log.id}`,'DELETE',undefined,200);
    await stopServer(); await startServer();
    assert.deepEqual(await history(),result);
    await post(`/api/devices/${same.id}/undo`);
    assert.ok((await history()).events.some(e=>e.type==='reopen'));
    await close(same);
    await api('/api/sessions/999999/history','GET',undefined,404);
  });

  await t.test('login survives8hours and server restart, logout revokes it', async () => {
    clock('2026-10-10T12:00:00+03:00');
    await summary();
    await stopServer(); await startServer();
    await summary();
    await post('/api/auth/logout');
    await api('/api/summary','GET',undefined,401);
    token=(await post('/api/auth/login',{password:'logic-test'})).token;
  });

  await t.test('legacy migration preserves closed totals and runs only once', async () => {
    // Replace only this test's temporary DB with an old-style financial fixture.
    await stopServer();
    const SQL=await initSqlJs(); const db=new SQL.Database(fs.readFileSync(dbPath));
    db.run('DELETE FROM session_events; DELETE FROM session_payments; DELETE FROM order_items; DELETE FROM sessions; DELETE FROM direct_sale_items; DELETE FROM direct_sales;');
    db.run("DELETE FROM settings WHERE key='payment_ledger_v1'");
    const date='2026-10-10T09:00:00.000Z';
    db.run("INSERT INTO sessions(id,device_id,started_at,ended_at,hourly_rate,first_30_rate,target_minutes,is_paid,payment_method,prepaid_amount,total_amount) VALUES (9001,?,?,?,100,50,60,1,'nakit',100,50)",[d.id,date,date]);
    db.run("INSERT INTO sessions(id,device_id,started_at,hourly_rate,first_30_rate,target_minutes,is_paid,payment_method,prepaid_amount) VALUES (9002,?,?,100,50,60,1,'kredi_karti',100)",[d.id,date]);
    fs.writeFileSync(dbPath,Buffer.from(db.export())); db.close();
    await startServer();
    assert.equal((await summary()).dailyRevenue,150);
    assert.equal(revenue(await reports('2026-10-10')),150);
    await stopServer(); await startServer();
    assert.equal((await summary()).dailyRevenue,150);
    const migrated=(await reports('2026-10-10')).sessions;
    assert.ok(migrated.every(s=>s.ledgerPayments.every(p=>p.timestampEstimated===1)));
  });

  await t.test('old free closure with a partial receipt is repaired once on startup', async () => {
    await stopServer();
    const SQL = await initSqlJs(); const db = new SQL.Database(fs.readFileSync(dbPath));
    const date = '2026-10-10T09:00:00.000Z';
    db.run("INSERT INTO sessions(id,device_id,started_at,ended_at,hourly_rate,first_30_rate,target_minutes,payment_method,total_amount) VALUES (9003,?,?,?,100,50,60,'ucretsiz',50)", [d.id, date, '2026-10-10T10:00:00.000Z']);
    db.run("INSERT INTO session_payments(session_id,amount,payment_method,created_at,kind) VALUES (9003,50,'nakit',?,'partial')", [date]);
    db.run("INSERT INTO order_items(session_id,product_name,unit_price,quantity,total_price,created_at) VALUES (9003,'Su',50,1,50,?)", [date]);
    fs.writeFileSync(dbPath, Buffer.from(db.export())); db.close();
    await startServer();
    let repaired = (await reports('2026-10-10')).sessions.find(s => s.id === 9003);
    assert.equal(repaired.totalAmount, 150);
    assert.deepEqual(repaired.ledgerPayments.map(p => [p.amount, p.paymentMethod]), [[50, 'nakit'], [100, 'ucretsiz']]);
    assert.equal((await summary()).dailyRevenue, 200);
    await stopServer(); await startServer();
    repaired = (await reports('2026-10-10')).sessions.find(s => s.id === 9003);
    assert.equal(repaired.ledgerPayments.length, 2);
  });

  await t.test('reports retain orphaned sessions and distinguish a new table with the same name', async () => {
    await stopServer();
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));
    db.run('PRAGMA foreign_keys = OFF');
    db.run('DELETE FROM devices');
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    await startServer();

    const orphanReport = await reports('2026-10-10');
    const oldClosed = orphanReport.sessions.find(s => s.id === 9001);
    const oldOpen = orphanReport.sessions.find(s => s.id === 9002);
    assert.equal(oldClosed.deviceId, d.id);
    assert.equal(oldClosed.deviceName, d.name);
    assert.equal(oldOpen.deviceName, `Silinmiş masa #${d.id}`);
    assert.equal(revenue(orphanReport), 200);

    const replacement = await post('/api/devices', { name: d.name, categoryId: c.id }, 201);
    assert.notEqual(replacement.id, d.id);
    await start(replacement, { targetMinutes: 60 });
    await close(replacement);
    const combined = await reports('2026-10-10');
    assert.ok(combined.sessions.some(s => s.deviceId === d.id && s.deviceName === d.name));
    assert.ok(combined.sessions.some(s => s.deviceId === replacement.id && s.deviceName === d.name));
    assert.equal(revenue(combined), 300);
  });
});
