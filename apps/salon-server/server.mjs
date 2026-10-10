import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";
import initSqlJs from "sql.js";
import { createDatabaseStorage } from "./database-storage.mjs";
import { allocateSessionSettlement } from "./payment-allocation.mjs";
import { calculateAmount as sharedAmount, segmentPrice, tariffRates, rateForControllers } from "../shared/pricing.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.SALON_DB_PATH ?? path.join(here, "data", "salon.sqlite");
const adminPassword = process.env.SALON_ADMIN_PASSWORD;
const port = Number(process.env.PORT ?? 3001);
const paymentMethods = new Set(["nakit", "kredi_karti"]);
const maxPrice = 100_000;
const maxQuantity = 1_000;
const maxTargetMinutes = 24 * 60;
const maxTtsTextLength = 300;
const maxTtsCacheEntries = 100;
const maxStartBackdateMs = 12 * 60 * 60 * 1000;
const staleAccountError = "Hesap değişmiş. Güncel hesabı kontrol edip tekrar deneyin.";

function readExpectedSessionId(body) {
  if (body?.expectedSessionId == null || body.expectedSessionId === "") return null;
  const id = Number(body.expectedSessionId);
  return Number.isInteger(id) && id > 0 ? id : false;
}
function HttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function sendHttpError(response, error) {
  if (error.status) return response.status(error.status).json({ error: error.message });
  throw error;
}
function requireMatchingSession(actualId, body) {
  const expected = readExpectedSessionId(body);
  if (expected === false) throw HttpError(400, "Geçerli bir oturum kimliği gönderin.");
  if (expected == null || expected !== actualId) throw HttpError(409, staleAccountError);
}
function validateStartedAt(value) {
  const customStart = new Date(value);
  const diffMs = Date.now() - customStart.getTime();
  if (Number.isNaN(customStart.getTime())) throw HttpError(400, "Başlangıç saati geçersiz. Geçerli bir tarih ve saat girin.");
  if (diffMs < 0) throw HttpError(400, "Başlangıç saati gelecekte olamaz. Şu anki saati veya geçmiş bir saati seçin.");
  if (diffMs > maxStartBackdateMs) throw HttpError(400, "Masa açılamadı: Başlangıç saati en fazla 12 saat geriye alınabilir. Son 12 saat içinde bir başlangıç saati seçin.");
  return customStart.toISOString();
}

if (!adminPassword) {
  throw new Error("SALON_ADMIN_PASSWORD tanımlanmalıdır; varsayılan parola ile başlatma engellendi.");
}
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
const storage = createDatabaseStorage(SQL, databasePath, { backupDirectory: process.env.SALON_BACKUP_DIR });
storage.backupIfDue();
const db = fs.existsSync(databasePath) ? new SQL.Database(fs.readFileSync(databasePath)) : new SQL.Database();

