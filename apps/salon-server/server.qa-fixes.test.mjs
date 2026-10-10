import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

test('QA TBL-07 stale checkout cannot close a replacement session', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-qa-tbl07-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const clockFile = path.join(temp, 'clock.txt');
  const clockModule = path.join(temp, 'clock.mjs');
  let current = Date.parse('2026-10-10T12:00:00+03:00');
  const clock = value => { current = Date.parse(value); fs.writeFileSync(clockFile, String(current)); };
  clock('2026-10-10T12:00:00+03:00');
  fs.writeFileSync(clockModule, `import fs from 'node:fs'; const RealDate=Date; const time=()=>Number(fs.readFileSync(process.env.TEST_CLOCK,'utf8')); globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time()]));} static now(){return time();}};`);
  const port = 36000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  let child, token, stderr = '';
  async function stopServer() {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  }
  async function startServer() {
    child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'server.mjs'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, PORT: String(port), SALON_DB_PATH: dbPath, SALON_ADMIN_PASSWORD: 'qa-fix-test', TEST_CLOCK: clockFile, TZ: 'Europe/Istanbul' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    throw new Error('Server unavailable: ' + stderr);
  }
  t.after(async () => { await stopServer(); fs.rmSync(temp, { recursive: true, force: true }); });
  async function raw(pathname, { method = 'GET', body, token: auth = token } = {}) {
    const response = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }
  await startServer();
  token = (await raw('/api/auth/login', { method: 'POST', body: { password: 'qa-fix-test' } })).data.token;
  const category = (await raw('/api/categories', { method: 'POST', body: { name: 'QA TBL07', baseRate: 300, first30Rate: 100 } })).data;
  const tableA = (await raw('/api/devices', { method: 'POST', body: { name: 'QA A', categoryId: category.id } })).data;
  const tableB = (await raw('/api/devices', { method: 'POST', body: { name: 'QA B', categoryId: category.id } })).data;
  const devices = () => raw('/api/devices').then(r => r.data);
  const of = async id => (await devices()).find(d => d.id === id);

  await t.test('current session id closes paid and free accounts', async () => {
    const opened = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const paid = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id } });
    assert.equal(paid.status, 200);
    assert.equal(paid.data.amount, 100);
    const again = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2, targetMinutes: 60 } })).data;
    const free = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'ucretsiz', expectedSessionId: again.activeSession.id } });
    assert.equal(free.status, 200);
    assert.equal(free.data.paymentMethod, 'ucretsiz');
  });

  await t.test('stale free close after transfer does not touch the new customer', async () => {
    const first = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2, targetMinutes: 60 } })).data;
    const firstId = first.activeSession.id;
    const paymentsBefore = (await raw(`/api/sessions/${firstId}/history`)).data.events.filter(e => e.type === 'payment').length;
    const moved = await raw(`/api/devices/${tableA.id}/transfer`, { method: 'POST', body: { targetDeviceId: tableB.id, expectedSessionId: firstId } });
    assert.equal(moved.status, 200);
    const second = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2, targetMinutes: 60 } })).data;
    const secondId = second.activeSession.id;
    const missing = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'ucretsiz' } });
    assert.equal(missing.status, 409, JSON.stringify(missing.data));
    const stale = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'ucretsiz', expectedSessionId: firstId } });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    const afterA = await of(tableA.id);
    const afterB = await of(tableB.id);
    assert.equal(afterA.activeSession.id, secondId);
    assert.equal(afterB.activeSession.id, firstId);
    assert.equal(afterA.activeSession.endedAt ?? null, null);
    const historyA = (await raw(`/api/sessions/${secondId}/history`)).data;
    const historyB = (await raw(`/api/sessions/${firstId}/history`)).data;
    assert.equal(historyA.events.filter(e => e.type === 'close' || e.type === 'payment').length, 0);
    assert.equal(historyB.events.filter(e => e.type === 'payment').length, paymentsBefore);
    const repeat = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'ucretsiz', expectedSessionId: firstId } });
    assert.equal(repeat.status, 409);
    const currentClose = await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: secondId } });
    assert.equal(currentClose.status, 200);
    const stillB = await of(tableB.id);
    assert.equal(stillB.activeSession.id, firstId);
    const closeB = await raw(`/api/devices/${tableB.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: firstId } });
    assert.equal(closeB.status, 200);
  });

  await t.test('stale transfer and undo target the original session only', async () => {
    const opened = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const sid = opened.activeSession.id;
    const moved = await raw(`/api/devices/${tableA.id}/transfer`, { method: 'POST', body: { targetDeviceId: tableB.id, expectedSessionId: sid } });
    assert.equal(moved.status, 200);
    const replacement = (await raw(`/api/devices/${tableA.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const staleMove = await raw(`/api/devices/${tableA.id}/transfer`, { method: 'POST', body: { targetDeviceId: tableB.id, expectedSessionId: sid } });
    assert.equal(staleMove.status, 409);
    assert.equal((await of(tableA.id)).activeSession.id, replacement.activeSession.id);
    assert.equal((await of(tableB.id)).activeSession.id, sid);
    await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: replacement.activeSession.id } });
    const staleUndo = await raw(`/api/devices/${tableA.id}/undo`, { method: 'POST', body: { expectedSessionId: sid } });
    assert.equal(staleUndo.status, 409);
    assert.equal((await of(tableA.id)).activeSession, null);
    const undo = await raw(`/api/devices/${tableA.id}/undo`, { method: 'POST', body: { expectedSessionId: replacement.activeSession.id } });
    assert.equal(undo.status, 200);
    assert.equal((await of(tableA.id)).activeSession.id, replacement.activeSession.id);
    await raw(`/api/devices/${tableA.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: replacement.activeSession.id } });
    await raw(`/api/devices/${tableB.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: sid } });
  });
});

