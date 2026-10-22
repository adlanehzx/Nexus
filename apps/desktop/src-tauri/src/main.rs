// NEXUS native desktop shell for Windows.
//
// This file constitutes the entire boundary running outside the renderer
// sandbox. The exposed commands below form the strict native surface area.
// It exposes no process execution or arbitrary filesystem operations.

use std::fs;
use std::path::PathBuf;

use keyring::Entry;
use serde::Deserialize;
use tauri_plugin_notification::NotificationExt;

/// Keyring service name under which desktop secrets are stored.
const KEYRING_SERVICE: &str = "fr.nexus.desktop";

/// Allowed keyring keys.
const ALLOWED_KEYS: [&str; 3] = ["nexus.access", "nexus.refresh", "nexus.device"];

fn check_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("unauthorized key: {key}"))
    }
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    check_key(&key)?;

    match Entry::new(KEYRING_SERVICE, &key).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(cause) => Err(cause.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;

    Entry::new(KEYRING_SERVICE, &key)
        .and_then(|entry| entry.set_password(&value))
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
fn secret_remove(key: String) -> Result<(), String> {
    check_key(&key)?;

    match Entry::new(KEYRING_SERVICE, &key).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(cause) => Err(cause.to_string()),
    }
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|cause| cause.to_string())
}

/// Public state of local worker daemon.
#[derive(Deserialize)]
struct WorkerState {
    #[serde(rename = "deviceId")]
    device_id: String,
}

fn worker_state_path() -> Option<PathBuf> {
    std::env::var_os("ProgramData")
        .map(|root| PathBuf::from(root).join("NEXUS").join("worker").join("device.json"))
}

/// Identifier of worker installed on this machine.
#[tauri::command]
fn local_worker_device_id() -> Option<String> {
    let path = worker_state_path()?;
    let contents = fs::read_to_string(path).ok()?;
    let state: WorkerState = serde_json::from_str(&contents).ok()?;

    if state.device_id.is_empty() {
        None
    } else {
        Some(state.device_id)
    }
}

#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".to_string())
}

/// Opens a URL in the system default browser.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http and https are allowed".to_string());
    }

    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<String>)
        .map_err(|cause| cause.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_remove,
            notify,
            local_worker_device_id,
            machine_name,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("failed to start NEXUS window");
}
