import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { createDatabaseStorage } from './database-storage.mjs';

test('database writes preserve the old file on validation failure and backups can be restored', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'salon.sqlite');
  const backupDirectory = path.join(directory, 'backups');
  const SQL = await initSqlJs();
  let time = Date.now();
  const storage = createDatabaseStorage(SQL, databasePath, { backupDirectory, backupCount: 2, now: () => time });
  const db = new SQL.Database();
  db.run('CREATE TABLE receipts(amount INTEGER); INSERT INTO receipts(amount) VALUES (100)');
  storage.writeVerified(databasePath, Buffer.from(db.export()));
  const firstSaved = fs.readFileSync(databasePath);

  assert.throws(() => storage.writeVerified(databasePath, Buffer.from('invalid sqlite')), /SQLite|database|file|malformed|format/i);
  assert.deepEqual(fs.readFileSync(databasePath), firstSaved);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);

  const firstBackup = storage.backupIfDue();
  assert.ok(firstBackup);
  assert.equal(storage.backupIfDue(), null);
  db.run('INSERT INTO receipts(amount) VALUES (200)');
  storage.writeVerified(databasePath, Buffer.from(db.export()));
  time += 25 * 60 * 60 * 1000;
  const secondBackup = storage.backupIfDue();
  assert.ok(secondBackup);
  db.run('INSERT INTO receipts(amount) VALUES (300)');
  storage.writeVerified(databasePath, Buffer.from(db.export()));
  time += 25 * 60 * 60 * 1000;
  const thirdBackup = storage.backupIfDue();
  assert.ok(thirdBackup);
  assert.equal(fs.readdirSync(backupDirectory).length, 2);
  assert.ok(!fs.existsSync(firstBackup));

  const restored = new SQL.Database(fs.readFileSync(secondBackup));
  assert.deepEqual(restored.exec('SELECT amount FROM receipts ORDER BY amount')[0].values, [[100], [200]]);
  restored.close();
  db.close();
});