db.run(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_rate REAL NOT NULL,
    first_30_rate REAL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'bos',
    category_id INTEGER,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    segment_started_at TEXT,
    accrued_amount REAL DEFAULT 0,
    ended_at TEXT,
    hourly_rate REAL NOT NULL,
    first_30_rate REAL,
    controller_count INTEGER NOT NULL DEFAULT 1,
    target_minutes INTEGER,
    package_amount REAL,
    is_paid INTEGER DEFAULT 0,
    payment_method TEXT,
    closure_method TEXT,
    total_amount REAL,
    paid_game_amount REAL,
    paid_orders_amount REAL,
    free_game_amount REAL,
    free_orders_amount REAL,
    checkout_payment_method TEXT,
    checkout_amount REAL,
    archived_device_name TEXT,
    archived_category_name TEXT,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );
  CREATE TABLE IF NOT EXISTS session_payments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_payments_session_date ON session_payments(session_id, created_at);
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, id);
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    credential_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    price REAL NOT NULL,
    category TEXT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    total_price REAL NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS order_items_session_date ON order_items(session_id, created_at);
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS direct_sales (
    id INTEGER PRIMARY KEY,
    total_amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS direct_sale_items (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    total_price REAL NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES direct_sales(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS direct_sale_items_sale ON direct_sale_items(sale_id, id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings(key, value) VALUES ('hourly_rate', '100');
  INSERT OR IGNORE INTO settings(key, value) VALUES ('rounding_step', '1');
  INSERT OR IGNORE INTO settings(key, value) VALUES ('warning_minutes', '5');
`);

// Migrations
for (const column of ['rate_3', 'first_30_rate_3', 'rate_4', 'first_30_rate_4']) {
  try { db.run(`ALTER TABLE categories ADD COLUMN ${column} REAL`); } catch {}
}
try { db.run("ALTER TABLE sessions ADD COLUMN tariff_rates_json TEXT"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN rounding_step REAL"); } catch {}
try { db.run("ALTER TABLE devices ADD COLUMN category_id INTEGER REFERENCES categories(id);"); } catch {}
try { db.run("ALTER TABLE devices ADD COLUMN display_order INTEGER DEFAULT 0;"); } catch {}
try { db.run("ALTER TABLE devices ADD COLUMN archived_at TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN controller_count INTEGER NOT NULL DEFAULT 1;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN target_minutes INTEGER;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN package_amount REAL;"); } catch {}
try { db.run("ALTER TABLE categories ADD COLUMN first_30_rate REAL;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN first_30_rate REAL;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN accrued_amount REAL DEFAULT 0;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN segment_started_at TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN is_paid INTEGER DEFAULT 0;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN payment_method TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN closure_method TEXT;"); } catch {}
for (const column of ['paid_game_amount', 'paid_orders_amount', 'free_game_amount', 'free_orders_amount']) {
  try { db.run(`ALTER TABLE sessions ADD COLUMN ${column} REAL`); } catch {}
}
try { db.run("ALTER TABLE sessions ADD COLUMN prepaid_amount REAL DEFAULT 0;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN checkout_payment_method TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN checkout_amount REAL;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN checkout_held_at TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN archived_device_name TEXT;"); } catch {}
try { db.run("ALTER TABLE sessions ADD COLUMN archived_category_name TEXT;"); } catch {}
try { db.run("ALTER TABLE session_payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'partial';"); } catch {}
try { db.run("ALTER TABLE session_payments ADD COLUMN timestamp_estimated INTEGER NOT NULL DEFAULT 0;"); } catch {}
try { db.run("ALTER TABLE session_payments ADD COLUMN game_credit REAL;"); } catch {}
try { db.run(`
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`); } catch {}

db.run(`UPDATE categories SET rate_3 = COALESCE(rate_3, ROUND(base_rate * 1.5, 2)),
 first_30_rate_3 = COALESCE(first_30_rate_3, ROUND(COALESCE(first_30_rate, base_rate / 2) * 1.5, 2)),
 rate_4 = COALESCE(rate_4, ROUND(base_rate * 2, 2)),
 first_30_rate_4 = COALESCE(first_30_rate_4, ROUND(COALESCE(first_30_rate, base_rate / 2) * 2, 2))`);
for (const s of rows("SELECT * FROM sessions WHERE tariff_rates_json IS NULL OR rounding_step IS NULL")) {
  const factor = s.controller_count <= 2 ? 1 : s.controller_count === 3 ? 1.5 : 2;
  const rates = tariffRates({ baseRate: s.hourly_rate / factor, first30Rate: (s.first_30_rate ?? s.hourly_rate / 2) / factor });
  rates[s.controller_count <= 2 ? '2' : s.controller_count === 3 ? '3' : '4'] = { hourlyRate: s.hourly_rate, first30Rate: s.first_30_rate ?? s.hourly_rate / 2 };
  db.run("UPDATE sessions SET tariff_rates_json = COALESCE(tariff_rates_json, ?), rounding_step = COALESCE(rounding_step, ?) WHERE id = ?", [JSON.stringify(rates), roundingStep(), s.id]);
}

// Preserve historical closed totals. Older prepaid collection times were not stored;
// closed records retain their previous settlement date, open prepayments use start time.
if (!row("SELECT value FROM settings WHERE key = 'payment_ledger_v1'")) {
  transaction(() => {
    for (const s of rows("SELECT * FROM sessions")) {
      const prepaid = Number(s.prepaid_amount) || 0;
      if (!s.ended_at) {
        if (prepaid > 0) recordPayment(s.id, prepaid, validPaymentMethod(s.payment_method) ? s.payment_method : 'nakit', 'prepaid', s.started_at, true);
        continue;
      }
      const partial = partialTotal(s.id);
      const remaining = roundCents((Number(s.total_amount) || 0) - partial);
      const initialMethod = validPaymentMethod(s.payment_method) ? s.payment_method : 'nakit';
      const finalMethod = validPaymentMethod(s.checkout_payment_method) ? s.checkout_payment_method : initialMethod;
      const prepaidPart = Math.min(Math.max(0, remaining), prepaid);
      recordPayment(s.id, prepaidPart, initialMethod, 'legacy_checkout', s.ended_at, true);
      recordPayment(s.id, remaining - prepaidPart, finalMethod, 'legacy_checkout', s.ended_at, true);
    }
    db.run("INSERT INTO settings(key, value) VALUES ('payment_ledger_v1', '1')");
  });
}

// Restore the full bill for older free closures that stored only previously collected cash.
const freeClosureCandidates = rows(`SELECT id, started_at AS startedAt, ended_at AS endedAt,
    segment_started_at AS segmentStartedAt, accrued_amount AS accruedAmount,
    hourly_rate AS hourlyRate, first_30_rate AS first30Rate,
    target_minutes AS targetMinutes, package_amount AS packageAmount,
    rounding_step AS roundingStep, total_amount AS totalAmount,
    payment_method AS paymentMethod
    FROM sessions WHERE ended_at IS NOT NULL AND closure_method IS NULL
      AND (payment_method = 'ucretsiz' OR EXISTS (
        SELECT 1 FROM session_events e WHERE e.session_id = sessions.id AND e.type = 'close'
          AND e.message LIKE 'Hesap ücretsiz kapatıldı%'))`);
if (freeClosureCandidates.length) transaction(() => {
  for (const session of freeClosureCandidates) {
    const lastClose = row("SELECT message FROM session_events WHERE session_id = ? AND type = 'close' ORDER BY id DESC LIMIT 1", [session.id]);
    const wasFree = lastClose?.message?.startsWith('Hesap ücretsiz kapatıldı') || (!lastClose && session.paymentMethod === 'ucretsiz');
    if (!wasFree) continue;
    const paid = collectedTotal(session.id);
    const fullBill = roundCents(snapshotGameAmount(session, new Date(session.endedAt)) + ordersTotalForSession(session.id));
    const correctedTotal = Math.max(Number(session.totalAmount) || 0, paid, fullBill);
    recordPayment(session.id, correctedTotal - paid, 'ucretsiz', 'waiver', session.endedAt, true);
    db.run("UPDATE sessions SET total_amount = ?, payment_method = 'ucretsiz', closure_method = 'ucretsiz' WHERE id = ?", [correctedTotal, session.id]);
  }
});
const settlementBackfill = rows("SELECT id, total_amount AS totalAmount, closure_method AS closureMethod, payment_method AS paymentMethod FROM sessions WHERE ended_at IS NOT NULL AND paid_game_amount IS NULL");
if (settlementBackfill.length) transaction(() => {
  for (const session of settlementBackfill) {
    const orders = ordersTotalForSession(session.id);
    const game = roundCents(Math.max(0, (session.totalAmount ?? 0) - orders));
    const free = session.closureMethod === 'ucretsiz' || session.paymentMethod === 'ucretsiz';
    const allocation = allocateSessionSettlement(game, orders, ledgerForSession(session.id), free);
    db.run("UPDATE sessions SET paid_game_amount = ?, paid_orders_amount = ?, free_game_amount = ?, free_orders_amount = ? WHERE id = ?", [allocation.paidGameAmount, allocation.paidOrdersAmount, allocation.freeGameAmount, allocation.freeOrdersAmount, session.id]);
  }
});
db.run("UPDATE activity_logs SET message = REPLACE(message, 'Tezgâh Satışı', 'Direkt Adisyon Satışı') WHERE message LIKE '%Tezgâh Satışı%'");

// Seed Categories
if (row("SELECT COUNT(*) as count FROM categories")?.count === 0) {
  const time = now();
  execute("INSERT INTO categories(name, base_rate, first_30_rate, created_at) VALUES (?, ?, ?, ?)", ["PS5", 150, 90, time]);
  execute("INSERT INTO categories(name, base_rate, first_30_rate, created_at) VALUES (?, ?, ?, ?)", ["PS4", 100, 60, time]);
  execute("INSERT INTO categories(name, base_rate, first_30_rate, created_at) VALUES (?, ?, ?, ?)", ["Simülatör", 250, 150, time]);
}

// Seed Products
if (row("SELECT COUNT(*) as count FROM products")?.count === 0) {
  execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", ["Çay", 15, "İçecek"]);
  execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", ["Türk Kahvesi", 35, "İçecek"]);
  execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", ["Kasa Tost", 60, "Yiyecek"]);
  execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", ["Kutu Kola / Soğuk İçecek", 40, "İçecek"]);
  execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", ["Su 0.5L", 10, "İçecek"]);
}

// Keep existing closed report identities before any future table/category edits.
db.run(`UPDATE sessions SET
 archived_device_name = COALESCE(archived_device_name, (SELECT name FROM devices WHERE id = sessions.device_id)),
 archived_category_name = COALESCE(archived_category_name, (SELECT COALESCE(c.name, 'Genel') FROM devices d LEFT JOIN categories c ON c.id = d.category_id WHERE d.id = sessions.device_id))
 WHERE ended_at IS NOT NULL`);
persist();
storage.backupIfDue();
setInterval(() => {
  try { storage.backupIfDue(); }
  catch (error) { console.error("Otomatik veritabanı yedeği alınamadı:", error); }
}, 60 * 60 * 1000);

function persist() {
  // sql.js export reopens the connection: restore connection-local constraints.
  const data = db.export();
  db.run("PRAGMA foreign_keys = ON");
  storage.writeVerified(databasePath, Buffer.from(data));
}
function now() { return new Date().toISOString(); }
function isValidMoney(value, { allowZero = false } = {}) {
  return Number.isFinite(value) && Math.abs(value - roundCents(value)) < 1e-8 && value <= maxPrice && (allowZero ? value >= 0 : value > 0);
}
function isValidPositiveInteger(value, maximum) { return Number.isInteger(value) && value >= 1 && value <= maximum; }
function validPaymentMethod(value, { allowFree = false } = {}) {
  return paymentMethods.has(value) || (allowFree && value === "ucretsiz");
}
function splitPayments(value, expectedAmount) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return false;
  if (!value.every(part => part && typeof part.amount === 'number' && isValidMoney(part.amount) && validPaymentMethod(part.paymentMethod))) return false;
  return roundCents(value.reduce((sum, part) => sum + part.amount, 0)) === roundCents(expectedAmount) ? value : false;
}
function rows(sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}
function row(sql, params = []) { return rows(sql, params)[0] ?? null; }
function execute(sql, params = []) { db.run(sql, params); persist(); }
function insert(sql, params = []) {
  db.run(sql, params);
  // Capture the ID before export resets last_insert_rowid().
  const id = Number(row("SELECT last_insert_rowid() AS id").id);
  persist();
  return id;
}
function addLog(type, message) { execute("INSERT INTO activity_logs(type, message, created_at) VALUES (?, ?, ?)", [type, message, now()]); }
function hourlyRate() { return Number(row("SELECT value FROM settings WHERE key = 'hourly_rate'")?.value ?? 100); }
function roundingStep() { return Number(row("SELECT value FROM settings WHERE key = 'rounding_step'")?.value ?? 1); }
function warningMinutes() { return Number(row("SELECT value FROM settings WHERE key = 'warning_minutes'")?.value ?? 5); }
function round(value) { return Math.round(value); }
function roundCents(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

// Clean up logs older than 7 days to prevent DB bloat
function cleanupLogs() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    execute("DELETE FROM activity_logs WHERE created_at < ?", [sevenDaysAgo]);
  } catch (error) {
    console.error("Log cleanup error:", error);
  }
}
cleanupLogs();
setInterval(cleanupLogs, 60 * 60 * 1000); // Check every hour

function calculateAmount(startedAt, hourlyRate, first30Rate, endedAt = new Date(), accruedAmount = 0, segmentStartedAt = null, targetMinutes = null, step = roundingStep(), mode = 'settlement') {
  return sharedAmount(startedAt, hourlyRate, first30Rate, endedAt, accruedAmount, segmentStartedAt, targetMinutes, step, mode);
}

function categoryList() {
  return rows("SELECT id, name, base_rate AS baseRate, first_30_rate AS first30Rate, rate_3 AS rate3, first_30_rate_3 AS first30Rate3, rate_4 AS rate4, first_30_rate_4 AS first30Rate4 FROM categories ORDER BY name COLLATE NOCASE");
}
function categoryRates(categoryId) { return tariffRates(categoryList().find(c => c.id === categoryId), hourlyRate()); }
function sessionRates(session) {
  if (session.tariffRatesJson) return JSON.parse(session.tariffRatesJson);
  const factor = session.controllerCount <= 2 ? 1 : session.controllerCount === 3 ? 1.5 : 2;
  return tariffRates({ baseRate: session.hourlyRate / factor, first30Rate: (session.first30Rate ?? session.hourlyRate / 2) / factor });
}

// Rebuild elapsed charges from immutable tariff changes, never from a rounded bill.
function replayAccrued(session, newStart, until, targetMinutes) {
  const events = rows("SELECT created_at AS createdAt, before_json AS beforeJson, after_json AS afterJson FROM session_events WHERE session_id = ? ORDER BY id", [session.id]);
  const snapshots = events.map(e => ({ ...e, before: e.beforeJson ? JSON.parse(e.beforeJson) : null, after: JSON.parse(e.afterJson) }));
  const initial = snapshots[0]?.before ?? snapshots[0]?.after ?? session;
  if ((initial.accruedAmount ?? 0) !== 0 || (initial.segmentStartedAt && initial.segmentStartedAt !== initial.startedAt)) {
    throw new Error('Bu eski hesabın önceki tarife dilimleri eksik. Başlangıç saati güvenilir biçimde yeniden hesaplanamıyor; mevcut saat korunmuştur.');
  }
  const start = new Date(newStart).getTime();
  const end = Math.max(start, Math.min(new Date(until).getTime(), targetMinutes ? start + targetMinutes * 60000 : Infinity));
  let cursor = start, hourly = initial.hourlyRate, first = initial.first30Rate ?? hourly / 2, total = 0;
  for (const e of snapshots) {
    if (!e.before || (e.before.hourlyRate === e.after.hourlyRate && e.before.first30Rate === e.after.first30Rate)) continue;
    const change = new Date(e.createdAt).getTime();
    if (change > end) break;
    const next = Math.max(cursor, change);
    total += segmentPrice((cursor - start) / 60000, (next - start) / 60000, hourly, first);
    cursor = next; hourly = e.after.hourlyRate; first = e.after.first30Rate ?? hourly / 2;
  }
  total += segmentPrice((cursor - start) / 60000, (end - start) / 60000, hourly, first);
  return total;
}

function productList() {
  return rows("SELECT id, name, price, category FROM products ORDER BY category, name");
}

function ordersForSession(sessionId) {
  return rows("SELECT id, session_id AS sessionId, product_name AS productName, unit_price AS unitPrice, quantity, total_price AS totalPrice, created_at AS createdAt FROM order_items WHERE session_id = ? ORDER BY id ASC", [sessionId]);
}

function ordersTotalForSession(sessionId) {
  return Number(row("SELECT COALESCE(SUM(total_price), 0) as total FROM order_items WHERE session_id = ?", [sessionId])?.total ?? 0);
}

function ledgerForSession(sessionId) {
  return rows("SELECT id, amount, payment_method AS paymentMethod, created_at AS createdAt, kind, game_credit AS gameCredit, timestamp_estimated AS timestampEstimated FROM session_payments WHERE session_id = ? ORDER BY id", [sessionId]);
}
function sessionSnapshot(id) {
  return { ...row(`SELECT s.device_id AS deviceId, d.name AS deviceName, s.started_at AS startedAt,
    s.controller_count AS controllerCount, s.target_minutes AS targetMinutes,
    s.hourly_rate AS hourlyRate, s.first_30_rate AS first30Rate,
    s.segment_started_at AS segmentStartedAt, s.accrued_amount AS accruedAmount,
    s.package_amount AS packageAmount, s.ended_at AS endedAt, s.total_amount AS totalAmount,
    s.rounding_step AS roundingStep, s.is_paid AS isPaid FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.id = ?`, [id]) };
}
function recordSessionEvent(id, type, message, before = null, createdAt = now()) {
  db.run("INSERT INTO session_events(session_id, type, message, created_at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)",
    [id, type, message, createdAt, before ? JSON.stringify(before) : null, JSON.stringify(sessionSnapshot(id))]);
}
function snapshotGameAmount(s, at = new Date()) {
  return s.targetMinutes && s.packageAmount != null ? s.packageAmount : calculateAmount(s.startedAt, s.hourlyRate, s.first30Rate, at, s.accruedAmount ?? 0, s.segmentStartedAt, s.targetMinutes, s.roundingStep ?? roundingStep());
}
function gamePaymentCredit(session) {
  let credit = 0;
  const events = rows("SELECT created_at AS createdAt, after_json AS afterJson FROM session_events WHERE session_id = ? ORDER BY id", [session.id]);
  for (const payment of ledgerForSession(session.id)) {
    if (payment.kind === 'prepaid') credit += payment.amount;
    if (payment.kind !== 'partial') continue;
    // Freeze new partial-payment allocations; later charges must not consume money paid for orders.
    const snapshot = events.filter(e => e.createdAt <= payment.createdAt).at(-1);
    const cost = snapshotGameAmount(snapshot ? JSON.parse(snapshot.afterJson) : session, new Date(payment.createdAt));
    credit += payment.gameCredit ?? Math.min(payment.amount, Math.max(0, cost - credit));
  }
  return roundCents(credit);
}
function paymentDifferenceReasons(session, gameCredit) {
  const reasons = new Set();
  for (const e of rows("SELECT type, created_at AS createdAt, before_json AS beforeJson, after_json AS afterJson FROM session_events WHERE session_id = ? AND before_json IS NOT NULL ORDER BY id", [session.id])) {
    const before = JSON.parse(e.beforeJson), after = JSON.parse(e.afterJson);
    if (snapshotGameAmount(after, new Date(e.createdAt)) <= gameCredit + 0.001) continue;
    const raisesRate = after.hourlyRate > before.hourlyRate || after.first30Rate > before.first30Rate;
    if (!raisesRate && snapshotGameAmount(after, new Date(e.createdAt)) <= snapshotGameAmount(before, new Date(e.createdAt)) + 0.001) continue;
    if (after.controllerCount > before.controllerCount) reasons.add('Kol Artışı');
    if (after.targetMinutes > (before.targetMinutes ?? 0)) reasons.add('Ek Süre');
    if (before.targetMinutes && !after.targetMinutes) reasons.add('Süresize Çevirme');
    if (before.startedAt !== after.startedAt) reasons.add('Başlangıç Saati Düzeltmesi');
    if (e.type === 'transfer' && (before.hourlyRate !== after.hourlyRate || before.first30Rate !== after.first30Rate)) reasons.add('Masa Aktarımı / Tarife Değişikliği');
  }
  return [...reasons];
}
function paymentsForSession(sessionId) {
  return ledgerForSession(sessionId).filter(p => p.kind === 'partial');
}
function partialTotal(sessionId) {
  return roundCents(paymentsForSession(sessionId).reduce((sum, p) => sum + p.amount, 0));
}
function recordPayment(sessionId, amount, method, kind, createdAt = now(), estimated = false) {
  if (roundCents(amount) === 0) return;
  db.run("INSERT INTO session_payments(session_id, amount, payment_method, created_at, kind, timestamp_estimated) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionId, roundCents(amount), method, createdAt, kind, estimated ? 1 : 0]);
}
function collectedTotal(sessionId) {
  return roundCents(Number(row("SELECT COALESCE(SUM(amount), 0) AS total FROM session_payments WHERE session_id = ? AND payment_method != 'ucretsiz'", [sessionId]).total));
}
function transaction(work) {
  db.run("BEGIN TRANSACTION");
  let result;
  try { result = work(); db.run("COMMIT"); } catch (error) { db.run("ROLLBACK"); throw error; }
  persist();
  return result;
}
function settlePayments(sessionId, total, method, at = now()) {
  const difference = roundCents(total - collectedTotal(sessionId));
  if (difference >= 0) { recordPayment(sessionId, difference, method, 'checkout', at); return; }
  // Return excess against the original collection methods, oldest method first.
  let refund = -difference;
  const balances = new Map();
  for (const payment of ledgerForSession(sessionId).filter(payment => payment.paymentMethod !== 'ucretsiz')) balances.set(payment.paymentMethod, roundCents((balances.get(payment.paymentMethod) ?? 0) + payment.amount));
  for (const [paymentMethod, balance] of balances) {
    const amount = Math.min(refund, Math.max(0, balance));
    recordPayment(sessionId, -amount, paymentMethod, 'refund', at);
    refund = roundCents(refund - amount);
    if (refund <= 0) break;
  }
}

function device(deviceId) {
  const value = row(`
    SELECT d.id, d.name, d.status, d.category_id AS categoryId, c.name AS categoryName, c.base_rate AS baseRate, c.first_30_rate AS first30Rate
    FROM devices d
    LEFT JOIN categories c ON d.category_id = c.id
    WHERE d.id = ? AND d.archived_at IS NULL
  `, [deviceId]);
  if (!value) return null;

  const activeSession = row(`
    SELECT id, device_id AS deviceId, started_at AS startedAt, segment_started_at AS segmentStartedAt, accrued_amount AS accruedAmount, hourly_rate AS hourlyRate, tariff_rates_json AS tariffRatesJson, rounding_step AS roundingStep, first_30_rate AS first30Rate, controller_count AS controllerCount, target_minutes AS targetMinutes, package_amount AS packageAmount, is_paid AS isPaid, payment_method AS paymentMethod, prepaid_amount AS prepaidAmount, checkout_held_at AS checkoutHeldAt
    FROM sessions
    WHERE device_id = ? AND ended_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, [deviceId]);

  if (activeSession) {
    activeSession.isPaid = Boolean(activeSession.isPaid);
    activeSession.partialPayments = paymentsForSession(activeSession.id);
    activeSession.ledgerPayments = ledgerForSession(activeSession.id);
    activeSession.collectedAmount = collectedTotal(activeSession.id);
    activeSession.partialPaidAmount = partialTotal(activeSession.id);
    activeSession.orderItems = ordersForSession(activeSession.id);
    activeSession.ordersTotal = ordersTotalForSession(activeSession.id);
    activeSession.gameAmount = snapshotGameAmount(activeSession);
    activeSession.gameRemaining = roundCents(Math.max(0, activeSession.gameAmount - activeSession.collectedAmount));
    activeSession.remaining = roundCents(Math.max(0, activeSession.gameAmount + activeSession.ordersTotal - activeSession.collectedAmount));
    activeSession.gamePaymentCredit = gamePaymentCredit(activeSession);
    activeSession.paymentDifferenceReasons = activeSession.gameAmount > activeSession.gamePaymentCredit + 0.001 ? paymentDifferenceReasons(activeSession, activeSession.gamePaymentCredit) : [];
  }

  value.activeSession = activeSession;
  value.lastClosedSessionId = row("SELECT id FROM sessions WHERE device_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1", [deviceId])?.id ?? null;
  return value;
}

function deviceList() { return rows("SELECT id FROM devices WHERE archived_at IS NULL ORDER BY display_order ASC, id ASC").map(({ id }) => device(id)); }

function summary() {
  const devices = deviceList();
  const current = Date.now();
  const liveAmount = devices.reduce((sum, value) => {
    if (!value.activeSession) return sum;
    const sessionCost = value.activeSession.targetMinutes && value.activeSession.packageAmount != null
      ? value.activeSession.packageAmount : calculateAmount(
      value.activeSession.startedAt,
      value.activeSession.hourlyRate,
      value.activeSession.first30Rate,
      current,
      value.activeSession.accruedAmount ?? 0,
      value.activeSession.segmentStartedAt,
      value.activeSession.targetMinutes, value.activeSession.roundingStep, 'live'
    );
    const ordersTotal = value.activeSession.ordersTotal ?? 0;
    return sum + Math.max(0, roundCents(sessionCost + ordersTotal - value.activeSession.collectedAmount));
  }, 0);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const dailyRevenue = Number(row("SELECT COALESCE(SUM(amount), 0) AS total FROM session_payments WHERE created_at >= ? AND payment_method != 'ucretsiz'", [todayStart.toISOString()])?.total ?? 0);
  const dailyRevenueDirect = Number(row("SELECT COALESCE(SUM(total_amount), 0) AS total FROM direct_sales WHERE created_at >= ?", [todayStart.toISOString()])?.total ?? 0);
  const totalDailyRevenue = roundCents(dailyRevenue + dailyRevenueDirect);
  return { totalDevices: devices.length, availableDevices: devices.filter((x) => x.status === "bos").length, occupiedDevices: devices.filter((x) => x.status === "mesgul").length, openSessions: devices.filter((x) => x.activeSession).length, liveAmount: roundCents(liveAmount), dailyRevenue: totalDailyRevenue, roundingStep: roundingStep(), warningMinutes: warningMinutes(), updatedAt: now() };
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) { return `${salt}:${crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex")}`; }
function validPassword(password) { const [salt, expected] = passwordHash(adminPassword).split(":"); const actual = passwordHash(password, salt).split(":")[1]; return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex")); }

const credentialHash = crypto.createHash('sha256').update(adminPassword).digest('hex');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
function authToken(request) { return request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? ""; }
function requireAuth(request, response, next) {
  const token = authToken(request);
  if (!token || !row("SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND credential_hash = ?", [hashToken(token), credentialHash])) {
    return response.status(401).json({ error: "Oturum açmanız gerekiyor." });
  }
  next();
}

const app = express();
app.use(express.json());
app.set("trust proxy", false);

const loginMaxAttempts = Math.max(1, Number.parseInt(process.env.SALON_LOGIN_MAX_ATTEMPTS ?? "8", 10) || 8);
const loginWindowMs = Math.max(1000, Number.parseInt(process.env.SALON_LOGIN_WINDOW_MS ?? String(15 * 60 * 1000), 10) || 15 * 60 * 1000);
const loginAttempts = new Map();
function loginClientKey(request) {
  return request.socket?.remoteAddress || "local";
}
function loginBucket(key) {
  const nowMs = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= nowMs) {
    const fresh = { count: 0, resetAt: nowMs + loginWindowMs };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return current;
}

app.post("/api/auth/login", (request, response) => {
  const key = loginClientKey(request);
  const bucket = loginBucket(key);
  if (bucket.count >= loginMaxAttempts) {
    return response.status(429).json({ error: "Çok fazla hatalı deneme. Bir süre sonra tekrar deneyin." });
  }
  const reqPassword = request.body?.password ?? "";
  if (validPassword(reqPassword)) {
    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString("hex");
    execute("INSERT INTO admin_sessions(token_hash, credential_hash, created_at) VALUES (?, ?, ?)", [hashToken(token), credentialHash, now()]);
    addLog("SİSTEM", "Yönetici sisteme giriş yaptı.");
    response.json({ token });
  } else {
    bucket.count += 1;
    if (bucket.count >= loginMaxAttempts) {
      return response.status(429).json({ error: "Çok fazla hatalı deneme. Bir süre sonra tekrar deneyin." });
    }
    response.status(401).json({ error: "Hatalı şifre." });
  }
});
app.post("/api/auth/logout", requireAuth, (request, response) => { execute("DELETE FROM admin_sessions WHERE token_hash = ?", [hashToken(authToken(request))]); response.status(204).end(); });

app.get("/api/summary", requireAuth, (_request, response) => response.json(summary()));

function groupedReportRows(ids, queryForBatch, parentKey) {
  const grouped = new Map(ids.map(id => [id, []]));
  // Keep each query below SQLite's parameter limit for large reports.
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => '?').join(', ');
    for (const item of rows(queryForBatch(placeholders), batch)) grouped.get(item[parentKey]).push(item);
  }
  return grouped;
}

app.get("/api/reports", requireAuth, (request, response) => {
  const { startDate, endDate } = request.query;

  let startISO;
  let endISO;

  if (startDate && endDate) {
    const startText = String(startDate), endText = String(endDate);
    const sDate = new Date(startText.includes("T") ? startText : `${startText}T00:00:00`);
    const eDate = new Date(endText.includes("T") ? endText : `${endText}T00:00:00`);
    if (isNaN(sDate.getTime()) || isNaN(eDate.getTime()) || sDate > eDate) return response.status(400).json({ error: "Geçerli bir tarih aralığı seçin." });
    if (!endText.includes('T')) eDate.setDate(eDate.getDate() + 1);
    else eDate.setTime(eDate.getTime() + (/T\d{2}:\d{2}$/.test(endText) ? 60_000 : 1));
    startISO = sDate.toISOString();
    endISO = eDate.toISOString();
  } else {
    const dStart = new Date();
    dStart.setHours(0, 0, 0, 0);
    const dEnd = new Date();
    dEnd.setHours(24, 0, 0, 0);
    startISO = dStart.toISOString();
    endISO = dEnd.toISOString();
  }

  const dateFilterClause = "WHERE (s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at >= ?)) OR EXISTS (SELECT 1 FROM session_payments p WHERE p.session_id = s.id AND p.created_at >= ? AND p.created_at < ?) OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.session_id = s.id AND oi.created_at >= ? AND oi.created_at < ?)";
  const params = [endISO, startISO, startISO, endISO, startISO, endISO];


  const reportSessions = rows(`

    SELECT
      s.id,
      s.device_id AS deviceId,
      COALESCE(s.archived_device_name, d.name, 'Silinmiş masa #' || s.device_id) AS deviceName,
      COALESCE(s.archived_category_name, c.name, 'Genel') AS categoryName,
      s.started_at AS startedAt,
      s.ended_at AS endedAt,
      s.controller_count AS controllerCount,
      s.target_minutes AS targetMinutes,
      s.package_amount AS packageAmount,
      s.is_paid AS isPaid,
      s.payment_method AS paymentMethod,
      s.closure_method AS closureMethod,
      s.paid_game_amount AS paidGameAmount,
      s.paid_orders_amount AS paidOrdersAmount,
      s.free_game_amount AS freeGameAmount,
      s.free_orders_amount AS freeOrdersAmount,
      s.prepaid_amount AS prepaidAmount,
      s.total_amount AS totalAmount,
      s.hourly_rate AS hourlyRate,
      s.rounding_step AS roundingStep,
      s.first_30_rate AS first30Rate,
      s.accrued_amount AS accruedAmount,
      s.segment_started_at AS segmentStartedAt,
      s.checkout_payment_method AS checkoutPaymentMethod,
      s.checkout_amount AS checkoutAmount
    FROM sessions s
    LEFT JOIN devices d ON s.device_id = d.id
    LEFT JOIN categories c ON d.category_id = c.id
    ${dateFilterClause}
    ORDER BY s.id DESC
  `, params);
  const sessionIds = reportSessions.map(session => session.id);
  const ordersBySession = groupedReportRows(sessionIds, placeholders =>
    `SELECT id, session_id AS sessionId, product_name AS productName, unit_price AS unitPrice, quantity, total_price AS totalPrice, created_at AS createdAt
     FROM order_items WHERE session_id IN (${placeholders}) ORDER BY session_id, id`, 'sessionId');
  const paymentsBySession = groupedReportRows(sessionIds, placeholders =>
    `SELECT id, session_id AS sessionId, amount, payment_method AS paymentMethod, created_at AS createdAt, kind, game_credit AS gameCredit, timestamp_estimated AS timestampEstimated
     FROM session_payments WHERE session_id IN (${placeholders}) ORDER BY session_id, id`, 'sessionId');

  const sessionsList = reportSessions.map((s) => {
    const orderItems = ordersBySession.get(s.id);
    const ordersTotal = orderItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const ledgerPayments = paymentsBySession.get(s.id).map(({ sessionId, ...payment }) => payment);
    const partialPayments = ledgerPayments.filter(payment => payment.kind === 'partial');
    const collectedAmount = roundCents(ledgerPayments.filter(payment => payment.paymentMethod !== 'ucretsiz').reduce((sum, payment) => sum + payment.amount, 0));
    const isPaid = Boolean(s.isPaid);

    let timeAmount = 0;
    if (s.endedAt) {
      timeAmount = roundCents(Math.max(0, (s.totalAmount ?? 0) - ordersTotal));
    } else {
      timeAmount = s.targetMinutes && s.packageAmount != null ? s.packageAmount : calculateAmount(s.startedAt, s.hourlyRate, s.first30Rate, new Date(), s.accruedAmount ?? 0, s.segmentStartedAt, s.targetMinutes, s.roundingStep);
    }

    return {
      ...s,
      partialPayments,
      ledgerPayments,
      partialPaidAmount: roundCents(partialPayments.reduce((sum, payment) => sum + payment.amount, 0)),
      periodPayments: ledgerPayments.filter(payment => payment.createdAt >= startISO && payment.createdAt < endISO),
      closedInPeriod: Boolean(s.endedAt && s.endedAt >= startISO && s.endedAt < endISO),
      isPaid,
      collectedAmount,
      remaining: s.endedAt ? 0 : roundCents(Math.max(0, timeAmount + ordersTotal - collectedAmount)),
      orderItems,
      ordersTotal,
      timeAmount,
      totalAmount: s.endedAt ? (s.totalAmount ?? roundCents(timeAmount + ordersTotal)) : roundCents(timeAmount + ordersTotal),
    };
  });

  const directSales = rows(`
    SELECT id, total_amount AS totalAmount, payment_method AS paymentMethod, created_at AS createdAt
    FROM direct_sales
    WHERE created_at >= ? AND created_at < ?
    ORDER BY id DESC
  `, [startISO, endISO]);
  const itemsBySale = groupedReportRows(directSales.map(sale => sale.id), placeholders =>
    `SELECT sale_id AS saleId, product_name AS productName, quantity, unit_price AS unitPrice, total_price AS totalPrice
     FROM direct_sale_items WHERE sale_id IN (${placeholders}) ORDER BY sale_id, id`, 'saleId');
  const directSalesList = directSales.map(ds => {
    const orderItems = itemsBySale.get(ds.id).map(({ saleId, ...item }) => ({ ...item, createdAt: ds.createdAt }));
    return {
      id: -ds.id,
      deviceId: null,
      deviceName: "Direkt Adisyon Satışı",
      categoryName: null,
      controllerCount: null,
      startedAt: ds.createdAt,
      endedAt: ds.createdAt,
      timeAmount: 0,
      ordersTotal: ds.totalAmount,
      totalAmount: ds.totalAmount,
      paymentMethod: ds.paymentMethod,
      periodPayments: [{ amount: ds.totalAmount, paymentMethod: ds.paymentMethod, createdAt: ds.createdAt, kind: 'sale' }],
      closedInPeriod: true,
      orderItems: orderItems
    };
  });

  const combinedList = [...sessionsList, ...directSalesList].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  response.json({
    sessions: combinedList
  });
});



// Product routes
app.get("/api/products", requireAuth, (_request, response) => response.json(productList()));
app.post("/api/products", requireAuth, (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const price = Number(request.body?.price ?? 0);
  const category = String(request.body?.category ?? "Diğer").trim();
  if (!name || !isValidMoney(price)) return response.status(400).json({ error: "Geçerli ürün adı ve fiyat girin." });
  try {
    execute("INSERT INTO products(name, price, category) VALUES (?, ?, ?)", [name, price, category]);
    response.status(201).json(row("SELECT id, name, price, category FROM products WHERE name = ?", [name]));
  } catch {
    response.status(409).json({ error: "Bu ürün zaten mevcut." });
  }
});

app.put("/api/products/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  const name = String(request.body?.name ?? "").trim();
  const price = Number(request.body?.price ?? 0);
  const category = String(request.body?.category ?? "Diğer").trim();
  if (!name || !isValidMoney(price)) return response.status(400).json({ error: "Geçerli ürün adı ve fiyat girin." });
  try {
    execute("UPDATE products SET name = ?, price = ?, category = ? WHERE id = ?", [name, price, category, id]);
    response.json(row("SELECT id, name, price, category FROM products WHERE id = ?", [id]));
  } catch {
    response.status(409).json({ error: "Güncelleme yapılamadı veya bu ürün adı zaten kullanılıyor." });
  }
});

