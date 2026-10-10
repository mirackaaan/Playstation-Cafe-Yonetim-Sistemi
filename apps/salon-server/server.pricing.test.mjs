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

test('explicit controller tariffs, backdating and live rounding', async t => {
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
  const revenue = report => Math.round(report.sessions.reduce((sum,s) => sum + s.periodPayments.reduce((sum,p) => sum + p.amount,0),0) * 100) / 100;
  await startServer();
  token = (await post('/api/auth/login', { password: 'logic-test' })).token;
  const c = await category(100,50), d = await table(c);

  await t.test('split collection commits every method together and keeps one report session', async () => {
    const a = await table(c);
    const first = (await start(a, { targetMinutes: 60 })).activeSession;
    await post(`/api/sessions/${first.id}/orders`, { productName: 'Drink', quantity: 1, unitPrice: 20 }, 201);
    await put(`/api/sessions/${first.id}`, { isPaid: true, paymentMethod: 'nakit', includeOrders: true, expectedAmount: 120, payments: [
      { amount: 50, paymentMethod: 'nakit' }, { amount: 70, paymentMethod: 'kredi_karti' },
    ] });
    const paid = (await api('/api/devices')).find(item => item.id === a.id).activeSession;
    assert.equal(paid.collectedAmount, 120);
    assert.equal(paid.gamePaymentCredit, 100);
    assert.deepEqual(paid.ledgerPayments.map(p => [p.amount, p.paymentMethod, p.kind]), [[50, 'nakit', 'prepaid'], [50, 'kredi_karti', 'prepaid'], [20, 'kredi_karti', 'orders']]);
    await close(a);
    assert.equal((await reports()).sessions.filter(s => s.id === first.id).length, 1);
    await post(`/api/devices/${a.id}/undo`, {});
    const reopened = (await api('/api/devices')).find(item => item.id === a.id).activeSession;
    assert.equal(reopened.collectedAmount, 120);
    assert.equal(reopened.ledgerPayments.filter(p => p.paymentMethod === 'nakit').reduce((sum, p) => sum + p.amount, 0), 50);
    assert.equal(reopened.ledgerPayments.filter(p => p.paymentMethod === 'kredi_karti').reduce((sum, p) => sum + p.amount, 0), 70);
    await close(a);

    const second = (await start(a, { targetMinutes: 60 })).activeSession;
    await post(`/api/sessions/${second.id}/orders`, { productName: 'Drink', quantity: 1, unitPrice: 20 }, 201);
    await post(`/api/devices/${a.id}/stop`, { paymentMethod: 'nakit', payments: [
      { amount: 45, paymentMethod: 'nakit' }, { amount: 74, paymentMethod: 'kredi_karti' },
    ] }, 409);
    assert.equal((await api('/api/devices')).find(item => item.id === a.id).activeSession.id, second.id);
    assert.equal((await report(second.id)).ledgerPayments.length, 0);
    await post(`/api/devices/${a.id}/stop`, { paymentMethod: 'nakit', payments: [
      { amount: 45, paymentMethod: 'nakit' }, { amount: 75, paymentMethod: 'kredi_karti' },
    ] });
    const closed = await report(second.id);
    assert.deepEqual(closed.ledgerPayments.map(p => [p.amount, p.paymentMethod, p.kind]), [[45, 'nakit', 'checkout'], [75, 'kredi_karti', 'checkout']]);
    assert.equal((await reports()).sessions.filter(s => s.id === second.id).length, 1);
  });

  await t.test('unpaid causes separate paid orders, time and controllers, including partial receipts', async () => {
    const cat=await post('/api/categories',{name:'Payment causes',baseRate:150,first30Rate:75,rate3:225,first30Rate3:110,rate4:300,first30Rate4:150});
    const a=await table(cat), s=(await start(a,{targetMinutes:60})).activeSession;
    const currentSession=async()=> (await api('/api/devices')).find(x=>x.id===a.id).activeSession;
    await post(`/api/sessions/${s.id}/orders`,{productName:'Food',quantity:1,unitPrice:135},201);
    await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:'nakit',includeOrders:true,expectedAmount:285});
    await post(`/api/sessions/${s.id}/orders`,{productName:'New food',quantity:1,unitPrice:85},201);
    let updated=await currentSession();
    assert.equal(updated.gamePaymentCredit,150);
    assert.equal(updated.gameAmount-updated.gamePaymentCredit,0);
    assert.equal(updated.gameAmount+updated.ordersTotal-updated.collectedAmount,85);
    assert.deepEqual(updated.paymentDifferenceReasons,[]);
    updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:90})).activeSession;
    assert.deepEqual(updated.paymentDifferenceReasons,['Ek Süre']);
    updated=(await put(`/api/sessions/${s.id}`,{controllerCount:4})).activeSession;
    assert.deepEqual(updated.paymentDifferenceReasons,['Ek Süre','Kol Artışı']);
    await close(a);

    const second=(await start(a,{targetMinutes:60})).activeSession;
    await post(`/api/sessions/${second.id}/orders`,{productName:'Food',quantity:1,unitPrice:135},201);
    await post(`/api/sessions/${second.id}/payments`,{amount:285,paymentMethod:'nakit'},201);
    updated=(await put(`/api/sessions/${second.id}`,{controllerCount:4})).activeSession;
    assert.equal(updated.gamePaymentCredit,150);
    assert.deepEqual(updated.paymentDifferenceReasons,['Kol Artışı']);
    await post(`/api/sessions/${second.id}/payments`,{amount:updated.gameAmount-150,paymentMethod:'kredi_karti'},201);
    await post(`/api/sessions/${second.id}/orders`,{productName:'New food',quantity:1,unitPrice:85},201);
    updated=await currentSession();
    assert.equal(updated.gamePaymentCredit,updated.gameAmount);
    assert.deepEqual(updated.paymentDifferenceReasons,[]);
    assert.equal(updated.gameAmount+updated.ordersTotal-updated.collectedAmount,85);
    await close(a);
  });

  await t.test('optional orders payment stays collected through checkout, new charges and undo', async () => {
    const cat=await category(150,75);
    for(const method of ['nakit','kredi_karti']) {
      const a=await table(cat), s=(await start(a,{targetMinutes:60})).activeSession;
      await post(`/api/sessions/${s.id}/orders`,{productName:'Food',quantity:1,unitPrice:135},201);
      await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:method,includeOrders:true,expectedAmount:150},409);
      let updated=(await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:method,includeOrders:true,expectedAmount:285})).activeSession;
      assert.equal(updated.collectedAmount,285);assert.equal(updated.prepaidAmount,150);
      assert.equal(updated.ordersTotal,135);assert.equal(updated.ledgerPayments.find(p=>p.kind==='orders').paymentMethod,method);
      await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:method,includeOrders:true,expectedAmount:285},409);
      await close(a);
      let row=await report(s.id);
      assert.equal(row.checkoutAmount,0);assert.equal(row.ledgerPayments.reduce((sum,p)=>sum+p.amount,0),285);
      assert.deepEqual([row.paidGameAmount,row.paidOrdersAmount,row.freeGameAmount,row.freeOrdersAmount],[150,135,0,0]);
      await post(`/api/devices/${a.id}/undo`);
      await post(`/api/sessions/${s.id}/orders`,{productName:'Tea',quantity:1,unitPrice:20},201);
      updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:90})).activeSession;
      assert.equal(updated.collectedAmount,285);assert.equal(updated.gameAmount+updated.ordersTotal-updated.collectedAmount,95);
      await close(a,'nakit');row=await report(s.id);
      assert.equal(row.checkoutAmount,95);assert.equal(row.ledgerPayments.reduce((sum,p)=>sum+p.amount,0),380);
      assert.deepEqual([row.paidGameAmount,row.paidOrdersAmount,row.freeGameAmount,row.freeOrdersAmount],[225,155,0,0]);
      await post(`/api/devices/${a.id}/undo`);
      const reopened=(await api('/api/devices')).find(x=>x.id===a.id).activeSession;
      assert.equal(reopened.collectedAmount,285);await close(a);
    }
    const a=await table(cat), s=(await start(a,{targetMinutes:60})).activeSession;
    await post(`/api/sessions/${s.id}/orders`,{productName:'Food',quantity:1,unitPrice:135},201);
    const updated=(await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:'nakit',includeOrders:false,expectedAmount:150})).activeSession;
    assert.equal(updated.collectedAmount,150);assert.equal(updated.ordersTotal,135);
    assert.equal(updated.ledgerPayments.some(p=>p.kind==='orders'),false);
    await close(a,'kredi_karti');assert.equal((await report(s.id)).checkoutAmount,135);
  });

  await t.test('free close after dedicated order payment waives only the new game charge', async () => {
    const cat = await category(150, 75), a = await table(cat);
    const s = (await start(a, { targetMinutes: 60 })).activeSession;
    await post(`/api/sessions/${s.id}/orders`, { productName: 'Food', quantity: 1, unitPrice: 50 }, 201);
    await put(`/api/sessions/${s.id}`, { isPaid: true, paymentMethod: 'nakit', includeOrders: true, expectedAmount: 200 });
    await put(`/api/sessions/${s.id}`, { targetMinutes: 90 });
    await close(a, 'ucretsiz');
    const closed = await report(s.id);
    assert.deepEqual([closed.paidGameAmount, closed.paidOrdersAmount, closed.freeGameAmount, closed.freeOrdersAmount], [150, 50, 75, 0]);
    assert.equal(closed.totalAmount, 275);
    assert.equal(closed.ledgerPayments.filter(p => p.kind === 'waiver').reduce((sum, p) => sum + p.amount, 0), 75);
  });

  await t.test('mark paid records selected method and game debt ignores unpaid orders', async () => {
    for(const method of ['nakit','kredi_karti']) {
      const a=await table(c), s=(await start(a,{targetMinutes:60})).activeSession;
      await post(`/api/sessions/${s.id}/orders`,{productName:'Tea',quantity:1,unitPrice:20},201);
      const updated=(await put(`/api/sessions/${s.id}`,{isPaid:true,paymentMethod:method})).activeSession;
      assert.equal(updated.gameRemaining,0);assert.equal(updated.ordersTotal,20);
      assert.equal(updated.ledgerPayments[0].paymentMethod,method);assert.equal(updated.collectedAmount,100);
      await close(a);
    }
    const a=await table(c), s=(await start(a,{targetMinutes:60})).activeSession;
    let updated=(await post(`/api/sessions/${s.id}/payments`,{amount:40,paymentMethod:'nakit'},201)).device.activeSession;
    assert.equal(updated.gameRemaining,60);
    updated=(await post(`/api/sessions/${s.id}/payments`,{amount:60,paymentMethod:'kredi_karti'},201)).device.activeSession;
    assert.equal(updated.gameRemaining,0);
    updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:90})).activeSession;
    assert.equal(updated.gameRemaining,50);await close(a);
  });

  await t.test('payment explanations follow increases after payment, not a fixed label', async () => {
    const a=await table(c);
    const s=(await start(a,{targetMinutes:60,isPaid:true,paymentMethod:'nakit'})).activeSession;
    let updated=(await put(`/api/sessions/${s.id}`,{targetMinutes:90})).activeSession;
    assert.deepEqual(updated.paymentDifferenceReasons,['Ek Süre']);
    updated=(await put(`/api/sessions/${s.id}`,{controllerCount:3})).activeSession;
    assert.deepEqual(updated.paymentDifferenceReasons,['Ek Süre','Kol Artışı']);
    await close(a);
    const second=(await start(a,{targetMinutes:60})).activeSession;
    await put(`/api/sessions/${second.id}`,{controllerCount:3});
    clock(new Date(current+1000).toISOString());
    await put(`/api/sessions/${second.id}`,{isPaid:true,paymentMethod:'kredi_karti'});
    updated=(await put(`/api/sessions/${second.id}`,{targetMinutes:90})).activeSession;
    assert.deepEqual(updated.paymentDifferenceReasons,['Ek Süre']);await close(a);
  });

  await t.test('deleted orders remain in history and closed names survive rename/archive/restart', async () => {
    const cat=await category(100,50), a=await table(cat), s=(await start(a)).activeSession;
    const orders=await post(`/api/sessions/${s.id}/orders`,{productName:'Cola',quantity:2,unitPrice:20},201);
    await api(`/api/orders/${orders[0].id}`,'DELETE',undefined,204);
    const history=await api(`/api/sessions/${s.id}/history`);
    assert.equal(history.events.filter(e=>e.type==='order_add').length,1);
    assert.equal(history.events.filter(e=>e.type==='order_remove').length,1);
    assert.ok(history.events.find(e=>e.type==='order_remove').message.includes('40.00'));
    await close(a);
    await put(`/api/devices/${a.id}`,{name:'New name',categoryId:cat.id});
    await put(`/api/categories/${cat.id}`,{...cat,name:'New category'});
    let row=await report(s.id);assert.equal(row.deviceName,a.name);assert.equal(row.categoryName,cat.name);
    await api(`/api/devices/${a.id}`,'DELETE',undefined,204);
    await stopServer();await startServer();
    row=await report(s.id);assert.equal(row.deviceName,a.name);assert.equal(row.categoryName,cat.name);
    assert.equal((await api(`/api/sessions/${s.id}/history`)).events.filter(e=>e.type==='order_remove').length,1);
  });

  await t.test('future and invalid timestamps fail without changing account; backdating still works', async () => {
    const a=await table(c), s=(await start(a)).activeSession;
    const future=new Date(current+60000).toISOString();
    await put(`/api/sessions/${s.id}`,{startedAt:future},400);
    await put(`/api/sessions/${s.id}`,{startedAt:'not-a-date'},400);
    const ignoredFuture = await post(`/api/devices/${a.id}/stop`,{paymentMethod:'nakit',endedAt:future});
    assert.equal(ignoredFuture.timeAmount, 50);
    const reopened=(await start(a)).activeSession;
    const updated=(await put(`/api/sessions/${reopened.id}`,{startedAt:new Date(current-3600000).toISOString()})).activeSession;
    assert.equal(updated.startedAt,new Date(current-3600000).toISOString());await close(a);
  });

  await t.test('independent 1-2,3,4 rates survive edits for open sessions', async () => {
    const cat=await post('/api/categories',{name:'Independent',baseRate:300,first30Rate:100,rate3:420,first30Rate3:140,rate4:530,first30Rate4:180});
    const a=await table(cat);
    for (const [count,hourly,first] of [[1,300,100],[2,300,100],[3,420,140],[4,530,180]]) {
      const session=(await start(a,{controllerCount:count,targetMinutes:60,isPaid:true,paymentMethod:'nakit'})).activeSession;
      assert.equal(session.hourlyRate,hourly);assert.equal(session.first30Rate,first);assert.equal(session.prepaidAmount,hourly);
      await close(a);
    }
    const session=(await start(a)).activeSession;
    await put(`/api/categories/${cat.id}`,{...cat,rate3:700,first30Rate3:250,rate4:900,first30Rate4:300});
    const changed=(await put(`/api/sessions/${session.id}`,{controllerCount:3})).activeSession;
    assert.equal(changed.hourlyRate,420);assert.equal(changed.first30Rate,140);await close(a);
    const fresh=(await start(a,{controllerCount:3})).activeSession;
    assert.equal(fresh.hourlyRate,700);assert.equal(fresh.first30Rate,250);await close(a);
    await put(`/api/categories/${cat.id}`,{...cat,rate3:0},400);
    await put(`/api/categories/${cat.id}`,{...cat,first30Rate4:999},400);
  });

  await t.test('backdating one hour applies the initial1-2 tariff before3 controllers', async () => {
    const cat=await post('/api/categories',{name:'Backdate3',baseRate:300,first30Rate:100,rate3:420,first30Rate3:140,rate4:530,first30Rate4:180});
    for (const count of [1,2]) {
      const a=await table(cat), startTime=current;
      const s=(await start(a,{controllerCount:count})).activeSession;
      clock(new Date(startTime+5*60000).toISOString());
      await put(`/api/sessions/${s.id}`,{controllerCount:3});
      clock(new Date(startTime+10*60000).toISOString());
      await put(`/api/sessions/${s.id}`,{startedAt:new Date(startTime-60*60000).toISOString()});
      // 65min at300/hour =>325; 5min at420/hour =>35. No historical repricing at3 controllers.
      assert.equal((await close(a)).timeAmount,360);
    }
    // A change at the exact same timestamp as opening must still preserve the original rate when backdating.
    const a=await table(cat), startTime=current;
    const s=(await start(a)).activeSession;
    await put(`/api/sessions/${s.id}`,{controllerCount:3});
    await put(`/api/sessions/${s.id}`,{startedAt:new Date(startTime-60*60000).toISOString()});
    assert.equal((await close(a)).timeAmount,300);
  });

  await t.test('backdate rebuilds all recorded controller and transfer segments', async () => {
    const cat=await category(300,100), target=await category(600,200);
    const a=await table(cat), b=await table(target), startTime=current;
    const s=(await start(a)).activeSession;
    clock(new Date(startTime+20*60000).toISOString());
    await put(`/api/sessions/${s.id}`,{controllerCount:4});
    clock(new Date(startTime+40*60000).toISOString());
    await put(`/api/sessions/${s.id}`,{startedAt:new Date(startTime-20*60000).toISOString()});
    const quote=await post(`/api/sessions/${s.id}/quote`,{targetMinutes:60});
    assert.equal(quote.timeAmount,434);
    // Repeating the correction must not compound historical charges.
    await put(`/api/sessions/${s.id}`,{startedAt:new Date(startTime-20*60000).toISOString()});
    assert.equal((await close(a)).timeAmount,434);
    const secondStart=current, second=(await start(a)).activeSession;
    clock(new Date(secondStart+10*60000).toISOString());
    await post(`/api/devices/${a.id}/transfer`,{targetDeviceId:b.id});
    clock(new Date(secondStart+20*60000).toISOString());
    await put(`/api/sessions/${second.id}`,{startedAt:new Date(secondStart-60*60000).toISOString()});
    assert.equal((await close(b)).timeAmount,450); // 70min source350 +10min target100
  });

  await t.test('live rounding waits for threshold while checkout rounds only game fee upward', async () => {
    await put('/api/settings/rounding-step',{roundingStep:5});
    const a=await table(await category(300,100));
    const startTime=current, s=(await start(a)).activeSession;
    clock(new Date(startTime+(30+10.25/(200/30))*60000).toISOString());
    assert.equal((await summary()).liveAmount,110);
    await post(`/api/sessions/${s.id}/orders`,{productName:'Tea',quantity:1,unitPrice:12.5},201);
    assert.equal((await summary()).liveAmount,122.5);
    const result=await close(a);
    assert.equal(result.timeAmount,115);assert.equal(result.ordersTotal,12.5);assert.equal(result.amount,127.5);
    for(const [raw,live,settled] of [[114.99,110,115],[115,115,115],[115.01,115,120]]) {
      const at=current;await start(a);
      clock(new Date(at+(30+(raw-100)/(200/30))*60000).toISOString());
      assert.equal((await summary()).liveAmount,live);
      assert.equal((await close(a)).timeAmount,settled);
    }
    await put('/api/settings/rounding-step',{roundingStep:1});
  });

  await t.test('exact opening/hourly tariffs are preserved and rounding settings are snapshotted', async () => {
    await put('/api/settings/rounding-step',{roundingStep:5});
    const a=await table(await category(303,103));
    const s=(await start(a)).activeSession;
    assert.equal((await summary()).liveAmount,103);
    await put('/api/settings/rounding-step',{roundingStep:50});
    assert.equal((await close(a)).timeAmount,103);
    for(const [minutes,expected] of [[30,103],[60,303],[120,606]]) {
      const startTime=current;await start(a);clock(new Date(startTime+minutes*60000).toISOString());
      assert.equal((await close(a)).timeAmount,expected);
    }
    await put('/api/settings/rounding-step',{roundingStep:5});
    const b=await table(await category(300,100)), at=current;await start(b);
    clock(new Date(at+31*60000).toISOString());
    await put('/api/settings/rounding-step',{roundingStep:50});
    assert.equal((await summary()).liveAmount,105);
    assert.equal((await close(b)).timeAmount,110);
    await put('/api/settings/rounding-step',{roundingStep:1});
  });

  await t.test('transfers use target independent rates for subsequent controller changes', async () => {
    const a=await table(await category(300,100));
    const target=await post('/api/categories',{name:'Target explicit',baseRate:300,first30Rate:100,rate3:390,first30Rate3:125,rate4:510,first30Rate4:170});
    const b=await table(target);const s=(await start(a)).activeSession;
    await post(`/api/devices/${a.id}/transfer`,{targetDeviceId:b.id});
    const changed=(await put(`/api/sessions/${s.id}`,{controllerCount:3})).activeSession;
    assert.equal(changed.hourlyRate,390);assert.equal(changed.first30Rate,125);await close(b);
  });


});
