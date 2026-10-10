mod storage;

use std::sync::Mutex;
use tauri::{Manager, State};
use storage::{Database, Device, DeviceStatus};

struct AppState(Mutex<Database>);

fn with_db<T>(state: State<'_, AppState>, operation: impl FnOnce(&mut Database) -> Result<T, String>) -> Result<T, String> {
    let mut database = state.0.lock().map_err(|_| "Veritabanı kilidine erişilemedi.".to_string())?;
    operation(&mut database)
}

#[tauri::command]
fn list_devices(state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    with_db(state, |db| db.list_devices())
}

#[tauri::command]
fn add_device(name: String, state: State<'_, AppState>) -> Result<Device, String> {
    with_db(state, |db| db.add_device(&name))
}

#[tauri::command]
fn update_device_status(device_id: i64, status: DeviceStatus, state: State<'_, AppState>) -> Result<Device, String> {
    with_db(state, |db| db.update_device_status(device_id, status))
}

#[tauri::command]
fn start_session(device_id: i64, state: State<'_, AppState>) -> Result<Device, String> {
    with_db(state, |db| db.start_session(device_id))
}

#[tauri::command]
fn stop_session(device_id: i64, state: State<'_, AppState>) -> Result<Device, String> {
    with_db(state, |db| db.stop_session(device_id))
}

#[tauri::command]
fn get_hourly_rate(state: State<'_, AppState>) -> Result<f64, String> {
    with_db(state, |db| db.get_hourly_rate())
}

#[tauri::command]
fn set_hourly_rate(hourly_rate: f64, state: State<'_, AppState>) -> Result<f64, String> {
    with_db(state, |db| db.set_hourly_rate(hourly_rate))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database = Database::open(data_dir.join("cave-salon.sqlite"))
                .map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(database)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices, add_device, update_device_status, start_session, stop_session, get_hourly_rate, set_hourly_rate
        ])
        .run(tauri::generate_context!())
        .expect("Tauri uygulaması başlatılamadı");
}