test('QA LIF-05 checkout hold freezes time; client endedAt cannot undercharge', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-qa-lif05-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const clockFile = path.join(temp, 'clock.txt');
  const clockModule = path.join(temp, 'clock.mjs');
  let current = Date.parse('2026-10-10T12:00:00+03:00');
  const clock = value => { current = Date.parse(value); fs.writeFileSync(clockFile, String(current)); };
  clock('2026-10-10T12:00:00+03:00');
  fs.writeFileSync(clockModule, `import fs from 'node:fs'; const RealDate=Date; const time=()=>Number(fs.readFileSync(process.env.TEST_CLOCK,'utf8')); globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time()]));} static now(){return time();}};`);
  const port = 36100 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  let child, token, stderr = '';
  async function stopServer() {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  }
  child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'server.mjs'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: String(port), SALON_DB_PATH: dbPath, SALON_ADMIN_PASSWORD: 'qa-fix-test', TEST_CLOCK: clockFile, TZ: 'Europe/Istanbul' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', b => { stderr += b; });
  t.after(async () => { await stopServer(); fs.rmSync(temp, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  async function raw(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) };
  }
  token = (await raw('/api/auth/login', { method: 'POST', body: { password: 'qa-fix-test' } })).data.token;
  const category = (await raw('/api/categories', { method: 'POST', body: { name: 'QA LIF05', baseRate: 300, first30Rate: 100 } })).data;
  const table = (await raw('/api/devices', { method: 'POST', body: { name: 'QA Clock', categoryId: category.id } })).data;

  await t.test('client endedAt cannot undercharge after 45 minutes without a hold', async () => {
    const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const startedAt = opened.activeSession.startedAt;
    clock('2026-10-10T12:45:00+03:00');
    const closed = await raw(`/api/devices/${table.id}/stop`, {
      method: 'POST',
      body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id, endedAt: startedAt, useCheckoutHold: true },
    });
    assert.equal(closed.status, 409);
    const billedNow = await raw(`/api/devices/${table.id}/stop`, {
      method: 'POST',
      body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id, endedAt: startedAt },
    });
    assert.equal(billedNow.status, 200);
    assert.equal(billedNow.data.timeAmount, 200);
  });

  await t.test('checkout hold freezes the bill while the dialog stays open', async () => {
    const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const held = await raw(`/api/devices/${table.id}/checkout-hold`, {
      method: 'POST',
      body: { expectedSessionId: opened.activeSession.id },
    });
    assert.equal(held.status, 200);
    clock('2026-10-10T13:30:00+03:00');
    const closed = await raw(`/api/devices/${table.id}/stop`, {
      method: 'POST',
      body: {
        paymentMethod: 'nakit',
        expectedSessionId: opened.activeSession.id,
        useCheckoutHold: true,
        endedAt: opened.activeSession.startedAt,
      },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.timeAmount, 100);
  });

  await t.test('releasing the hold restores billing to server now', async () => {
    const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    assert.equal((await raw(`/api/devices/${table.id}/checkout-hold`, { method: 'POST', body: { expectedSessionId: opened.activeSession.id } })).status, 200);
    clock('2026-10-10T14:15:00+03:00');
    assert.equal((await raw(`/api/devices/${table.id}/checkout-release`, { method: 'POST', body: { expectedSessionId: opened.activeSession.id } })).status, 200);
    assert.equal((await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id, useCheckoutHold: true } })).status, 409);
    const closed = await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id } });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.timeAmount, 200);
  });

  await t.test('future client endedAt does not move the bill off server now', async () => {
    const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const future = new Date(current + 45 * 60000).toISOString();
    const closed = await raw(`/api/devices/${table.id}/stop`, {
      method: 'POST',
      body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id, endedAt: future },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.timeAmount, 100);
  });

  await t.test('stale checkout hold cannot close a replacement session', async () => {
    const second = (await raw('/api/devices', { method: 'POST', body: { name: 'QA Clock B', categoryId: category.id } })).data;
    const first = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const firstId = first.activeSession.id;
    await raw(`/api/devices/${table.id}/checkout-hold`, { method: 'POST', body: { expectedSessionId: firstId } });
    await raw(`/api/devices/${table.id}/transfer`, { method: 'POST', body: { targetDeviceId: second.id, expectedSessionId: firstId } });
    const replacement = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    clock('2026-10-10T15:00:00+03:00');
    const stale = await raw(`/api/devices/${table.id}/stop`, {
      method: 'POST',
      body: { paymentMethod: 'nakit', expectedSessionId: firstId, useCheckoutHold: true },
    });
    assert.equal(stale.status, 409);
    const after = (await raw('/api/devices')).data.find(d => d.id === table.id).activeSession;
    assert.equal(after.id, replacement.activeSession.id);
    assert.equal(after.endedAt ?? null, null);
    await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: replacement.activeSession.id } });
    await raw(`/api/devices/${second.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: firstId } });
  });

  await t.test('second close is rejected and does not charge twice', async () => {
    const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
    const first = await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id } });
    const secondClose = await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id } });
    assert.equal(first.status, 200);
    assert.equal(first.data.timeAmount, 100);
    assert.equal(secondClose.status, 400);
  });
});

test('QA PRC-09 session start backdate limit applies to updates', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-qa-prc09-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const clockFile = path.join(temp, 'clock.txt');
  const clockModule = path.join(temp, 'clock.mjs');
  let current = Date.parse('2026-10-10T12:00:00+03:00');
  const clock = value => { current = Date.parse(value); fs.writeFileSync(clockFile, String(current)); };
  clock('2026-10-10T12:00:00+03:00');
  fs.writeFileSync(clockModule, `import fs from 'node:fs'; const RealDate=Date; const time=()=>Number(fs.readFileSync(process.env.TEST_CLOCK,'utf8')); globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time()]));} static now(){return time();}};`);
  const port = 36200 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  let child, token, stderr = '';
  child = spawn(process.execPath, ['--import', pathToFileURL(clockModule).href, 'server.mjs'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: String(port), SALON_DB_PATH: dbPath, SALON_ADMIN_PASSWORD: 'qa-fix-test', TEST_CLOCK: clockFile, TZ: 'Europe/Istanbul' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', b => { stderr += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  async function raw(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }
  token = (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'qa-fix-test' }) }).then(r => r.json())).token;
  const category = (await raw('/api/categories', { method: 'POST', body: { name: 'QA PRC09', baseRate: 300, first30Rate: 100 } })).data;
  const table = (await raw('/api/devices', { method: 'POST', body: { name: 'QA Backdate', categoryId: category.id } })).data;
  const opened = (await raw(`/api/devices/${table.id}/start`, { method: 'POST', body: { controllerCount: 2 } })).data;
  const originalStart = opened.activeSession.startedAt;
  const originalGame = opened.activeSession.gameAmount;
  const tooOld = new Date(current - 12 * 60 * 60 * 1000 - 1).toISOString();
  const rejected = await raw(`/api/sessions/${opened.activeSession.id}`, { method: 'PUT', body: { startedAt: tooOld } });
  assert.equal(rejected.status, 400);
  const afterReject = (await raw('/api/devices')).data.find(d => d.id === table.id).activeSession;
  assert.equal(afterReject.startedAt, originalStart);
  assert.equal(afterReject.gameAmount, originalGame);
  const future = new Date(current + 60000).toISOString();
  assert.equal((await raw(`/api/sessions/${opened.activeSession.id}`, { method: 'PUT', body: { startedAt: future } })).status, 400);
  assert.equal((await raw(`/api/sessions/${opened.activeSession.id}`, { method: 'PUT', body: { startedAt: 'not-a-date' } })).status, 400);
  const edge = new Date(current - 12 * 60 * 60 * 1000).toISOString();
  const accepted = await raw(`/api/sessions/${opened.activeSession.id}`, { method: 'PUT', body: { startedAt: edge } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.activeSession.startedAt, edge);
  await raw(`/api/devices/${table.id}/stop`, { method: 'POST', body: { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id } });
});

test('QA SEC-06 login attempts are rate limited', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-qa-sec06-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const port = 36300 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      SALON_DB_PATH: dbPath,
      SALON_ADMIN_PASSWORD: 'qa-fix-test',
      SALON_LOGIN_MAX_ATTEMPTS: '3',
      SALON_LOGIN_WINDOW_MS: '60000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  const login = password => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal((await login('qa-fix-test')).status, 200);
  assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('wrong')).status, 429);
  assert.equal((await login('qa-fix-test')).status, 429);
});

test('QA PAY-02 remaining debt is zero without flipping prepaid isPaid', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-qa-pay02-'));
  const dbPath = path.join(temp, 'salon.sqlite');
  const port = 36400 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: String(port), SALON_DB_PATH: dbPath, SALON_ADMIN_PASSWORD: 'qa-fix-test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  const token = (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'qa-fix-test' }) }).then(r => r.json())).token;
  const api = (pathname, method, body) => fetch(base + pathname, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, data: r.status === 204 ? null : await r.json() }));
  const category = (await api('/api/categories', 'POST', { name: 'QA PAY02', baseRate: 300, first30Rate: 100 })).data;
  const table = (await api('/api/devices', 'POST', { name: 'QA Paid', categoryId: category.id })).data;
  const opened = (await api(`/api/devices/${table.id}/start`, 'POST', { controllerCount: 2, targetMinutes: 60 })).data;
  const due = opened.activeSession.gameAmount;
  const first = await api(`/api/sessions/${opened.activeSession.id}/payments`, 'POST', { amount: 100, paymentMethod: 'nakit' });
  assert.equal(first.status, 201);
  assert.equal(first.data.device.activeSession.isPaid, false);
  assert.ok(first.data.device.activeSession.remaining > 0);
  const rest = await api(`/api/sessions/${opened.activeSession.id}/payments`, 'POST', { amount: due - 100, paymentMethod: 'kredi_karti' });
  assert.equal(rest.status, 201);
  assert.equal(rest.data.device.activeSession.remaining, 0);
  assert.equal(rest.data.device.activeSession.gameRemaining, 0);
  assert.equal(rest.data.device.activeSession.isPaid, false);
  const overpay = await api(`/api/sessions/${opened.activeSession.id}/payments`, 'POST', { amount: 1, paymentMethod: 'nakit' });
  assert.equal(overpay.status, 400);
  const extra = await api(`/api/sessions/${opened.activeSession.id}`, 'PUT', { targetMinutes: 90 });
  assert.equal(extra.status, 200);
  assert.equal(extra.data.activeSession.isPaid, false);
  assert.ok(extra.data.activeSession.remaining > 0);
  const closed = await api(`/api/devices/${table.id}/stop`, 'POST', { paymentMethod: 'nakit', expectedSessionId: opened.activeSession.id });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.amount, extra.data.activeSession.gameAmount);
});