app.delete("/api/products/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  execute("DELETE FROM products WHERE id = ?", [id]);
  response.status(204).end();
});

// Category routes
function extraCategoryRates(body, existing = null) {
  const defaults = tariffRates({ baseRate: Number(body.baseRate), first30Rate: body.first30Rate == null ? null : Number(body.first30Rate) });
  return {
    rate3: Number(body.rate3 ?? existing?.rate3 ?? defaults['3'].hourlyRate),
    first30Rate3: Number(body.first30Rate3 ?? existing?.first30Rate3 ?? defaults['3'].first30Rate),
    rate4: Number(body.rate4 ?? existing?.rate4 ?? defaults['4'].hourlyRate),
    first30Rate4: Number(body.first30Rate4 ?? existing?.first30Rate4 ?? defaults['4'].first30Rate),
  };
}
function validExtraRates(rates) {
  return Object.values(rates).every(isValidMoney) && rates.first30Rate3 <= rates.rate3 && rates.first30Rate4 <= rates.rate4;
}
app.get("/api/categories", requireAuth, (_request, response) => response.json(categoryList()));
app.post("/api/categories", requireAuth, (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const baseRate = Number(request.body?.baseRate ?? 0);
  const first30Rate = request.body?.first30Rate != null ? Number(request.body.first30Rate) : null;

  if (!name || name.length > 50) return response.status(400).json({ error: "Çeşit adı 1–50 karakter olmalıdır." });
  if (!isValidMoney(baseRate) || (first30Rate !== null && !isValidMoney(first30Rate))) return response.status(400).json({ error: "Saatlik ücret ve ilk 30 dakika ücreti sıfırdan büyük olmalıdır." });
  if (first30Rate !== null && first30Rate > baseRate) return response.status(400).json({ error: "İlk 30 dakika ücreti saatlik ücreti aşamaz." });
  const extra = extraCategoryRates(request.body);
  if (!validExtraRates(extra)) return response.status(400).json({ error: "3 ve 4 kol ücretleri sıfırdan büyük olmalı; ilk 30 dakika ücreti saatlik ücreti aşamaz." });

  try {
    const id = insert("INSERT INTO categories(name, base_rate, first_30_rate, rate_3, first_30_rate_3, rate_4, first_30_rate_4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [name, baseRate, first30Rate, extra.rate3, extra.first30Rate3, extra.rate4, extra.first30Rate4, now()]);
    response.status(201).json(categoryList().find(c => c.id === id));
  } catch {
    response.status(409).json({ error: "Bu çeşit adı zaten kullanılıyor." });
  }
});

app.put("/api/categories/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  const name = String(request.body?.name ?? "").trim();
  const baseRate = Number(request.body?.baseRate ?? 0);
  const first30Rate = request.body?.first30Rate != null ? Number(request.body.first30Rate) : null;

  if (!name || name.length > 50) return response.status(400).json({ error: "Çeşit adı 1–50 karakter olmalıdır." });
  if (!isValidMoney(baseRate) || (first30Rate !== null && !isValidMoney(first30Rate))) return response.status(400).json({ error: "Saatlik ücret ve ilk 30 dakika ücreti sıfırdan büyük olmalıdır." });
  if (first30Rate !== null && first30Rate > baseRate) return response.status(400).json({ error: "İlk 30 dakika ücreti saatlik ücreti aşamaz." });
  const extra = extraCategoryRates(request.body, categoryList().find(c => c.id === id));
  if (!validExtraRates(extra)) return response.status(400).json({ error: "3 ve 4 kol ücretleri sıfırdan büyük olmalı; ilk 30 dakika ücreti saatlik ücreti aşamaz." });

  try {
    execute("UPDATE categories SET name = ?, base_rate = ?, first_30_rate = ?, rate_3 = ?, first_30_rate_3 = ?, rate_4 = ?, first_30_rate_4 = ? WHERE id = ?", [name, baseRate, first30Rate, extra.rate3, extra.first30Rate3, extra.rate4, extra.first30Rate4, id]);
    response.json(categoryList().find(c => c.id === id));
  } catch {
    response.status(409).json({ error: "Güncelleme yapılamadı veya bu ad zaten mevcut." });
  }
});

