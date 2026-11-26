use crate::modules::portable;
use crate::types::SavedSessionPayload;
use chrono::Local;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

fn sanitize_serial(serial: &str) -> String {
    let s: String = serial
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = s.trim_matches('_');
    if trimmed.is_empty() {
        "DEFAULT_UNIT".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn session_file_path(app: &AppHandle, serial: &str) -> Result<PathBuf, String> {
    let dir = portable::resolve_config_dir(app)?.join("sessions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("session_{}.json", sanitize_serial(serial))))
}

pub fn save_qc_session(
    app: &AppHandle,
    serial: &str,
    model: &str,
    active_stress_stage: Option<String>,
    state_json: &str,
) -> Result<(), String> {
    let path = session_file_path(app, serial)?;
    let payload = SavedSessionPayload {
        serial_number: serial.to_string(),
        model: model.to_string(),
        saved_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        active_stress_stage,
        state_json: state_json.to_string(),
    };
    let raw = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn load_qc_session(app: &AppHandle, serial: &str) -> Option<SavedSessionPayload> {
    let path = session_file_path(app, serial).ok()?;
    let txt = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SavedSessionPayload>(&txt).ok()
}

pub fn clear_qc_session(app: &AppHandle, serial: &str) -> Result<(), String> {
    let path = session_file_path(app, serial)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
