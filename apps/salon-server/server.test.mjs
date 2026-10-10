import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attachExpectedSession } from "./attach-expected-session.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cave-salon-test-"));
const port = 31_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  env: {
    ...process.env,
    PORT: String(port),
    SALON_DB_PATH: path.join(tempDir, "salon.sqlite"),
    SALON_ADMIN_PASSWORD: "test-only-long-password",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

async function api(pathname, { method = "GET", body, token } = {}) {
  body = await attachExpectedSession(baseUrl, token, pathname, method, body);
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, payload };
}

test("API validates financial input and protects closed sessions", async (t) => {
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await waitForServer();

  assert.equal((await api("/api/summary")).response.status, 401);
  assert.equal((await api("/api/tts?text=test")).response.status, 401);

  const login = await api("/api/auth/login", { method: "POST", body: { password: "test-only-long-password" } });
  assert.equal(login.response.status, 200);
  const token = login.payload.token;

  assert.equal((await api("/api/settings/warning-minutes")).response.status, 401);
  assert.equal((await api("/api/settings/warning-minutes", { token })).payload.warningMinutes, 5);
  for (const warningMinutes of [0, -1, 1.5, 1441, "10", null]) {
    assert.equal((await api("/api/settings/warning-minutes", { method: "PUT", token, body: { warningMinutes } })).response.status, 400);
  }
  assert.equal((await api("/api/settings/warning-minutes", { method: "PUT", token, body: { warningMinutes: 10 } })).payload.warningMinutes, 10);
  assert.equal((await api("/api/summary", { token })).payload.warningMinutes, 10);

  const invalidProduct = await api("/api/products", { method: "POST", token, body: { name: "Invalid", price: "not-a-number" } });
  assert.equal(invalidProduct.response.status, 400);
  const invalidCategory = await api("/api/categories", { method: "POST", token, body: { name: "Invalid", baseRate: "Infinity" } });
  assert.equal(invalidCategory.response.status, 400);
  assert.equal((await api("/api/categories", { method: "POST", token, body: { name: "Inverted", baseRate: 100, first30Rate: 120 } })).response.status, 400);
  const invalidSale = await api("/api/direct-sales", { method: "POST", token, body: { paymentMethod: "nakit", items: [{ productName: "Bad", unitPrice: -10, quantity: 1 }] } });
  assert.equal(invalidSale.response.status, 400);

  const created = await api("/api/devices", { method: "POST", token, body: { name: "API Test Table" } });
  assert.equal(created.response.status, 201);
  assert.ok(created.payload.id > 0);
  const devices = await api("/api/devices", { token });
  const deviceId = devices.payload.find((device) => device.name === "API Test Table").id;

  const started = await api(`/api/devices/${deviceId}/start`, { method: "POST", token, body: { controllerCount: 2 } });
  assert.equal(started.response.status, 200);
  const activeDevices = await api("/api/devices", { token });
  const sessionId = activeDevices.payload.find((device) => device.id === deviceId).activeSession.id;
  assert.equal((await api(`/api/sessions/${sessionId}/orders`, { method: "POST", token, body: { productName: "Tea", unitPrice: 15, quantity: 1 } })).response.status, 201);
  assert.equal((await api(`/api/devices/${deviceId}/stop`, { method: "POST", token, body: { paymentMethod: "nakit" } })).response.status, 200);
  assert.equal((await api(`/api/sessions/${sessionId}/orders`, { method: "POST", token, body: { productName: "Late", unitPrice: 15, quantity: 1 } })).response.status, 400);

  await t.test("partial payments preserve timers, payment methods and collected revenue", async () => {
    const baseline = (await api("/api/summary", { token })).payload.dailyRevenue;
    await api(`/api/devices/${deviceId}/start`, { method: "POST", token, body: { controllerCount: 2 } });
    const getSession = async () => (await api("/api/devices", { token })).payload.find(d => d.id === deviceId).activeSession;
    const original = await getSession();
    const liveBeforePayment = (await api("/api/summary", { token })).payload.liveAmount;
    const pay = (amount, paymentMethod = "nakit") => api(`/api/sessions/${original.id}/payments`, { method: "POST", token, body: { amount, paymentMethod } });
    assert.equal((await api(`/api/sessions/${original.id}/payments`, { method: "POST", body: { amount: 1, paymentMethod: "nakit" } })).response.status, 401);
    for (const amount of [0, -1, 100001, 0.001, "10"]) assert.equal((await pay(amount)).response.status, 400);
    assert.equal((await pay(1, "ucretsiz")).response.status, 400);
    assert.equal((await pay(10)).response.status, 201);
    assert.equal((await pay(15, "kredi_karti")).response.status, 201);
    const active = await getSession();
    assert.equal(active.startedAt, original.startedAt);
    assert.equal(active.partialPaidAmount, 25);
    assert.equal(active.isPaid, false);
    assert.deepEqual(active.partialPayments.map(p => p.paymentMethod), ["nakit", "kredi_karti"]);
    assert.ok((await api("/api/summary", { token })).payload.liveAmount <= liveBeforePayment - 24);
    assert.equal((await api("/api/summary", { token })).payload.dailyRevenue, baseline + 25);
    assert.equal((await pay(100000)).response.status, 400);
    assert.equal((await api(`/api/sessions/${original.id}`, { method: "PUT", token, body: { isPaid: true, paymentMethod: "nakit" } })).response.status, 400);
    const close = await api(`/api/devices/${deviceId}/stop`, { method: "POST", token, body: { paymentMethod: "kredi_karti" } });
    assert.equal(close.response.status, 200);
    const report = (await api("/api/reports", { token })).payload.sessions.find(s => s.id === original.id);
    assert.equal((await api("/api/reports", { token })).payload.sessions.filter(s => s.id === original.id).length, 1);
    assert.equal(report.checkoutAmount, close.payload.amount - 25);
    assert.equal(report.periodPayments.filter(p => p.kind === 'partial').length, 2);
    assert.equal(report.periodPayments.reduce((sum, p) => sum + p.amount, 0), close.payload.amount);
    assert.equal((await api("/api/summary", { token })).payload.dailyRevenue, baseline + close.payload.amount);
    assert.equal((await pay(1)).response.status, 400);
    await api(`/api/devices/${deviceId}/undo`, { method: "POST", token });
    assert.equal((await getSession()).partialPaidAmount, 25);
    assert.equal((await api(`/api/sessions/${original.id}`, { method: "PUT", token, body: { targetMinutes: 60 } })).response.status, 200);
    assert.equal((await pay(5)).response.status, 201);
    const free = await api(`/api/devices/${deviceId}/stop`, { method: "POST", token, body: { paymentMethod: "ucretsiz" } });
    assert.equal(free.payload.amount, 100);
    assert.equal((await api("/api/summary", { token })).payload.dailyRevenue, baseline + 30);
    const freeReport = (await api("/api/reports", { token })).payload.sessions.find(s => s.id === original.id);
    assert.equal(freeReport.totalAmount, 100);
    assert.equal(freeReport.timeAmount, 100);
    assert.equal(freeReport.paymentMethod, "ucretsiz");
    assert.equal(freeReport.closureMethod, "ucretsiz");
    assert.equal(freeReport.ledgerPayments.filter(p => p.paymentMethod !== "ucretsiz").reduce((sum, p) => sum + p.amount, 0), 30);
    assert.equal(freeReport.ledgerPayments.filter(p => p.paymentMethod === "ucretsiz").reduce((sum, p) => sum + p.amount, 0), 70);
    assert.equal(freeReport.checkoutAmount, 0);
    assert.equal(freeReport.partialPayments.length, 3);
    await api(`/api/devices/${deviceId}/start`, { method: "POST", token, body: { controllerCount: 2, targetMinutes: 60, isPaid: true, paymentMethod: "nakit" } });
    const prepaid = await getSession();
    assert.equal((await api(`/api/sessions/${prepaid.id}/payments`, { method: "POST", token, body: { amount: 1, paymentMethod: "nakit" } })).response.status, 400);
  });

  await t.test("tariff reaches its configured hourly price at 60 minutes", async () => {
    const category = await api("/api/categories", { method: "POST", token, body: { name: "Simülatör Test", baseRate: 300, first30Rate: 100 } });
    assert.equal(category.response.status, 201);
    const created = await api("/api/devices", { method: "POST", token, body: { name: "Tarife Test Masası", categoryId: category.payload.id } });
    assert.equal(created.response.status, 201);
    const id = created.payload.id;
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 5 } })).response.status, 200);
    for (const [minutes, expected] of [[30, 100], [31, 110], [45, 200], [60, 300], [61, 305], [90, 450]]) {
      const startedAt = new Date(Date.now() - minutes * 60_000 + 250).toISOString();
      const started = await api(`/api/devices/${id}/start`, { method: "POST", token, body: { controllerCount: 2, startedAt } });
      assert.equal(started.response.status, 200);
      const stopped = await api(`/api/devices/${id}/stop`, { method: "POST", token, body: { paymentMethod: "nakit" } });
      assert.equal(stopped.response.status, 200, JSON.stringify(stopped.payload));
      assert.equal(stopped.payload.timeAmount, expected, `${minutes} dakika yanlış ücretlendirildi`);
    }
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 7 } })).response.status, 200);
    for (const [minutes, expected] of [[31, 112], [59, 294], [60, 300], [61, 308]]) {
      const started = await api(`/api/devices/${id}/start`, { method: "POST", token, body: { controllerCount: 2, startedAt: new Date(Date.now() - minutes * 60_000 + 250).toISOString() } });
      const stopped = await api(`/api/devices/${id}/stop`, { method: "POST", token, body: { paymentMethod: "nakit" } });
      assert.equal(stopped.payload.timeAmount, expected, `${minutes} dakika 7 ₺ katsayısıyla yanlış ücretlendirildi`);
    }
    const timed = await api(`/api/devices/${id}/start`, { method: "POST", token, body: { controllerCount: 2, targetMinutes: 60, isPaid: true, paymentMethod: "nakit" } });
    assert.equal(timed.payload.activeSession.prepaidAmount, 300);
    const settled = await api(`/api/devices/${id}/stop`, { method: "POST", token, body: { paymentMethod: "nakit" } });
    assert.equal(settled.payload.timeAmount, 300);
  });

  await t.test("table transfer splits elapsed tariff and preserves timed package budget", async () => {
    await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 1 } });
    const cheapCategory = await api("/api/categories", { method: "POST", token, body: { name: "Transfer Cheap", baseRate: 100, first30Rate: 50 } });
    const dearCategory = await api("/api/categories", { method: "POST", token, body: { name: "Transfer Dear", baseRate: 200, first30Rate: 100 } });
    const cheap = (await api("/api/devices", { method: "POST", token, body: { name: "Transfer Cheap Table", categoryId: cheapCategory.payload.id } })).payload.id;
    const dear = (await api("/api/devices", { method: "POST", token, body: { name: "Transfer Dear Table", categoryId: dearCategory.payload.id } })).payload.id;
    const transfer = (source, target) => api(`/api/devices/${source}/transfer`, { method: "POST", token, body: { targetDeviceId: target } });
    const start = (id, minutesAgo, extras = {}) => api(`/api/devices/${id}/start`, { method: "POST", token, body: { controllerCount: 2, startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extras } });
    const stop = (id, endedAt) => api(`/api/devices/${id}/stop`, { method: "POST", token, body: { paymentMethod: "nakit", ...(endedAt ? { endedAt } : {}) } });

    const unlimited = await start(cheap, 10);
    assert.equal(unlimited.response.status, 200);
    const movedUnlimited = await transfer(cheap, dear);
    assert.equal(movedUnlimited.response.status, 200);
    assert.equal(movedUnlimited.payload.target.activeSession.hourlyRate, 200);
    assert.ok(Math.abs(movedUnlimited.payload.target.activeSession.accruedAmount - 50 / 3) < 0.02);
    assert.equal((await stop(dear)).payload.timeAmount, 84); // First30 minimum still uses split tariffs.

    const paid = await start(cheap, 20, { targetMinutes: 60, isPaid: true, paymentMethod: "nakit" });
    assert.equal(paid.payload.activeSession.prepaidAmount, 100);
    const movedPaid = await transfer(cheap, dear);
    assert.equal(movedPaid.response.status, 200);
    assert.equal(movedPaid.payload.target.activeSession.packageAmount, 100);
    assert.equal(movedPaid.payload.target.activeSession.prepaidAmount, 100);
    assert.ok(Math.abs(movedPaid.payload.target.activeSession.targetMinutes - 40) <= 1);
    const movedBack = await transfer(dear, cheap);
    assert.equal(movedBack.payload.target.activeSession.packageAmount, 100);
    assert.ok(Math.abs(movedBack.payload.target.activeSession.targetMinutes - 60) <= 1);
    assert.equal((await stop(cheap)).payload.timeAmount, 100);

    const unpaid = await start(dear, 20, { targetMinutes: 60 });
    assert.equal((await api(`/api/sessions/${unpaid.payload.activeSession.id}/payments`, { method: "POST", token, body: { amount: 30, paymentMethod: "nakit" } })).response.status, 201);
    const movedUnpaid = await transfer(dear, cheap);
    assert.equal(movedUnpaid.response.status, 200);
    assert.equal(movedUnpaid.payload.target.activeSession.packageAmount, 200);
    assert.equal(movedUnpaid.payload.target.activeSession.prepaidAmount, 0);
    assert.equal(movedUnpaid.payload.target.activeSession.partialPaidAmount, 30);
    assert.ok(Math.abs(movedUnpaid.payload.target.activeSession.targetMinutes - 100) <= 1);
    assert.equal((await stop(cheap)).payload.timeAmount, 200);
  });

  await t.test("reports include a closed session spanning the entire selected interval", async () => {
    const created = await api("/api/devices", { method: "POST", token, body: { name: "Spanning Report Table" } });
    const deviceId = created.payload.id;
    const started = await api(`/api/devices/${deviceId}/start`, { method: "POST", token, body: { controllerCount: 2, startedAt: new Date(Date.now() - 120 * 60_000).toISOString() } });
    assert.equal(started.response.status, 200);
    const sessionId = started.payload.activeSession.id;
    assert.equal((await api(`/api/devices/${deviceId}/stop`, { method: "POST", token, body: { paymentMethod: "nakit" } })).response.status, 200);
    const startDate = new Date(Date.now() - 90 * 60_000).toISOString();
    const endDate = new Date(Date.now() - 80 * 60_000).toISOString();
    const reports = await api(`/api/reports?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`, { token });
    assert.equal(reports.response.status, 200);
    assert.ok(reports.payload.sessions.some(session => session.id === sessionId));
  });
});