app.delete("/api/categories/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  execute("UPDATE devices SET category_id = NULL WHERE category_id = ?", [id]);
  execute("DELETE FROM categories WHERE id = ?", [id]);
  response.status(204).end();
});

// Device routes
app.get("/api/devices", requireAuth, (_request, response) => response.json(deviceList()));

app.put("/api/devices/reorder", requireAuth, (request, response) => {
  const updates = request.body;
  if (!Array.isArray(updates)) return response.status(400).json({ error: "Geçersiz veri" });
  try {
    db.run("BEGIN TRANSACTION");
    for (const update of updates) {
      if (typeof update.id === "number" && typeof update.displayOrder === "number") {
        db.run("UPDATE devices SET display_order = ? WHERE id = ?", [update.displayOrder, update.id]);
      }
    }
    db.run("COMMIT");
    persist();
    response.json({ success: true });
  } catch (err) {
    try { db.run("ROLLBACK"); } catch {}
    response.status(500).json({ error: "Sıralama güncellenemedi." });
  }
});

app.post("/api/devices", requireAuth, (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const categoryId = request.body?.categoryId ? Number(request.body.categoryId) : null;
  if (!name || name.length > 80) return response.status(400).json({ error: "Masa adı 1–80 karakter olmalıdır." });
  try {
    const nextId = Number(row("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM (SELECT id FROM devices UNION ALL SELECT device_id AS id FROM sessions)").id);
    const id = insert("INSERT INTO devices(id, name, status, category_id, created_at) VALUES (?, ?, 'bos', ?, ?)", [nextId, name, categoryId, now()]);
    response.status(201).json(device(id));
  } catch {
    response.status(409).json({ error: "Bu masa adı zaten kullanılıyor." });
  }
});

app.put("/api/devices/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  const name = String(request.body?.name ?? "").trim();
  const categoryId = request.body?.categoryId ? Number(request.body.categoryId) : null;
  if (!name || name.length > 80) return response.status(400).json({ error: "Masa adı 1–80 karakter olmalıdır." });
  try {
    execute("UPDATE devices SET name = ?, category_id = ? WHERE id = ?", [name, categoryId, id]);
    response.json(device(id));
  } catch {
    response.status(409).json({ error: "Bu masa adı başka bir masa tarafından kullanılıyor." });
  }
});

app.delete("/api/devices/:id", requireAuth, (request, response) => {
  const item = device(Number(request.params.id));
  if (!item) return response.status(404).json({ error: "Masa bulunamadı." });
  if (item.activeSession) return response.status(400).json({ error: "Açık oturumlu masa silinemez." });
  if (row("SELECT id FROM sessions WHERE device_id = ? LIMIT 1", [item.id])) {
    try {
      db.run("BEGIN TRANSACTION");
      db.run("UPDATE sessions SET archived_device_name = COALESCE(archived_device_name, ?), archived_category_name = COALESCE(archived_category_name, ?) WHERE device_id = ?", [item.name, item.categoryName ?? 'Genel', item.id]);
      db.run("UPDATE devices SET name = ?, archived_at = ? WHERE id = ?", [`__archived_${item.id}_${crypto.randomUUID()}`, now(), item.id]);
      db.run("COMMIT");
      persist();
    } catch (error) {
      try { db.run("ROLLBACK"); } catch {}
      return response.status(500).json({ error: "Masa kaldırılamadı." });
    }
    addLog("MASA", `${item.name} masa listesinden kaldırıldı; geçmiş hesapları korundu.`);
    return response.status(204).end();
  }
  execute("DELETE FROM devices WHERE id = ?", [item.id]);
  response.status(204).end();
});

