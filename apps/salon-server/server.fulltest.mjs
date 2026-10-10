import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { attachExpectedSession } from "./attach-expected-session.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cave-salon-ft-"));
const port = 32000 + Math.floor(Math.random() * 1000);
const baseUrl = "http://127.0.0.1:" + port;
const serverPath = path.dirname(fileURLToPath(import.meta.url));

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: serverPath,
  env: {
    ...process.env,
    PORT: String(port),
    SALON_DB_PATH: path.join(tempDir, "salon.sqlite"),
    SALON_ADMIN_PASSWORD: "test-sifre-2024",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[SRV] " + d));

async function waitForServer(ms) {
  ms = ms || 12000;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.status === 401) return;
    } catch {}
    await new Promise(function(r) { setTimeout(r, 60); });
  }
  throw new Error("Test sunucusu baslamadi.");
}

async function api(pathname, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const token = opts.token;
  const body = await attachExpectedSession(baseUrl, token, pathname, method, opts.body);
  const r = await fetch(baseUrl + pathname, {
    method: method,
    headers: Object.assign(
      { "content-type": "application/json" },
      token ? { authorization: "Bearer " + token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = r.status === 204 ? null : await r.json().catch(function() { return null; });
  return { status: r.status, payload: payload };
}

test("Cave Salon - Tam Entegrasyon Testi", async function(t) {
  t.after(async function() {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await waitForServer();

  let token, productId, categoryId, deviceId, deviceId2, sessionId;

  // ── AUTH ──────────────────────────────────────────────────────────────────
  await t.test("Auth - Yanlis sifre 401", async function() {
    const r = await api("/api/auth/login", { method: "POST", body: { password: "yanlis" } });
    assert.equal(r.status, 401);
  });

  await t.test("Auth - Dogru sifre token dondurur", async function() {
    const r = await api("/api/auth/login", { method: "POST", body: { password: "test-sifre-2024" } });
    assert.equal(r.status, 200);
    assert.ok(r.payload.token, "token olmali");
    token = r.payload.token;
  });

  await t.test("Auth - Korumasiz endpointler 401", async function() {
    assert.equal((await api("/api/summary")).status, 401);
    assert.equal((await api("/api/products")).status, 401);
    assert.equal((await api("/api/devices")).status, 401);
    assert.equal((await api("/api/categories")).status, 401);
    assert.equal((await api("/api/logs")).status, 401);
    assert.equal((await api("/api/reports")).status, 401);
  });

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  await t.test("Summary - 200 dondurur", async function() {
    assert.equal((await api("/api/summary", { token })).status, 200);
  });

  // ── URUNLER ───────────────────────────────────────────────────────────────
  await t.test("Urun - NaN fiyat 400", async function() {
    assert.equal((await api("/api/products", { method: "POST", token, body: { name: "TestX", price: "not-a-number" } })).status, 400);
  });

  await t.test("Urun - Negatif fiyat 400", async function() {
    assert.equal((await api("/api/products", { method: "POST", token, body: { name: "TestX", price: -5 } })).status, 400);
  });

  await t.test("Urun - Infinity fiyat 400", async function() {
    assert.equal((await api("/api/products", { method: "POST", token, body: { name: "TestX", price: "Infinity" } })).status, 400);
  });

  await t.test("Urun - Bos isim 400", async function() {
    assert.equal((await api("/api/products", { method: "POST", token, body: { name: "", price: 10 } })).status, 400);
  });

  await t.test("Urun - Olusturulur 201", async function() {
    const r = await api("/api/products", { method: "POST", token, body: { name: "TestCay-" + port, price: 15 } });
    assert.equal(r.status, 201);
    assert.ok(r.payload.id, "urun id olmali");
    productId = r.payload.id;
  });

  await t.test("Urun - Liste 200", async function() {
    const r = await api("/api/products", { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload));
    assert.ok(r.payload.some(function(p) { return p.id === productId; }));
  });

  await t.test("Urun - Guncellenir", async function() {
    const r = await api("/api/products/" + productId, { method: "PUT", token, body: { name: "TestCay-" + port, price: 20 } });
    assert.equal(r.status, 200);
    assert.equal(r.payload.price, 20);
  });

  // ── KATEGORILER ───────────────────────────────────────────────────────────
  // DB seed olarak PS5, PS4, Simultor zaten ekleniyor — benzersiz isim kullan
  const catName = "TestKat-" + port;

  await t.test("Kategori - Infinity baseRate 400", async function() {
    assert.equal((await api("/api/categories", { method: "POST", token, body: { name: catName + "X", baseRate: "Infinity" } })).status, 400);
  });

  await t.test("Kategori - Negatif baseRate 400", async function() {
    assert.equal((await api("/api/categories", { method: "POST", token, body: { name: catName + "Y", baseRate: -100 } })).status, 400);
  });

  await t.test("Kategori - Olusturulur 201", async function() {
    const r = await api("/api/categories", { method: "POST", token, body: { name: catName, baseRate: 120 } });
    assert.equal(r.status, 201, "Beklenen 201, alinan " + r.status + " hata: " + JSON.stringify(r.payload));
    assert.ok(r.payload.id, "kategori id olmali");
    categoryId = r.payload.id;
  });

  await t.test("Kategori - Liste 200", async function() {
    const r = await api("/api/categories", { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload));
    assert.ok(r.payload.some(function(c) { return c.id === categoryId; }));
  });

  await t.test("Kategori - Guncellenir", async function() {
    const r = await api("/api/categories/" + categoryId, { method: "PUT", token, body: { name: catName, baseRate: 150 } });
    assert.equal(r.status, 200);
    assert.equal(r.payload.baseRate, 150);
  });

  // ── MASALAR ───────────────────────────────────────────────────────────────
  const masaName1 = "TestMasa1-" + port;
  const masaName2 = "TestMasa2-" + port;

  await t.test("Masa - Bos isim 400", async function() {
    assert.equal((await api("/api/devices", { method: "POST", token, body: { name: "" } })).status, 400);
  });

  await t.test("Masa - 1 olusturulur", async function() {
    const r = await api("/api/devices", { method: "POST", token, body: { name: masaName1 } });
    assert.equal(r.status, 201, "Beklenen 201, alinan " + r.status + " hata: " + JSON.stringify(r.payload));
    assert.ok(r.payload && r.payload.id, "masa id olmali, payload: " + JSON.stringify(r.payload));
    deviceId = r.payload.id;
  });

  await t.test("Masa - 2 olusturulur", async function() {
    const r = await api("/api/devices", { method: "POST", token, body: { name: masaName2 } });
    assert.equal(r.status, 201, "Beklenen 201, alinan " + r.status);
    assert.ok(r.payload && r.payload.id, "masa2 id olmali");
    deviceId2 = r.payload.id;
  });

  await t.test("Masa - Liste 200", async function() {
    const r = await api("/api/devices", { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload));
    assert.ok(r.payload.some(function(d) { return d.id === deviceId; }));
  });

  await t.test("Masa - Guncellenir (kategori atanir)", async function() {
    const r = await api("/api/devices/" + deviceId, { method: "PUT", token, body: { name: masaName1, categoryId: categoryId } });
    assert.equal(r.status, 200);
  });

  await t.test("Masa - Reorder calisiyor", async function() {
    // Endpoint array of {id, displayOrder} bekliyor
    const r = await api("/api/devices/reorder", {
      method: "PUT",
      token,
      body: [{ id: deviceId, displayOrder: 1 }, { id: deviceId2, displayOrder: 0 }],
    });
    assert.equal(r.status, 200, "Reorder yaniti: " + JSON.stringify(r.payload));
    const listed = await api("/api/devices", { token });
    assert.deepEqual(listed.payload.map(d => d.id), [deviceId2, deviceId]);
    const SQL = await initSqlJs();
    const saved = new SQL.Database(fs.readFileSync(path.join(tempDir, "salon.sqlite")));
    try {
      assert.deepEqual(saved.exec("SELECT id FROM devices ORDER BY display_order, id")[0].values.flat(), [deviceId2, deviceId]);
    } finally { saved.close(); }
  });

  await t.test("Masa - Gecersiz kategori dis anahtar ile reddedilir", async function() {
    const r = await api("/api/devices", { method: "POST", token, body: { name: "Invalid category", categoryId: 999999 } });
    assert.equal(r.status, 409);
    const listed = await api("/api/devices", { token });
    assert.equal(listed.payload.length, 2);
  });

  // ── OTURUM BASLATMA ───────────────────────────────────────────────────────
  await t.test("Oturum - Gecersiz kol (0) 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId + "/start", { method: "POST", token, body: { controllerCount: 0 } })).status, 400);
  });

  await t.test("Oturum - Gecersiz kol (9) 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId + "/start", { method: "POST", token, body: { controllerCount: 9 } })).status, 400);
  });

  await t.test("Oturum - Baslatilir (2 kol)", async function() {
    const r = await api("/api/devices/" + deviceId + "/start", { method: "POST", token, body: { controllerCount: 2 } });
    assert.equal(r.status, 200, "Oturum baslama hatasi: " + JSON.stringify(r.payload));
    assert.ok(r.payload.activeSession, "aktif oturum olmali");
    sessionId = r.payload.activeSession.id;
  });

  await t.test("Oturum - Dolu masada baslatma 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId + "/start", { method: "POST", token, body: { controllerCount: 1 } })).status, 400);
  });

  await t.test("Masa - Acik hesap varken silinemez", async function() {
    assert.equal((await api("/api/devices/" + deviceId, { method: "DELETE", token })).status, 400);
  });

  // ── OTURUM GUNCELLEME ─────────────────────────────────────────────────────
  await t.test("Oturum - Kol 3 e guncellenir", async function() {
    assert.equal((await api("/api/sessions/" + sessionId, { method: "PUT", token, body: { controllerCount: 3 } })).status, 200);
  });

  await t.test("Oturum - Sureli cevirilir 60 dk", async function() {
    assert.equal((await api("/api/sessions/" + sessionId, { method: "PUT", token, body: { controllerCount: 3, targetMinutes: 60 } })).status, 200);
  });

  await t.test("Oturum - Gecersiz sure 9999 dk 400", async function() {
    assert.equal((await api("/api/sessions/" + sessionId, { method: "PUT", token, body: { controllerCount: 3, targetMinutes: 9999 } })).status, 400);
  });

  // ── SIPARISLER ────────────────────────────────────────────────────────────
  let orderId;

  await t.test("Siparis - Bos urun adi 400", async function() {
    assert.equal((await api("/api/sessions/" + sessionId + "/orders", { method: "POST", token, body: { productName: "", unitPrice: 15, quantity: 1 } })).status, 400);
  });

  await t.test("Siparis - Negatif fiyat 400", async function() {
    assert.equal((await api("/api/sessions/" + sessionId + "/orders", { method: "POST", token, body: { productName: "Cay", unitPrice: -5, quantity: 1 } })).status, 400);
  });

  await t.test("Siparis - Sifir miktar 400", async function() {
    assert.equal((await api("/api/sessions/" + sessionId + "/orders", { method: "POST", token, body: { productName: "Cay", unitPrice: 15, quantity: 0 } })).status, 400);
  });

  await t.test("Siparis - Eklenir 201", async function() {
    const r = await api("/api/sessions/" + sessionId + "/orders", { method: "POST", token, body: { productName: "Cay", unitPrice: 15, quantity: 2 } });
    assert.equal(r.status, 201, "Siparis eklenemedi: " + JSON.stringify(r.payload));
    assert.ok(Array.isArray(r.payload));
    assert.equal(r.payload.length, 1);
    assert.equal(r.payload[0].totalPrice, 30);
    orderId = r.payload[0].id;
  });

  await t.test("Siparis - Silinir 204", async function() {
    assert.equal((await api("/api/orders/" + orderId, { method: "DELETE", token })).status, 204);
  });

  // ── TRANSFER ──────────────────────────────────────────────────────────────
  await t.test("Transfer - Ayni masaya 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId + "/transfer", { method: "POST", token, body: { targetDeviceId: deviceId } })).status, 400);
  });

  await t.test("Transfer - Masa1 den Masa2 ye basarili", async function() {
    const r = await api("/api/devices/" + deviceId + "/transfer", { method: "POST", token, body: { targetDeviceId: deviceId2 } });
    assert.equal(r.status, 200, "Transfer basarisiz: " + JSON.stringify(r.payload));
    assert.equal(r.payload.source.status, "bos");
    assert.equal(r.payload.target.status, "mesgul");
  });

  await t.test("Transfer - Bos masadan transfer 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId + "/transfer", { method: "POST", token, body: { targetDeviceId: deviceId2 } })).status, 400);
  });

  // ── HESAP KAPATMA (oturum simdi deviceId2 de) ────────────────────────────
  await t.test("Kapat - Gecersiz odeme 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "kripto" } })).status, 400);
  });

  await t.test("Kapat - Nakit ile 200", async function() {
    const r = await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "nakit" } });
    assert.equal(r.status, 200, "Kapat hatasi: " + JSON.stringify(r.payload));
  });

  // ── KAPALI OTURUMA SIPARIS ────────────────────────────────────────────────
  await t.test("Guvenlik - Kapali oturuma siparis 400", async function() {
    assert.equal((await api("/api/sessions/" + sessionId + "/orders", { method: "POST", token, body: { productName: "Gec", unitPrice: 15, quantity: 1 } })).status, 400);
  });

  // ── UNDO (deviceId2 kapali, deviceId1 bos) ───────────────────────────────
  await t.test("Undo - Kapatilan hesap geri alinir", async function() {
    const r = await api("/api/devices/" + deviceId2 + "/undo", { method: "POST", token });
    assert.equal(r.status, 200, "Undo hatasi: " + JSON.stringify(r.payload));
    assert.ok(r.payload.device.activeSession, "Oturum tekrar acilmali");
  });

  await t.test("Undo - Acik masada undo 400", async function() {
    assert.equal((await api("/api/devices/" + deviceId2 + "/undo", { method: "POST", token })).status, 400);
  });

  // Geri alinan oturumu tekrar kapat
  await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "kredi_karti" } });

  await t.test("Kisa sureli masa 15 dk icin dusuk tutarla pesin acilir", async function() {
    const started = await api("/api/devices/" + deviceId2 + "/start", {
      method: "POST", token, body: { controllerCount: 2, targetMinutes: 15, isPaid: true, paymentMethod: "nakit" },
    });
    assert.equal(started.status, 200);
    assert.equal(started.payload.activeSession.prepaidAmount, 25);
    const stopped = await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "nakit" } });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.payload.timeAmount, 25);
  });

  await t.test("Kisa suresiz oturumda ilk 30 dk ucreti tam alinir", async function() {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const started = await api("/api/devices/" + deviceId2 + "/start", {
      method: "POST", token, body: { controllerCount: 2, startedAt: fifteenMinutesAgo },
    });
    assert.equal(started.status, 200);
    const endedAt = new Date(new Date(started.payload.activeSession.startedAt).getTime() + 15 * 60_000).toISOString();
    const stopped = await api("/api/devices/" + deviceId2 + "/stop", {
      method: "POST", token, body: { paymentMethod: "nakit", endedAt },
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.payload.timeAmount, 50);
  });

  // ── TEZGAH SATISI ─────────────────────────────────────────────────────────
  await t.test("Tezgah - Bos sepet 400", async function() {
    assert.equal((await api("/api/direct-sales", { method: "POST", token, body: { paymentMethod: "nakit", items: [] } })).status, 400);
  });

  await t.test("Tezgah - Negatif fiyat 400", async function() {
    assert.equal((await api("/api/direct-sales", { method: "POST", token, body: { paymentMethod: "nakit", items: [{ productName: "Kola", unitPrice: -10, quantity: 1 }] } })).status, 400);
  });

  await t.test("Tezgah - Bos urun adi 400", async function() {
    assert.equal((await api("/api/direct-sales", { method: "POST", token, body: { paymentMethod: "nakit", items: [{ productName: "", unitPrice: 10, quantity: 1 }] } })).status, 400);
  });

  await t.test("Tezgah - Gecerli satis 201 toplam 60", async function() {
    const r = await api("/api/direct-sales", {
      method: "POST", token,
      body: { paymentMethod: "kredi_karti", items: [{ productName: "Kola", unitPrice: 25, quantity: 2 }, { productName: "Su", unitPrice: 10, quantity: 1 }] },
    });
    assert.equal(r.status, 201, "Satis hatasi: " + JSON.stringify(r.payload));
    assert.equal(r.payload.totalAmount, 60);
    assert.ok(r.payload.saleId > 0);
    const report = await api("/api/reports", { token });
    const sale = report.payload.sessions.find(s => s.id === -r.payload.saleId);
    assert.ok(sale);
    assert.equal(sale.orderItems.length, 2);
    assert.equal(sale.orderItems.reduce((sum, item) => sum + item.totalPrice, 0), 60);
    const SQL = await initSqlJs();
    const saved = new SQL.Database(fs.readFileSync(path.join(tempDir, "salon.sqlite")));
    try {
      assert.equal(saved.exec("SELECT COUNT(*) FROM direct_sale_items")[0].values[0][0], 2);
    } finally { saved.close(); }
  });

  // ── AYARLAR ───────────────────────────────────────────────────────────────
  await t.test("Ayar - Negatif ucret 400", async function() {
    assert.equal((await api("/api/settings/hourly-rate", { method: "PUT", token, body: { hourlyRate: -50 } })).status, 400);
  });

  await t.test("Ayar - Saatlik ucret guncellenir", async function() {
    const r = await api("/api/settings/hourly-rate", { method: "PUT", token, body: { hourlyRate: 100 } });
    assert.equal(r.status, 200);
    assert.equal(r.payload.hourlyRate, 100);
  });

  await t.test("Ayar - Yuvarlama katsayisi dogrulanir ve kaydedilir", async function() {
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 0 } })).status, 400);
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 5.123 } })).status, 400);
    const saved = await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 5 } });
    assert.equal(saved.status, 200);
    assert.equal((await api("/api/settings/rounding-step", { token })).payload.roundingStep, 5);
    assert.equal((await api("/api/summary", { token })).payload.roundingStep, 5);
  });

  await t.test("Suresiz hesapta 31 dk 65 TL, 15 TL adisyonla 80 TL olur", async function() {
    await api("/api/settings/hourly-rate", { method: "PUT", token, body: { hourlyRate: 120 } });
    const startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const started = await api("/api/devices/" + deviceId2 + "/start", { method: "POST", token, body: { controllerCount: 2, startedAt } });
    assert.equal(started.status, 200);
    const added = await api("/api/sessions/" + started.payload.activeSession.id + "/orders", { method: "POST", token, body: { productName: "Cay", unitPrice: 15, quantity: 1 } });
    assert.equal(added.status, 201);
    const endedAt = new Date(new Date(started.payload.activeSession.startedAt).getTime() + 31 * 60_000).toISOString();
    const stopped = await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "nakit", endedAt } });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.payload.timeAmount, 65);
    assert.equal(stopped.payload.ordersTotal, 15);
    assert.equal(stopped.payload.amount, 80);
  });

  await t.test("Ondalik yuvarlama katsayisi adisyonu degistirmez", async function() {
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 2.5 } })).status, 200);
    const startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const started = await api("/api/devices/" + deviceId2 + "/start", { method: "POST", token, body: { controllerCount: 2, startedAt } });
    assert.equal(started.status, 200);
    assert.equal((await api("/api/sessions/" + started.payload.activeSession.id + "/orders", { method: "POST", token, body: { productName: "Cay", unitPrice: 15, quantity: 1 } })).status, 201);
    const endedAt = new Date(new Date(started.payload.activeSession.startedAt).getTime() + 31 * 60_000).toISOString();
    const stopped = await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "nakit", endedAt } });
    assert.equal(stopped.payload.timeAmount, 62.5);
    assert.equal(stopped.payload.amount, 77.5);
    assert.equal((await api("/api/settings/rounding-step", { method: "PUT", token, body: { roundingStep: 5 } })).status, 200);
  });

  await t.test("Suresiz hesapta kol artisi ve azalisi ilk 30 dk kullanim payina yansir", async function() {
    for (const [from, to, expected] of [[2, 4, 100], [4, 2, 80]]) {
      const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const started = await api("/api/devices/" + deviceId2 + "/start", { method: "POST", token, body: { controllerCount: from, startedAt } });
      assert.equal(started.status, 200);
      const updated = await api("/api/sessions/" + started.payload.activeSession.id, { method: "PUT", token, body: { controllerCount: to } });
      assert.equal(updated.status, 200);
      const stopped = await api("/api/devices/" + deviceId2 + "/stop", { method: "POST", token, body: { paymentMethod: "nakit" } });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.payload.timeAmount, expected);
    }
    await api("/api/settings/hourly-rate", { method: "PUT", token, body: { hourlyRate: 100 } });
  });

  // ── RAPORLAR ──────────────────────────────────────────────────────────────
  await t.test("Rapor - Tarih araliginda 200", async function() {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await api("/api/reports?startDate=" + today + "&endDate=" + today, { token })).status, 200);
  });

  // ── LOGLAR ────────────────────────────────────────────────────────────────
  let logId;
  await t.test("Log - Liste 200", async function() {
    const r = await api("/api/logs", { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload) && r.payload.length > 0, "Log kayitlari olmali");
    logId = r.payload[0].id;
  });

  await t.test("Log - Silinir 200", async function() {
    assert.equal((await api("/api/logs/" + logId, { method: "DELETE", token })).status, 200);
  });

  // ── TTS ───────────────────────────────────────────────────────────────────
  await t.test("TTS - Kimliksiz 401", async function() {
    assert.equal((await fetch(baseUrl + "/api/tts?text=merhaba")).status, 401);
  });

  await t.test("TTS - Oturum anahtarı URL'den kabul edilmez", async function() {
    assert.equal((await fetch(baseUrl + "/api/tts?text=merhaba&token=" + encodeURIComponent(token))).status, 401);
  });

  await t.test("TTS - Bos metin 400", async function() {
    assert.equal((await fetch(baseUrl + "/api/tts?text=", { headers: { authorization: "Bearer " + token } })).status, 400);
  });

  await t.test("TTS - 301 karakter 400", async function() {
    const long = "a".repeat(301);
    assert.equal((await fetch(baseUrl + "/api/tts?text=" + encodeURIComponent(long), { headers: { authorization: "Bearer " + token } })).status, 400);
  });

  // ── SILME ─────────────────────────────────────────────────────────────────
  await t.test("Urun - Silinir 204", async function() {
    assert.equal((await api("/api/products/" + productId, { method: "DELETE", token })).status, 204);
  });

  await t.test("Kategori - Silinir 204", async function() {
    assert.equal((await api("/api/categories/" + categoryId, { method: "DELETE", token })).status, 204);
  });

  await t.test("Masa1 - Bos masa silinir 204", async function() {
    // deviceId1 bos (transfer ile deviceId2 ye gecti, sonra kpatildi)
    assert.equal((await api("/api/devices/" + deviceId, { method: "DELETE", token })).status, 204);
  });

  await t.test("Masa2 - Gecmis hesapli masa kaldirilir, rapor ve ad yeniden kullanim korunur", async function() {
    assert.equal((await api("/api/devices/" + deviceId2, { method: "DELETE", token })).status, 204);
    const devices = await api("/api/devices", { token });
    assert.equal(devices.payload.length, 0);
    const summary = await api("/api/summary", { token });
    assert.equal(summary.payload.totalDevices, 0);
    const report = await api("/api/reports", { token });
    assert.equal(report.payload.sessions.find(s => s.id === sessionId).deviceName, masaName2);
    const sameName = await api("/api/devices", { method: "POST", token, body: { name: masaName2 } });
    assert.equal(sameName.status, 201);
    assert.notEqual(sameName.payload.id, deviceId2);
    const reportAfter = await api("/api/reports", { token });
    assert.equal(reportAfter.payload.sessions.find(s => s.id === sessionId).deviceName, masaName2);
    assert.equal((await api("/api/devices/" + deviceId2 + "/undo", { method: "POST", token })).status, 404);
  });

  await t.test("Yuvarlama tum masa cesitlerinde ve yeni eklenen cesit ile masada calisir", async function() {
    assert.equal((await api("/api/settings/rounding-step", { token })).payload.roundingStep, 5);
    const existing = await api("/api/categories", { token });
    assert.equal(existing.status, 200);
    assert.ok(existing.payload.length >= 3, "Mevcut masa cesitleri bulunmali");

    const newCategory = await api("/api/categories", {
      method: "POST", token,
      body: { name: "YeniTarife-" + port, baseRate: 121, first30Rate: 63 },
    });
    assert.equal(newCategory.status, 201);
    const categoriesToCheck = [...existing.payload, newCategory.payload];

    for (const category of categoriesToCheck) {
      const created = await api("/api/devices", {
        method: "POST", token,
        body: { name: "YuvarlamaMasa-" + category.id + "-" + port, categoryId: category.id },
      });
      assert.equal(created.status, 201, category.name + " icin masa olusturulamadi");
      assert.equal(created.payload.categoryId, category.id);

      const startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
      const started = await api("/api/devices/" + created.payload.id + "/start", {
        method: "POST", token, body: { controllerCount: 2, startedAt },
      });
      assert.equal(started.status, 200, category.name + " icin oturum acilamadi");
      const first30 = category.first30Rate == null ? category.baseRate / 2 : category.first30Rate;
      assert.equal(started.payload.activeSession.hourlyRate, category.baseRate);
      assert.equal(started.payload.activeSession.first30Rate, first30);
      const increment = (category.baseRate - first30) / 30;
      const expected = Math.min(category.baseRate, Math.ceil((first30 + increment - 1e-9) / 5) * 5);
      const endedAt = new Date(new Date(started.payload.activeSession.startedAt).getTime() + 31 * 60_000).toISOString();
      const stopped = await api("/api/devices/" + created.payload.id + "/stop", {
        method: "POST", token, body: { paymentMethod: "nakit", endedAt },
      });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.payload.timeAmount, expected, category.name + " yuvarlanmadi");
      assert.equal(stopped.payload.amount, expected, category.name + " toplam tutari yanlis");
    }
  });

  await t.test("Iki sureli masa farkli zamanlarda dolunca ucretleri sabit kalir ve ayri ayri odeme bekler", async function() {
    const masa2 = await api("/api/devices", { method: "POST", token, body: { name: "SureBitenMasa2-" + port } });
    const masa1 = await api("/api/devices", { method: "POST", token, body: { name: "SureBitenMasa1-" + port } });
    assert.equal(masa2.status, 201);
    assert.equal(masa1.status, 201);
    const earlierStart = new Date(Date.now() - 35 * 60_000).toISOString();
    const laterStart = new Date(Date.now() - 25 * 60_000).toISOString();
    const first = await api("/api/devices/" + masa2.payload.id + "/start", {
      method: "POST", token, body: { controllerCount: 2, targetMinutes: 15, startedAt: earlierStart },
    });
    const second = await api("/api/devices/" + masa1.payload.id + "/start", {
      method: "POST", token, body: { controllerCount: 2, targetMinutes: 15, startedAt: laterStart },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const active = await api("/api/devices", { token });
    const pending = active.payload.filter(d => [masa2.payload.id, masa1.payload.id].includes(d.id));
    assert.equal(pending.length, 2);
    assert.ok(pending.every(d => d.activeSession?.targetMinutes === 15));
    assert.ok(new Date(first.payload.activeSession.startedAt).getTime() < new Date(second.payload.activeSession.startedAt).getTime());
    const reportWhilePending = await api("/api/reports", { token });
    for (const started of [first, second]) {
      const row = reportWhilePending.payload.sessions.find(s => s.id === started.payload.activeSession.id);
      assert.equal(row.endedAt, null);
      assert.equal(row.timeAmount, 25);
    }
    const changed = await api("/api/sessions/" + second.payload.activeSession.id, {
      method: "PUT", token, body: { controllerCount: 4 },
    });
    assert.equal(changed.status, 200);
    const stoppedFirst = await api("/api/devices/" + masa2.payload.id + "/stop", {
      method: "POST", token, body: { paymentMethod: "nakit" },
    });
    assert.equal(stoppedFirst.status, 200);
    assert.equal(stoppedFirst.payload.timeAmount, 25);
    const stillPending = await api("/api/devices", { token });
    assert.equal(stillPending.status, 200);
    assert.ok(stillPending.payload.find(d => d.id === masa1.payload.id)?.activeSession);
    const stoppedSecond = await api("/api/devices/" + masa1.payload.id + "/stop", {
      method: "POST", token, body: { paymentMethod: "nakit" },
    });
    assert.equal(stoppedSecond.status, 200);
    assert.equal(stoppedSecond.payload.timeAmount, 25);
    const settled = await api("/api/reports", { token });
    const settledSecond = settled.payload.sessions.find(s => s.id === second.payload.activeSession.id);
    assert.ok(new Date(settledSecond.endedAt).getTime() > new Date(second.payload.activeSession.startedAt).getTime() + 15 * 60_000);
  });

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  await t.test("Auth - Logout sonrasi 401", async function() {
    assert.equal((await api("/api/auth/logout", { method: "POST", token })).status, 204);
    assert.equal((await api("/api/summary", { token })).status, 401);
  });
});
