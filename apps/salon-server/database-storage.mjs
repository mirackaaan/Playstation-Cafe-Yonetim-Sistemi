import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dayMs = 24 * 60 * 60 * 1000;

export function createDatabaseStorage(SQL, databasePath, {
  backupDirectory = path.join(path.dirname(databasePath), 'backups'),
  backupIntervalMs = dayMs,
  backupCount = 14,
  now = () => Date.now(),
} = {}) {
  const backupPrefix = `${path.basename(databasePath, path.extname(databasePath))}.auto-`;

  function verifyDatabase(data) {
    const check = new SQL.Database(data);
    try {
      const result = check.exec('PRAGMA integrity_check');
      if (result[0]?.values?.[0]?.[0] !== 'ok') throw new Error('Veritabanı bütünlük kontrolü başarısız.');
    } finally {
      check.close();
    }
  }

  function writeVerified(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      const written = fs.readFileSync(temporaryPath);
      if (!written.equals(data)) throw new Error('Veritabanı dosyası eksik veya farklı yazıldı.');
      verifyDatabase(written);
      fs.renameSync(temporaryPath, filePath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  function automaticBackups() {
    if (!fs.existsSync(backupDirectory)) return [];
    return fs.readdirSync(backupDirectory)
      .filter(name => name.startsWith(backupPrefix) && name.endsWith('.sqlite'))
      .map(name => ({ name, filePath: path.join(backupDirectory, name) }))
      .filter(item => fs.statSync(item.filePath).isFile())
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  function backupIfDue() {
    if (!fs.existsSync(databasePath)) return null;
    const previous = automaticBackups()[0];
    if (previous && now() - fs.statSync(previous.filePath).mtimeMs < backupIntervalMs) return null;
    const source = fs.readFileSync(databasePath);
    verifyDatabase(source);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDirectory, `${backupPrefix}${stamp}-${crypto.randomUUID()}.sqlite`);
    writeVerified(backupPath, source);
    if (!fs.readFileSync(backupPath).equals(source)) {
      fs.unlinkSync(backupPath);
      throw new Error('Otomatik yedek doğrulanamadı.');
    }
    for (const old of automaticBackups().slice(backupCount)) fs.unlinkSync(old.filePath);
    return backupPath;
  }

  return { writeVerified, backupIfDue };
}