// Session Start
app.post("/api/devices/:id/start", requireAuth, (request, response) => {
  const item = device(Number(request.params.id));
  if (!item) return response.status(404).json({ error: "Cihaz bulunamadı." });
  if (item.status !== "bos") return response.status(400).json({ error: "Yalnızca boş cihazlarda oturum başlatılabilir." });

  const controllerCount = Number(request.body?.controllerCount ?? 1);
  const targetMinutes = request.body?.targetMinutes == null || request.body.targetMinutes === "" ? null : Number(request.body.targetMinutes);
  const isPaid = Boolean(request.body?.isPaid);
  const paymentMethod = request.body?.paymentMethod ? String(request.body.paymentMethod) : null;
  if (!isValidPositiveInteger(controllerCount, 8)) return response.status(400).json({ error: "Kol sayısı 1 ile 8 arasında tam sayı olmalıdır." });
  if (targetMinutes !== null && !isValidPositiveInteger(targetMinutes, maxTargetMinutes)) return response.status(400).json({ error: "Süre 1 ile 1440 dakika arasında tam sayı olmalıdır." });
  if ((isPaid && !validPaymentMethod(paymentMethod)) || (!isPaid && paymentMethod !== null)) return response.status(400).json({ error: "Geçerli bir ödeme yöntemi seçin." });

  // Optional custom start time (backdated sessions)
  let currentTime = now();
  if (request.body?.startedAt) {
    try { currentTime = validateStartedAt(request.body.startedAt); }
    catch (error) { return sendHttpError(response, error); }
  }

  const savedRates = categoryRates(item.categoryId);
  const { hourlyRate: calculatedHourlyRate, first30Rate: calculatedFirst30Rate } = rateForControllers(savedRates, controllerCount);
  let typeLabel = "Süresiz Hesap Açıldı.";
  let prepaidAmount = 0;
  if (targetMinutes) {
     const endTimeMs = new Date(currentTime).getTime() + targetMinutes * 60000;
     const cost = calculateAmount(currentTime, calculatedHourlyRate, calculatedFirst30Rate, new Date(endTimeMs), 0, currentTime, targetMinutes);
     typeLabel = `Süreli Hesap Açıldı. (Tutar: ${cost.toFixed(2)} ₺)`;
     if (isPaid) prepaidAmount = cost;
  }

  transaction(() => {
  db.run(
    "INSERT INTO sessions(device_id, started_at, segment_started_at, accrued_amount, hourly_rate, first_30_rate, controller_count, target_minutes, is_paid, payment_method, prepaid_amount, tariff_rates_json, rounding_step) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [item.id, currentTime, currentTime, calculatedHourlyRate, calculatedFirst30Rate, controllerCount, targetMinutes, isPaid ? 1 : 0, isPaid ? paymentMethod : null, prepaidAmount, JSON.stringify(savedRates), roundingStep()]
  );
  const sessionId = Number(row("SELECT last_insert_rowid() AS id").id);
  recordSessionEvent(sessionId, 'start', `${item.name}: Hesap açıldı. ${controllerCount} kol, ${targetMinutes ? targetMinutes + ' dakika' : 'süresiz'}.`);
  if (prepaidAmount > 0) recordPayment(sessionId, prepaidAmount, paymentMethod, 'prepaid');
  db.run("UPDATE devices SET status = 'mesgul' WHERE id = ?", [item.id]);
  });

  addLog("MASA", `${item.name} ${typeLabel} (${controllerCount}KOL)`);

  response.json(device(item.id));
});


