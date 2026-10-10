use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus { Bos, Mesgul }

impl DeviceStatus {
    fn as_db(&self) -> &'static str { match self { Self::Bos => "bos", Self::Mesgul => "mesgul" } }
    fn from_db(value: String) -> Result<Self, String> { match value.as_str() { "bos" => Ok(Self::Bos), "mesgul" => Ok(Self::Mesgul), _ => Err("Geçersiz cihaz durumu.".into()) } }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session { pub id: i64, pub device_id: i64, pub started_at: String, pub ended_at: Option<String>, pub hourly_rate: f64, pub total_amount: Option<f64> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device { pub id: i64, pub name: String, pub status: DeviceStatus, pub active_session: Option<Session> }

pub struct Database { connection: Connection }

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('bos','mesgul')) DEFAULT 'bos', created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id), started_at TEXT NOT NULL, ended_at TEXT, hourly_rate REAL NOT NULL, total_amount REAL);
             CREATE INDEX IF NOT EXISTS sessions_open_device ON sessions(device_id) WHERE ended_at IS NULL;
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT OR IGNORE INTO settings(key, value) VALUES ('hourly_rate', '100');"
        ).map_err(|e| e.to_string())?;
        Ok(Self { connection })
    }

    pub fn list_devices(&self) -> Result<Vec<Device>, String> {
        let mut statement = self.connection.prepare("SELECT id, name, status FROM devices ORDER BY name COLLATE NOCASE").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
        rows.map(|row| { let (id, name, status) = row.map_err(|e| e.to_string())?; self.device_from_parts(id, name, status) }).collect()
    }

    pub fn add_device(&mut self, name: &str) -> Result<Device, String> {
        let clean_name = name.trim();
        if clean_name.is_empty() || clean_name.chars().count() > 80 { return Err("Cihaz adı 1–80 karakter olmalıdır.".into()); }
        self.connection.execute("INSERT INTO devices(name, status, created_at) VALUES (?1, 'bos', ?2)", params![clean_name, Utc::now().to_rfc3339()]).map_err(|e| if e.to_string().contains("UNIQUE") { "Bu cihaz adı zaten kullanılıyor.".into() } else { e.to_string() })?;
        self.get_device(self.connection.last_insert_rowid())
    }

    pub fn update_device_status(&mut self, device_id: i64, status: DeviceStatus) -> Result<Device, String> {
        if status == DeviceStatus::Bos && self.open_session(device_id)?.is_some() { return Err("Açık oturum kapatılmadan cihaz boş yapılamaz.".into()); }
        let changed = self.connection.execute("UPDATE devices SET status = ?1 WHERE id = ?2", params![status.as_db(), device_id]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err("Cihaz bulunamadı.".into()); }
        self.get_device(device_id)
    }

    pub fn start_session(&mut self, device_id: i64) -> Result<Device, String> {
        let status: String = self.connection.query_row("SELECT status FROM devices WHERE id = ?1", [device_id], |row| row.get(0)).optional().map_err(|e| e.to_string())?.ok_or("Cihaz bulunamadı.")?;
        if status != "bos" { return Err("Yalnızca boş cihazlarda oturum başlatılabilir.".into()); }
        let rate = self.get_hourly_rate()?;
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO sessions(device_id, started_at, hourly_rate) VALUES (?1, ?2, ?3)", params![device_id, Utc::now().to_rfc3339(), rate]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE devices SET status = 'mesgul' WHERE id = ?1", [device_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.get_device(device_id)
    }

    pub fn stop_session(&mut self, device_id: i64) -> Result<Device, String> {
        let session = self.open_session(device_id)?.ok_or("Bu cihazda açık oturum yok.")?;
        let started_at = DateTime::parse_from_rfc3339(&session.started_at).map_err(|_| "Oturum başlangıç zamanı okunamadı.".to_string())?.with_timezone(&Utc);
        let elapsed_ms = (Utc::now() - started_at).num_milliseconds().max(0) as f64;
        let amount = ((elapsed_ms / 3_600_000.0) * session.hourly_rate * 100.0).round() / 100.0;
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE sessions SET ended_at = ?1, total_amount = ?2 WHERE id = ?3", params![Utc::now().to_rfc3339(), amount, session.id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE devices SET status = 'bos' WHERE id = ?1", [device_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.get_device(device_id)
    }

    pub fn get_hourly_rate(&self) -> Result<f64, String> { self.connection.query_row("SELECT value FROM settings WHERE key = 'hourly_rate'", [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.parse().map_err(|_| "Saatlik ücret okunamadı.".into()) }
    pub fn set_hourly_rate(&mut self, rate: f64) -> Result<f64, String> { if !rate.is_finite() || !(0.0..=100_000.0).contains(&rate) { return Err("Saatlik ücret 0 ile 100.000 arasında olmalıdır.".into()); } self.connection.execute("UPDATE settings SET value = ?1 WHERE key = 'hourly_rate'", [rate.to_string()]).map_err(|e| e.to_string())?; Ok(rate) }

    fn get_device(&self, id: i64) -> Result<Device, String> { let (id, name, status) = self.connection.query_row("SELECT id, name, status FROM devices WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|_| "Cihaz bulunamadı.".to_string())?; self.device_from_parts(id, name, status) }
    fn device_from_parts(&self, id: i64, name: String, status: String) -> Result<Device, String> { Ok(Device { id, name, status: DeviceStatus::from_db(status)?, active_session: self.open_session(id)? }) }
    fn open_session(&self, device_id: i64) -> Result<Option<Session>, String> { self.connection.query_row("SELECT id, device_id, started_at, ended_at, hourly_rate, total_amount FROM sessions WHERE device_id = ?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [device_id], |row| Ok(Session { id: row.get(0)?, device_id: row.get(1)?, started_at: row.get(2)?, ended_at: row.get(3)?, hourly_rate: row.get(4)?, total_amount: row.get(5)? })).optional().map_err(|e| e.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_session_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!("cave-salon-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        { let mut first = Database::open(&path).unwrap(); let device = first.add_device("PS5 Test").unwrap(); first.start_session(device.id).unwrap(); }
        { let reopened = Database::open(&path).unwrap(); let device = reopened.list_devices().unwrap().pop().unwrap(); assert_eq!(device.status, DeviceStatus::Mesgul); assert!(device.active_session.is_some()); }
        let _ = std::fs::remove_file(path);
    }
}