// Conversion preview is calculated by the same pricing function as settlement.
app.get("/api/sessions/:id/history", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  const settlement = row("SELECT paid_game_amount AS paidGameAmount, paid_orders_amount AS paidOrdersAmount, free_game_amount AS freeGameAmount, free_orders_amount AS freeOrdersAmount FROM sessions WHERE id = ?", [id]);
  if (!settlement) return response.status(404).json({ error: "Hesap bulunamadı." });
  const events = rows("SELECT id, type, message, created_at AS createdAt, before_json AS beforeJson, after_json AS afterJson FROM session_events WHERE session_id = ? ORDER BY id", [id]);
  const labels = { prepaid: 'Peşin ödeme', orders: 'Adisyon ödemesi', partial: 'Kısmi ödeme', checkout: 'Kapanış ödemesi', waiver: 'Ücretsiz kapatılan tutar', refund: 'İade', undo: 'Kapanışı geri alma düzeltmesi', legacy_checkout: 'Geçmiş ödeme kaydı' };
  response.json({ complete: events.some(e => e.type === 'start'), settlement, events: [
    ...events.map(e => ({ id: `event-${e.id}`, type: e.type, message: e.message, createdAt: e.createdAt, before: e.beforeJson ? JSON.parse(e.beforeJson) : null, after: JSON.parse(e.afterJson) })),
    ...ledgerForSession(id).map(p => ({ id: `payment-${p.id}`, type: 'payment', message: `${labels[p.kind] ?? 'Ödeme'}: ${p.amount.toFixed(2)} ₺ · ${p.paymentMethod === 'ucretsiz' ? 'Ücretsiz' : p.paymentMethod === 'nakit' ? 'Nakit' : 'Kredi Kartı'}`, createdAt: p.createdAt, timestampEstimated: Boolean(p.timestampEstimated) })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
});

app.post("/api/sessions/:id/quote", requireAuth, (request, response) => {
  const s = row("SELECT started_at AS startedAt, hourly_rate AS hourlyRate, tariff_rates_json AS tariffRatesJson, rounding_step AS roundingStep, first_30_rate AS first30Rate, accrued_amount AS accruedAmount, segment_started_at AS segmentStartedAt, target_minutes AS targetMinutes, package_amount AS packageAmount FROM sessions WHERE id = ? AND ended_at IS NULL", [Number(request.params.id)]);
  if (!s) return response.status(404).json({ error: "Açık oturum bulunamadı." });
  const cost = minutes => s.targetMinutes === minutes && s.packageAmount != null ? s.packageAmount
    : calculateAmount(s.startedAt, s.hourlyRate, s.first30Rate, new Date(), s.accruedAmount ?? 0, s.segmentStartedAt, minutes, s.roundingStep);
  let minutes = Number(request.body?.targetMinutes);
  if (request.body?.targetPrice !== undefined) {
    const price = Number(request.body.targetPrice);
    if (!isValidMoney(price) || cost(1) > price) return response.status(400).json({ error: "Girilen tutar bu oturumun hesaplanan ücretini karşılamıyor." });
    let low = 1, high = maxTargetMinutes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (cost(middle) <= price) low = middle; else high = middle - 1;
    }
    minutes = low;
  }
  if (!isValidPositiveInteger(minutes, maxTargetMinutes)) return response.status(400).json({ error: "Süre 1 ile 1440 dakika arasında tam sayı olmalıdır." });
  response.json({ targetMinutes: minutes, timeAmount: cost(minutes) });
});

// Update active session
app.put("/api/sessions/:id", requireAuth, (request, response) => {
  const sessionId = Number(request.params.id);
  const activeSession = row("SELECT id, device_id AS deviceId, started_at AS startedAt, segment_started_at AS segmentStartedAt, accrued_amount AS accruedAmount, controller_count AS controllerCount, target_minutes AS targetMinutes, package_amount AS packageAmount, hourly_rate AS hourlyRate, tariff_rates_json AS tariffRatesJson, rounding_step AS roundingStep, first_30_rate AS first30Rate, is_paid AS isPaid, payment_method AS paymentMethod, prepaid_amount AS prepaidAmount FROM sessions WHERE id = ? AND ended_at IS NULL", [sessionId]);
  if (!activeSession) return response.status(404).json({ error: "Açık oturum bulunamadı." });
  const historyBefore = sessionSnapshot(sessionId);

  const requestedControllerCount = request.body?.controllerCount === undefined ? activeSession.controllerCount : Number(request.body.controllerCount);
  const requestedTargetMinutes = request.body?.targetMinutes;
  const newControllerCount = requestedControllerCount;
  const newTargetMinutes = requestedTargetMinutes !== undefined ? (requestedTargetMinutes == null || requestedTargetMinutes === "" ? null : Number(requestedTargetMinutes)) : activeSession.targetMinutes;
  const newIsPaid = request.body?.isPaid !== undefined ? Boolean(request.body.isPaid) : Boolean(activeSession.isPaid);
  const newPaymentMethod = request.body?.paymentMethod !== undefined ? (request.body.paymentMethod ? String(request.body.paymentMethod) : null) : activeSession.paymentMethod;
  if (!isValidPositiveInteger(newControllerCount, 8)) return response.status(400).json({ error: "Kol sayısı 1 ile 8 arasında tam sayı olmalıdır." });
  if (newTargetMinutes !== null && !isValidPositiveInteger(newTargetMinutes, maxTargetMinutes)) return response.status(400).json({ error: "Süre 1 ile 1440 dakika arasında tam sayı olmalıdır." });
  if ((newIsPaid && !validPaymentMethod(newPaymentMethod)) || (!newIsPaid && newPaymentMethod !== null)) return response.status(400).json({ error: "Geçerli bir ödeme yöntemi seçin." });

  if (partialTotal(sessionId) > 0 && newIsPaid !== Boolean(activeSession.isPaid)) {
    return response.status(400).json({ error: "Kısmi ödeme alınmış masanın kalanını ödeme ekranından tahsil edin." });
  }
  const currentTime = now();
  let updatedAccruedAmount = Number(activeSession.accruedAmount ?? 0);
  let updatedSegmentStartedAt = activeSession.segmentStartedAt ?? activeSession.startedAt;

  let newStartedAt = activeSession.startedAt;
  if (request.body?.startedAt) {
    try { newStartedAt = validateStartedAt(request.body.startedAt); }
    catch (error) { return sendHttpError(response, error); }
    if (Number(activeSession.accruedAmount ?? 0) === 0) {
      updatedSegmentStartedAt = newStartedAt;
    }
  }

  const item = device(activeSession.deviceId);
  const { hourlyRate: calculatedHourlyRate, first30Rate: preservedFirst30Rate } = rateForControllers(sessionRates(activeSession), newControllerCount);
  const rateChanged = calculatedHourlyRate !== activeSession.hourlyRate || preservedFirst30Rate !== activeSession.first30Rate;
  if (newStartedAt !== activeSession.startedAt) {
    updatedSegmentStartedAt = rateChanged ? currentTime : new Date(Math.max(new Date(newStartedAt).getTime(), new Date(activeSession.segmentStartedAt ?? activeSession.startedAt).getTime())).toISOString();
    // When the opening segment has never changed, its start follows the correction.
    const rateHistory = rows("SELECT before_json AS beforeJson, after_json AS afterJson FROM session_events WHERE session_id = ? AND before_json IS NOT NULL", [sessionId]).some(e => {
      const before = JSON.parse(e.beforeJson), after = JSON.parse(e.afterJson);
      return before.hourlyRate !== after.hourlyRate || before.first30Rate !== after.first30Rate;
    });
    if (!rateChanged && !rateHistory && (activeSession.segmentStartedAt ?? activeSession.startedAt) === activeSession.startedAt && !activeSession.accruedAmount) updatedSegmentStartedAt = newStartedAt;
    try { updatedAccruedAmount = replayAccrued(activeSession, newStartedAt, updatedSegmentStartedAt, newTargetMinutes, activeSession.roundingStep); }
    catch (error) { return response.status(400).json({ error: error.message }); }
  } else if (rateChanged) {
    const from = Math.max(0, (new Date(updatedSegmentStartedAt).getTime() - new Date(newStartedAt).getTime()) / 60000);
    const to = Math.max(from, Math.min((Date.now() - new Date(newStartedAt).getTime()) / 60000, activeSession.targetMinutes ?? Infinity));
    updatedAccruedAmount += segmentPrice(from, to, activeSession.hourlyRate, activeSession.first30Rate ?? activeSession.hourlyRate / 2);
    updatedSegmentStartedAt = currentTime;
  }
  const packageAmount = newTargetMinutes && newControllerCount === activeSession.controllerCount
    && newTargetMinutes === activeSession.targetMinutes && newStartedAt === activeSession.startedAt
    ? activeSession.packageAmount : null;

  let newPrepaidAmount = Number(activeSession.prepaidAmount ?? 0);
  const includeOrders = request.body?.includeOrders === true;
  if (request.body?.includeOrders !== undefined && (typeof request.body.includeOrders !== 'boolean' || !newIsPaid || !newTargetMinutes || activeSession.isPaid)) {
    return response.status(409).json({ error: "Bu hesabın ödeme durumu değişmiş. Güncel hesabı kontrol edip tekrar deneyin." });
  }
  let orderPayment = 0;
  if (newIsPaid && newTargetMinutes && !activeSession.isPaid) {
     const sessionStartMs = new Date(newStartedAt).getTime();
     const endTimeMs = sessionStartMs + newTargetMinutes * 60000;
     const cost = packageAmount ?? calculateAmount(newStartedAt, calculatedHourlyRate, preservedFirst30Rate, new Date(endTimeMs), updatedAccruedAmount, updatedSegmentStartedAt, newTargetMinutes, activeSession.roundingStep);
     newPrepaidAmount = Math.max(newPrepaidAmount, cost);
     if (includeOrders) orderPayment = roundCents(Math.max(0, cost + ordersTotalForSession(sessionId) - collectedTotal(sessionId) - (newPrepaidAmount - Number(activeSession.prepaidAmount ?? 0))));
  }
  const receiptAmount = roundCents(newPrepaidAmount - Number(activeSession.prepaidAmount ?? 0) + orderPayment);
  if (request.body?.expectedAmount !== undefined && (!isValidMoney(request.body.expectedAmount) || Math.abs(request.body.expectedAmount - receiptAmount) > 0.001)) {
    return response.status(409).json({ error: "Tahsil edilecek tutar değişti. Güncel tutarı kontrol edip yeniden onaylayın." });
  }
  const paymentParts = splitPayments(request.body?.payments, receiptAmount);
  if (paymentParts === false || (paymentParts && (!newIsPaid || Boolean(activeSession.isPaid) || paymentParts[0].paymentMethod !== newPaymentMethod))) {
    return response.status(409).json({ error: "Ödeme payları güncel tahsil edilecek tutarla eşleşmiyor. Hesabı kontrol edin." });
  }

  transaction(() => {
  db.run(
    "UPDATE sessions SET started_at = ?, controller_count = ?, target_minutes = ?, package_amount = ?, hourly_rate = ?, first_30_rate = ?, accrued_amount = ?, segment_started_at = ?, is_paid = ?, payment_method = ?, prepaid_amount = ? WHERE id = ?",
    [newStartedAt, newControllerCount, newTargetMinutes, packageAmount, calculatedHourlyRate, preservedFirst30Rate, updatedAccruedAmount, updatedSegmentStartedAt, newIsPaid ? 1 : 0, newIsPaid ? newPaymentMethod : null, newPrepaidAmount, sessionId]
  );
  if (paymentParts) {
    let gameLeft = roundCents(newPrepaidAmount - Number(activeSession.prepaidAmount ?? 0));
    for (const part of paymentParts) {
      const gamePart = roundCents(Math.min(part.amount, gameLeft));
      recordPayment(sessionId, gamePart, part.paymentMethod, 'prepaid');
      recordPayment(sessionId, roundCents(part.amount - gamePart), part.paymentMethod, 'orders');
      gameLeft = roundCents(gameLeft - gamePart);
    }
  } else {
    if (newPrepaidAmount > Number(activeSession.prepaidAmount ?? 0)) recordPayment(sessionId, newPrepaidAmount - Number(activeSession.prepaidAmount ?? 0), newPaymentMethod, 'prepaid');
    if (orderPayment > 0) recordPayment(sessionId, orderPayment, newPaymentMethod, 'orders');
  }
  const historyChanges = [];
  if (newControllerCount !== activeSession.controllerCount) historyChanges.push(`Kol değişimi: ${activeSession.controllerCount} → ${newControllerCount}`);
  if (newTargetMinutes !== activeSession.targetMinutes) historyChanges.push(`Süre değişimi: ${activeSession.targetMinutes ? activeSession.targetMinutes + ' dk' : 'Süresiz'} → ${newTargetMinutes ? newTargetMinutes + ' dk' : 'Süresiz'}`);
  if (newStartedAt !== activeSession.startedAt) historyChanges.push(`Başlangıç saati değişimi: ${activeSession.startedAt} → ${newStartedAt}`);
  if (newIsPaid !== Boolean(activeSession.isPaid)) historyChanges.push(newIsPaid ? 'Peşin ödeme durumu açıldı' : 'Peşin ödeme durumu kaldırıldı');
  if (historyChanges.length) recordSessionEvent(sessionId, 'update', historyChanges.join(' · '), historyBefore, currentTime);
  });

  const changes = [];
  if (newStartedAt !== activeSession.startedAt) {
    const oldTimeStr = new Date(activeSession.startedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    const newTimeStr = new Date(newStartedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    changes.push(`Açılış Saati Güncellendi: ${oldTimeStr} → ${newTimeStr}`);
  }
  if (newControllerCount !== Number(activeSession.controllerCount)) {
    changes.push(`Kol Sayısı Değiştirildi: ${activeSession.controllerCount} → ${newControllerCount} Kol`);
  }
  if (newTargetMinutes !== (activeSession.targetMinutes ? Number(activeSession.targetMinutes) : null)) {
    if (!activeSession.targetMinutes && newTargetMinutes) {
      changes.push(`Süreliye Çevrildi: ${newTargetMinutes} Dk`);
    } else if (activeSession.targetMinutes && !newTargetMinutes) {
      changes.push(`Süresize Çevrildi (Eskiden: ${activeSession.targetMinutes} Dk)`);
    } else if (newTargetMinutes > Number(activeSession.targetMinutes)) {
      changes.push(`Süre Eklendi: ${activeSession.targetMinutes} → ${newTargetMinutes} Dk (+${newTargetMinutes - Number(activeSession.targetMinutes)} Dk)`);
    } else {
      changes.push(`Süre Düşüldü: ${activeSession.targetMinutes} → ${newTargetMinutes} Dk (-${Number(activeSession.targetMinutes) - newTargetMinutes} Dk)`);
    }
  }
  if (newIsPaid !== Boolean(activeSession.isPaid)) {
    const methodLabel = paymentParts ? [...new Set(paymentParts.map(part => part.paymentMethod))].map(method => method === 'nakit' ? 'Nakit' : 'Kredi Kartı').join(' + ') : newPaymentMethod === 'kredi_karti' ? 'Kredi Kartı' : 'Nakit';
    changes.push(newIsPaid ? `Ücret Peşin Ödendi (${methodLabel})` : `Ödeme Durumu İptal Edildi`);
  }
  for (const change of changes) {
    addLog("MASA", `${item?.name ?? 'Masa'}: ${change}.`);
  }
  if (changes.length === 0) {
    addLog("MASA", `${item?.name ?? 'Masa'} masası güncellendi.`);
  }

  response.json(device(activeSession.deviceId));
});


// Adisyon / Order routes
app.post("/api/sessions/:id/orders", requireAuth, (request, response) => {
  const sessionId = Number(request.params.id);
  const productName = String(request.body?.productName ?? "").trim();
  const unitPrice = Number(request.body?.unitPrice ?? 0);
  const quantity = Number(request.body?.quantity ?? 1);

  if (!isValidPositiveInteger(sessionId, Number.MAX_SAFE_INTEGER)) return response.status(400).json({ error: "Geçerli oturum seçin." });
  if (!productName || !isValidMoney(unitPrice) || !isValidPositiveInteger(quantity, maxQuantity)) return response.status(400).json({ error: "Geçerli ürün adı, fiyat ve adet gereklidir." });
  const activeSession = row("SELECT id FROM sessions WHERE id = ? AND ended_at IS NULL", [sessionId]);
  if (!activeSession) return response.status(400).json({ error: "Yalnızca açık oturumlara adisyon eklenebilir." });

  const totalPrice = roundCents(unitPrice * quantity);
  transaction(() => {
    db.run("INSERT INTO order_items(session_id, product_name, unit_price, quantity, total_price, created_at) VALUES (?, ?, ?, ?, ?, ?)", [sessionId, productName, unitPrice, quantity, totalPrice, now()]);
    recordSessionEvent(sessionId, 'order_add', `Adisyon eklendi: ${quantity} × ${productName} · Birim ${unitPrice.toFixed(2)} ₺ · Toplam ${totalPrice.toFixed(2)} ₺`);
  });

  const dev = row("SELECT name FROM devices WHERE id = (SELECT device_id FROM sessions WHERE id = ?)", [sessionId]);
  addLog("ADİSYON", `${dev?.name ?? 'Bilinmeyen Masa'} masasına ${quantity}x ${productName} eklendi.`);

  response.status(201).json(ordersForSession(sessionId));
});

app.delete("/api/orders/:id", requireAuth, (request, response) => {
  const orderId = Number(request.params.id);
  const order = row("SELECT o.id, o.session_id AS sessionId, o.product_name AS productName, o.unit_price AS unitPrice, o.quantity, o.total_price AS totalPrice, s.ended_at AS endedAt FROM order_items o JOIN sessions s ON s.id = o.session_id WHERE o.id = ?", [orderId]);
  if (!order) return response.status(404).json({ error: "Adisyon kalemi bulunamadı." });
  if (order.endedAt) return response.status(400).json({ error: "Kapatılmış oturumun adisyonu değiştirilemez." });
  transaction(() => {
    db.run("DELETE FROM order_items WHERE id = ?", [orderId]);
    recordSessionEvent(order.sessionId, 'order_remove', `Adisyon silindi: ${order.quantity} × ${order.productName} · Birim ${order.unitPrice.toFixed(2)} ₺ · Toplam ${order.totalPrice.toFixed(2)} ₺`);
  });
  response.status(204).end();
});

// Direct order sales
app.post("/api/direct-sales", requireAuth, (request, response) => {
  const paymentMethod = String(request.body?.paymentMethod ?? "nakit");
  const items = request.body?.items ?? [];

  if (!Array.isArray(items) || items.length === 0) {
    return response.status(400).json({ error: "Sepet boş olamaz." });
  }
  if (!validPaymentMethod(paymentMethod)) return response.status(400).json({ error: "Geçerli bir ödeme yöntemi seçin." });

  let totalAmount = 0;
  for (const item of items) {
    const productName = String(item.productName ?? "").trim();
    const qty = Number(item.quantity ?? 1);
    const price = Number(item.unitPrice ?? 0);
    if (!productName || !isValidPositiveInteger(qty, maxQuantity) || !isValidMoney(price)) return response.status(400).json({ error: "Her ürün için geçerli ad, fiyat ve adet girin." });
    totalAmount += (price * qty);
  }
  totalAmount = roundCents(totalAmount);
  if (!isValidMoney(totalAmount)) return response.status(400).json({ error: "Toplam satış tutarı geçersiz." });

  const saleId = insert("INSERT INTO direct_sales(total_amount, payment_method, created_at) VALUES (?, ?, ?)", [totalAmount, paymentMethod, now()]);

  if (saleId) {
    for (const item of items) {
      const productName = String(item.productName ?? "").trim();
      const qty = Number(item.quantity ?? 1);
      const unitPrice = Number(item.unitPrice ?? 0);
      const totalPrice = roundCents(unitPrice * qty);
      execute("INSERT INTO direct_sale_items(sale_id, product_name, unit_price, quantity, total_price) VALUES (?, ?, ?, ?, ?)", [saleId, productName, unitPrice, qty, totalPrice]);
    }
  }

  addLog("ADİSYON", `Direkt Adisyon Satışı yapıldı. (Tutar: ${totalAmount} ₺, Ödeme: ${paymentMethod === 'nakit' ? 'Nakit' : 'Kredi Kartı'})`);
  response.status(201).json({ success: true, saleId, totalAmount, paymentMethod });
});

// Partial collection keeps the session and its timer open.
app.post("/api/sessions/:id/payments", requireAuth, (request, response) => {
  const sessionId = Number(request.params.id);
  const active = row("SELECT device_id AS deviceId FROM sessions WHERE id = ? AND ended_at IS NULL", [sessionId]);
  if (!active) return response.status(400).json({ error: "Açık oturum bulunamadı." });
  const item = device(active.deviceId);
  const session = item.activeSession;
  if (session.targetMinutes && session.isPaid) return response.status(400).json({ error: "Bu süreli masanın ücreti zaten alınmış." });
  const amount = request.body?.amount;
  const method = request.body?.paymentMethod;
  if (typeof amount !== "number" || !isValidMoney(amount) || Math.abs(amount - roundCents(amount)) > 0.000001 || !validPaymentMethod(method)) {
    return response.status(400).json({ error: "Geçerli bir tutar ve ödeme yöntemi seçin." });
  }
  const total = (session.targetMinutes && session.packageAmount != null ? session.packageAmount : calculateAmount(session.startedAt, session.hourlyRate, session.first30Rate, new Date(), session.accruedAmount ?? 0, session.segmentStartedAt, session.targetMinutes, session.roundingStep)) + (session.ordersTotal ?? 0);
  const remaining = roundCents(Math.max(0, total - session.collectedAmount));
  if (amount > remaining) return response.status(400).json({ error: "Ödeme kalan hesap tutarını aşamaz." });
  const gameCredit = roundCents(Math.min(amount, Math.max(0, session.gameAmount - session.gamePaymentCredit)));
  insert("INSERT INTO session_payments(session_id, amount, payment_method, created_at, game_credit) VALUES (?, ?, ?, ?, ?)", [sessionId, amount, method, now(), gameCredit]);
  addLog("HESAP", `${item.name} Kısmi ödeme alındı. (Tutar: ${amount} ₺, Ödeme: ${method === "nakit" ? "Nakit" : "Kredi Kartı"})`);
  response.status(201).json({ device: device(item.id) });
});

function resolveCheckoutStopDate(session, body) {
  if (body?.useCheckoutHold !== true) return new Date();
  if (!session.checkoutHeldAt) throw HttpError(409, "Kapanış zamanı kilitlenmemiş. Kapanış ekranını yeniden açın.");
  const held = new Date(session.checkoutHeldAt);
  const started = new Date(session.startedAt).getTime();
  if (Number.isNaN(held.getTime()) || held.getTime() < started) throw HttpError(400, "Geçerli ve oturum başlangıcından sonraki bir bitiş zamanı girin.");
  return held.getTime() > Date.now() ? new Date() : held;
}

app.post("/api/devices/:id/checkout-hold", requireAuth, (request, response) => {
  try {
    const item = device(Number(request.params.id));
    if (!item?.activeSession) throw HttpError(400, "Açık oturum bulunamadı.");
    requireMatchingSession(item.activeSession.id, request.body);
    const heldAt = now();
    transaction(() => {
      const live = device(item.id);
      if (!live?.activeSession) throw HttpError(400, "Açık oturum bulunamadı.");
      requireMatchingSession(live.activeSession.id, request.body);
      db.run("UPDATE sessions SET checkout_held_at = ? WHERE id = ? AND ended_at IS NULL", [heldAt, live.activeSession.id]);
    });
    const updated = device(item.id);
    response.json({ endedAt: heldAt, device: updated });
  } catch (error) {
    return sendHttpError(response, error);
  }
});

app.post("/api/devices/:id/checkout-release", requireAuth, (request, response) => {
  try {
    const item = device(Number(request.params.id));
    if (!item?.activeSession) throw HttpError(400, "Açık oturum bulunamadı.");
    requireMatchingSession(item.activeSession.id, request.body);
    db.run("UPDATE sessions SET checkout_held_at = NULL WHERE id = ? AND ended_at IS NULL", [item.activeSession.id]);
    response.json({ device: device(item.id) });
  } catch (error) {
    return sendHttpError(response, error);
  }
});

// Stop session (Checkout)
app.post("/api/devices/:id/stop", requireAuth, (request, response) => {
  let item;
  let stopDate;
  try {
    item = device(Number(request.params.id));
    if (!item?.activeSession) throw HttpError(400, "Açık oturum bulunamadı.");
    requireMatchingSession(item.activeSession.id, request.body);
    stopDate = resolveCheckoutStopDate(item.activeSession, request.body);
  } catch (error) {
    return sendHttpError(response, error);
  }

  const paymentMethod = String(request.body?.paymentMethod ?? "nakit");
  if (!validPaymentMethod(paymentMethod, { allowFree: true })) return response.status(400).json({ error: "Geçerli bir ödeme yöntemi seçin." });
  if (stopDate.getTime() < new Date(item.activeSession.startedAt).getTime()) return response.status(400).json({ error: "Geçerli ve oturum başlangıcından sonraki bir bitiş zamanı girin." });

  const timeAmount = item.activeSession.targetMinutes && item.activeSession.packageAmount != null
    ? item.activeSession.packageAmount : calculateAmount(
    item.activeSession.startedAt,
    item.activeSession.hourlyRate,
    item.activeSession.first30Rate,
    stopDate,
    item.activeSession.accruedAmount ?? 0,
    item.activeSession.segmentStartedAt,
    item.activeSession.targetMinutes, item.activeSession.roundingStep
  );

  const ordersTotal = item.activeSession.ordersTotal ?? 0;
  let totalAmount = roundCents(timeAmount + ordersTotal);
  const paymentParts = splitPayments(request.body?.payments, roundCents(Math.max(0, totalAmount - collectedTotal(item.activeSession.id))));
  if (paymentParts === false || (paymentParts && (paymentMethod === "ucretsiz" || paymentParts[0].paymentMethod !== paymentMethod))) {
    return response.status(409).json({ error: "Ödeme payları güncel tahsil edilecek tutarla eşleşmiyor. Hesabı kontrol edin." });
  }

  const isPrepaid = Boolean(item.activeSession.isPaid);
  const prepaidAmount = item.activeSession.prepaidAmount ?? 0;

  let finalPaymentMethod = paymentMethod;
  let checkoutPaymentMethod = null;
  let checkoutAmount = null;

  if (isPrepaid && prepaidAmount > 0 && paymentMethod !== 'ucretsiz') {
    finalPaymentMethod = item.activeSession.paymentMethod || "nakit";
    const amountToCollect = Math.max(0, totalAmount - prepaidAmount);

    if (amountToCollect > 0) {
      checkoutPaymentMethod = paymentMethod;
      checkoutAmount = amountToCollect;
    }
  }

  const partialAmount = partialTotal(item.activeSession.id);
  if (collectedTotal(item.activeSession.id) > 0) {
    checkoutAmount = paymentMethod === "ucretsiz" ? 0 : roundCents(Math.max(0, totalAmount - collectedTotal(item.activeSession.id)));
    checkoutPaymentMethod = paymentMethod;
  }

  const refundAmount = Math.max(0, roundCents(collectedTotal(item.activeSession.id) - totalAmount));
  const historyBefore = sessionSnapshot(item.activeSession.id);
  try {
  transaction(() => {
    const live = device(item.id);
    if (!live?.activeSession) throw HttpError(400, "Açık oturum bulunamadı.");
    requireMatchingSession(live.activeSession.id, request.body);
    stopDate = resolveCheckoutStopDate(live.activeSession, request.body);
    // Financial movement uses the actual collection time, not the timer's frozen
    // checkout time (a dialog may have been opened before midnight).
    if (paymentParts) {
      const paidAt = now();
      for (const part of paymentParts) recordPayment(item.activeSession.id, part.amount, part.paymentMethod, 'checkout', paidAt);
    } else if (paymentMethod === 'ucretsiz') {
      const paid = collectedTotal(item.activeSession.id);
      if (paid > totalAmount) settlePayments(item.activeSession.id, totalAmount, 'nakit');
      recordPayment(item.activeSession.id, Math.max(0, roundCents(totalAmount - collectedTotal(item.activeSession.id))), 'ucretsiz', 'waiver');
    } else {
      settlePayments(item.activeSession.id, totalAmount, paymentMethod);
    }
    const allocation = allocateSessionSettlement(timeAmount, ordersTotal, ledgerForSession(item.activeSession.id), paymentMethod === 'ucretsiz');
    const allocatedTotal = roundCents(allocation.paidGameAmount + allocation.paidOrdersAmount + allocation.freeGameAmount + allocation.freeOrdersAmount);
    if (allocation.unallocatedAmount > 0 || allocatedTotal !== totalAmount) throw new Error('Kapanış ödeme dağılımı hesapla eşleşmiyor.');
    db.run("UPDATE sessions SET ended_at = ?, total_amount = ?, payment_method = ?, closure_method = ?, checkout_payment_method = ?, checkout_amount = ?, paid_game_amount = ?, paid_orders_amount = ?, free_game_amount = ?, free_orders_amount = ?, checkout_held_at = NULL WHERE id = ?", [stopDate.toISOString(), totalAmount, paymentMethod === 'ucretsiz' ? 'ucretsiz' : finalPaymentMethod, paymentMethod, checkoutPaymentMethod, checkoutAmount, allocation.paidGameAmount, allocation.paidOrdersAmount, allocation.freeGameAmount, allocation.freeOrdersAmount, item.activeSession.id]);
    db.run("UPDATE sessions SET archived_device_name = ?, archived_category_name = ? WHERE id = ?", [item.name, item.categoryName ?? 'Genel', item.activeSession.id]);
    db.run("UPDATE devices SET status = 'bos' WHERE id = ?", [item.id]);
    recordSessionEvent(item.activeSession.id, 'close', paymentMethod === 'ucretsiz' ? 'Hesap ücretsiz kapatıldı; önceki tahsilatlar korundu.' : `Hesap kapatıldı. Toplam: ${totalAmount.toFixed(2)} ₺.`, historyBefore);
  });
  } catch (error) {
    return sendHttpError(response, error);
  }

  let paymentMethodLabel = paymentMethod === "ucretsiz" ? "Ücretsiz" : paymentMethod === "kredi_karti" ? "Kredi Kartı" : "Nakit";
  if (paymentParts) paymentMethodLabel = [...new Set(paymentParts.map(part => part.paymentMethod))].map(method => method === 'nakit' ? 'Nakit' : 'Kredi Kartı').join(' + ');
  if (isPrepaid && prepaidAmount > 0 && checkoutAmount > 0) {
     const checkoutLabel = paymentParts ? paymentMethodLabel : checkoutPaymentMethod === "kredi_karti" ? "Kredi Kartı" : "Nakit";
     paymentMethodLabel = `Peşin + ${checkoutLabel}`;
  }

  addLog("HESAP", `${item.name} Hesap Kesildi. (${item.activeSession.controllerCount}KOL) (Tutar: ${totalAmount} ₺, Ödeme: ${paymentMethodLabel})`);

  response.json({ device: device(item.id), amount: totalAmount, timeAmount, ordersTotal, paymentMethod, refundAmount });
});

// Undo Checkout
app.post("/api/devices/:id/undo", requireAuth, (request, response) => {
  const item = device(Number(request.params.id));
  if (!item) return response.status(404).json({ error: "Masa bulunamadı." });
  if (item.activeSession) return response.status(400).json({ error: "Bu masa zaten açık. Önce mevcut hesabı kapatmalısınız." });

  const lastSession = row("SELECT id, prepaid_amount AS prepaidAmount, payment_method AS paymentMethod FROM sessions WHERE device_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1", [item.id]);
  if (!lastSession) return response.status(400).json({ error: "Geri alınacak hesap bulunamadı." });
  try { requireMatchingSession(lastSession.id, request.body); }
  catch (error) { return sendHttpError(response, error); }
  const historyBefore = sessionSnapshot(lastSession.id);
  const prepaidMethod = ledgerForSession(lastSession.id).find(payment => payment.kind === 'prepaid')?.paymentMethod ?? (validPaymentMethod(lastSession.paymentMethod) ? lastSession.paymentMethod : null);

  try {
  transaction(() => {
    const locked = row("SELECT id FROM sessions WHERE device_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1", [item.id]);
    if (!locked) throw HttpError(400, "Geri alınacak hesap bulunamadı.");
    requireMatchingSession(locked.id, request.body);
    const keep = new Map();
    const ledger = ledgerForSession(lastSession.id);
    for (const payment of ledger.filter(p => ['partial', 'orders', 'prepaid'].includes(p.kind))) keep.set(payment.paymentMethod, (keep.get(payment.paymentMethod) ?? 0) + payment.amount);
    const method = validPaymentMethod(lastSession.paymentMethod) ? lastSession.paymentMethod : 'nakit';
    if (!ledger.some(p => p.kind === 'prepaid')) keep.set(method, (keep.get(method) ?? 0) + Number(lastSession.prepaidAmount ?? 0));
    const balances = new Map();
    for (const payment of ledger) balances.set(payment.paymentMethod, (balances.get(payment.paymentMethod) ?? 0) + payment.amount);
    for (const paymentMethod of new Set([...keep.keys(), ...balances.keys()])) recordPayment(lastSession.id, (keep.get(paymentMethod) ?? 0) - (balances.get(paymentMethod) ?? 0), paymentMethod, 'undo');
    db.run("UPDATE sessions SET ended_at = NULL, total_amount = NULL, checkout_amount = NULL, checkout_payment_method = NULL, closure_method = NULL, paid_game_amount = NULL, paid_orders_amount = NULL, free_game_amount = NULL, free_orders_amount = NULL, archived_device_name = NULL, archived_category_name = NULL, checkout_held_at = NULL, payment_method = CASE WHEN is_paid = 1 THEN ? ELSE NULL END WHERE id = ?", [prepaidMethod, lastSession.id]);
    db.run("UPDATE devices SET status = 'mesgul' WHERE id = ?", [item.id]);
    recordSessionEvent(lastSession.id, 'reopen', 'Kapanış geri alındı; hesap yeniden açıldı.', historyBefore);
  });
  } catch (error) {
    return sendHttpError(response, error);
  }

  addLog("HESAP", `${item.name} Kapatılan Hesap Geri Alındı (Yeniden Açıldı).`);

  response.json({ device: device(item.id) });
});

// Transfer / Move Session to Another Device
app.post("/api/devices/:id/transfer", requireAuth, (request, response) => {
  const sourceDeviceId = Number(request.params.id);
  const targetDeviceId = Number(request.body?.targetDeviceId);
  if (!targetDeviceId || sourceDeviceId === targetDeviceId) {
    return response.status(400).json({ error: "Geçerli bir hedef masa seçin." });
  }
  const sourceItem = device(sourceDeviceId);
  const targetItem = device(targetDeviceId);
  if (!sourceItem || !targetItem) return response.status(404).json({ error: "Masa bulunamadı." });
  if (sourceItem.status !== "mesgul" || !sourceItem.activeSession) {
    return response.status(400).json({ error: "Kaynak masada açık oturum yok." });
  }
  try { requireMatchingSession(sourceItem.activeSession.id, request.body); }
  catch (error) { return sendHttpError(response, error); }
  if (targetItem.status !== "bos") {
    return response.status(400).json({ error: "Hedef masa boş değil." });
  }

  const session = sourceItem.activeSession;
  const historyBefore = sessionSnapshot(session.id);
  const transferTime = now();
  const startMs = new Date(session.startedAt).getTime();
  const elapsedMinutes = Math.max(0, (new Date(transferTime).getTime() - startMs) / 60_000);
  const segmentStartMinutes = Math.max(0, (new Date(session.segmentStartedAt ?? session.startedAt).getTime() - startMs) / 60_000);
  const playedUntil = Math.max(segmentStartMinutes, Math.min(elapsedMinutes, session.targetMinutes ?? Infinity));
  const oldFirst30 = session.first30Rate != null ? Number(session.first30Rate) : session.hourlyRate / 2;
  const accruedAmount = (Number(session.accruedAmount) || 0)
    + segmentPrice(segmentStartMinutes, playedUntil, session.hourlyRate, oldFirst30);

  const targetRates = categoryRates(targetItem.categoryId);
  const { hourlyRate: newHourlyRate, first30Rate: newFirst30Rate } = rateForControllers(targetRates, session.controllerCount);

  // Identical tariffs keep the exact pricing state and deadline, including their
  // original rounding anchors. Moving alone must never consume a minute.
  if (newHourlyRate === session.hourlyRate && newFirst30Rate === oldFirst30) {
    try {
    transaction(() => {
      const live = device(sourceDeviceId);
      if (!live?.activeSession) throw HttpError(400, "Kaynak masada açık oturum yok.");
      requireMatchingSession(live.activeSession.id, request.body);
      if (device(targetDeviceId)?.status !== "bos") throw HttpError(400, "Hedef masa boş değil.");
      db.run("UPDATE sessions SET device_id = ?, tariff_rates_json = ? WHERE id = ?", [targetDeviceId, JSON.stringify(targetRates), session.id]);
      db.run("UPDATE devices SET status = 'bos' WHERE id = ?", [sourceDeviceId]);
      db.run("UPDATE devices SET status = 'mesgul' WHERE id = ?", [targetDeviceId]);
      recordSessionEvent(session.id, 'transfer', `Masa aktarımı: ${sourceItem.name} → ${targetItem.name}. Tarife ve süre korundu.`, historyBefore, transferTime);
    });
    } catch (error) {
      return sendHttpError(response, error);
    }
    addLog("MASA", `${sourceItem.name} masası ${targetItem.name} masasına taşındı.`);
    return response.json({ success: true, source: device(sourceDeviceId), target: device(targetDeviceId) });
  }

  let targetMinutes = session.targetMinutes;
  let packageAmount = session.packageAmount ?? null;
  if (targetMinutes) {
    packageAmount ??= calculateAmount(session.startedAt, session.hourlyRate, session.first30Rate,
      new Date(startMs + targetMinutes * 60_000), session.accruedAmount ?? 0,
      session.segmentStartedAt, targetMinutes, session.roundingStep);
    // An expired package cannot gain new minutes by changing tables.
    if (elapsedMinutes < targetMinutes) {
      const candidateCost = (minutes) => calculateAmount(session.startedAt, newHourlyRate, newFirst30Rate,
        new Date(startMs + minutes * 60_000), accruedAmount, transferTime, minutes, session.roundingStep);
      const firstFutureMinute = Math.min(maxTargetMinutes, Math.max(1, Math.ceil(elapsedMinutes)));
      let low = firstFutureMinute;
      let high = maxTargetMinutes;
      if (candidateCost(low) > packageAmount + 1e-8) {
        targetMinutes = low;
      } else {
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (candidateCost(middle) <= packageAmount + 1e-8) low = middle;
          else high = middle - 1;
        }
        targetMinutes = low;
      }
    }
  }

  // Orders and payment records stay attached to the same session.
  try {
  transaction(() => {
  const live = device(sourceDeviceId);
  if (!live?.activeSession) throw HttpError(400, "Kaynak masada açık oturum yok.");
  requireMatchingSession(live.activeSession.id, request.body);
  if (device(targetDeviceId)?.status !== "bos") throw HttpError(400, "Hedef masa boş değil.");
  db.run("UPDATE sessions SET device_id = ?, segment_started_at = ?, accrued_amount = ?, hourly_rate = ?, first_30_rate = ?, target_minutes = ?, package_amount = ?, tariff_rates_json = ? WHERE id = ?",
    [targetDeviceId, transferTime, accruedAmount, newHourlyRate, newFirst30Rate, targetMinutes, packageAmount, JSON.stringify(targetRates), session.id]);
  db.run("UPDATE devices SET status = 'bos' WHERE id = ?", [sourceDeviceId]);
  db.run("UPDATE devices SET status = 'mesgul' WHERE id = ?", [targetDeviceId]);
  recordSessionEvent(session.id, 'transfer', `Masa aktarımı: ${sourceItem.name} → ${targetItem.name}. Hedef masanın tarifesine geçildi.`, historyBefore, transferTime);
  });
  } catch (error) {
    return sendHttpError(response, error);
  }

  addLog("MASA", `${sourceItem.name} masası ${targetItem.name} masasına taşındı.`);
  response.json({ success: true, source: device(sourceDeviceId), target: device(targetDeviceId) });
});

app.put("/api/settings/hourly-rate", requireAuth, (request, response) => {
  const rate = Number(request.body?.hourlyRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100_000) return response.status(400).json({ error: "Geçerli bir saatlik ücret girin." });
  execute("UPDATE settings SET value = ? WHERE key = 'hourly_rate'", [String(rate)]);
  addLog("AYARLAR", `Varsayılan saatlik ücret ${rate} ₺ olarak güncellendi.`);
  response.json({ hourlyRate: rate });
});

app.get("/api/settings/rounding-step", requireAuth, (_request, response) => response.json({ roundingStep: roundingStep() }));
app.put("/api/settings/rounding-step", requireAuth, (request, response) => {
  const step = Number(request.body?.roundingStep);
  if (!Number.isFinite(step) || step <= 0 || step > 1000 || Math.abs(step * 100 - Math.round(step * 100)) > 1e-8) {
    return response.status(400).json({ error: "Yuvarlama tutari 0 ile 1000 TL arasinda, en fazla iki ondalikli olmali." });
  }
  execute("UPDATE settings SET value = ? WHERE key = 'rounding_step'", [String(step)]);
  response.json({ roundingStep: step });
});

app.get("/api/settings/warning-minutes", requireAuth, (_request, response) => response.json({ warningMinutes: warningMinutes() }));
app.put("/api/settings/warning-minutes", requireAuth, (request, response) => {
  const minutes = request.body?.warningMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxTargetMinutes) {
    return response.status(400).json({ error: "Uyarı süresi 1 ile 1440 dakika arasında tam sayı olmalıdır." });
  }
  execute("UPDATE settings SET value = ? WHERE key = 'warning_minutes'", [String(minutes)]);
  response.json({ warningMinutes: minutes });
});

// Logs route
app.get("/api/logs", requireAuth, (_request, response) => {
  const logs = rows("SELECT id, type, message, created_at AS createdAt FROM activity_logs ORDER BY id DESC LIMIT 200");
  response.json(logs);
});

app.delete("/api/logs/:id", requireAuth, (request, response) => {
  const id = Number(request.params.id);
  const logToDelete = row("SELECT message FROM activity_logs WHERE id = ?", [id]);
  if (logToDelete) {
    execute("DELETE FROM activity_logs WHERE id = ?", [id]);
  }
  response.json({ success: true });
});
// TTS Cache & Proxy Endpoint for natural female Turkish voice
const ttsCache = new Map();
app.get("/api/tts", requireAuth, async (request, response) => {
  const text = String(request.query.text || "").trim();
  if (!text || text.length > maxTtsTextLength) return response.status(400).send("Metin 1-300 karakter olmalıdır.");

  if (ttsCache.has(text)) {
    response.setHeader("Content-Type", "audio/mpeg");
    return response.send(ttsCache.get(text));
  }

  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=tr&client=tw-ob&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("audio/")) throw new Error(`TTS service returned ${res.status} (${res.headers.get("content-type")})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (ttsCache.size >= maxTtsCacheEntries) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(text, buffer);
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Cache-Control", "private, max-age=86400");
    return response.send(buffer);
  } catch (err) {
    console.error("TTS fetch error:", err);
    return response.status(502).send("TTS failed");
  }
});

const staticPath = path.join(here, "..", "admin-web", "dist");
if (fs.existsSync(staticPath)) { app.use(express.static(staticPath)); app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticPath, "index.html"))); }
app.listen(port, "127.0.0.1", () => console.log(`Cave salon sunucusu http://127.0.0.1:${port} adresinde.`));
