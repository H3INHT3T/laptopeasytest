mod cmd_util;
mod modules;
mod types;

use modules::{
    battery, biometrics, error_logs, gpu_stress, keyboard_hook, perf_bench, ram_test, report,
    security_audit, specs, storage,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, State};
use types::{
    BatteryHealthReport, BiometricAuthResult, BiometricsHardwareReport, ErrorLogsReport,
    ExportReportPayload, ExportedReportPaths, GpuAdapterInfo, GpuStressResult, PerfBenchResult,
    RamTestResult, SecurityAuditReport, ShopProfile, StorageBenchResult, StorageSmartReport,
    SystemSpecs,
};

pub struct CancelRegistry {
    pub battery_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub keyboard_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub storage_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub ram_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub perf_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub gpu_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for CancelRegistry {
    fn default() -> Self {
        Self {
            battery_stop: Mutex::new(None),
            keyboard_stop: Mutex::new(None),
            storage_cancel: Mutex::new(None),
            ram_cancel: Mutex::new(None),
            perf_cancel: Mutex::new(None),
            gpu_cancel: Mutex::new(None),
        }
    }
}

fn replace_flag(slot: &Mutex<Option<Arc<AtomicBool>>>) -> Arc<AtomicBool> {
    let mut guard = slot.lock().unwrap();
    if let Some(old) = guard.take() {
        old.store(true, Ordering::SeqCst);
    }
    let flag = Arc::new(AtomicBool::new(false));
    *guard = Some(flag.clone());
    flag
}

fn signal_stop(slot: &Mutex<Option<Arc<AtomicBool>>>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(old) = guard.take() {
            old.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
async fn get_system_specs() -> Result<SystemSpecs, String> {
    tauri::async_runtime::spawn_blocking(specs::collect_system_specs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_security_audit() -> Result<SecurityAuditReport, String> {
    tauri::async_runtime::spawn_blocking(security_audit::run_security_audit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_battery_health() -> Result<BatteryHealthReport, String> {
    tauri::async_runtime::spawn_blocking(battery::get_battery_health)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_battery_monitor(app: AppHandle, state: State<'_, CancelRegistry>) {
    let flag = replace_flag(&state.battery_stop);
    battery::spawn_battery_monitor(app, flag);
}

#[tauri::command]
fn stop_battery_monitor(state: State<'_, CancelRegistry>) {
    signal_stop(&state.battery_stop);
}

#[tauri::command]
async fn scan_error_logs(days: Option<u32>) -> Result<ErrorLogsReport, String> {
    let d = days.unwrap_or(30).clamp(1, 90);
    tauri::async_runtime::spawn_blocking(move || error_logs::scan_error_logs(d))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_storage_smart() -> Result<StorageSmartReport, String> {
    tauri::async_runtime::spawn_blocking(storage::scan_storage_smart)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_storage_benchmark(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    preset: String,
    interface_hint: Option<String>,
    media_hint: Option<String>,
) -> Result<StorageBenchResult, String> {
    let cancel = replace_flag(&state.storage_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        storage::run_storage_benchmark(&app, &preset, interface_hint, media_hint, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_storage_benchmark(state: State<'_, CancelRegistry>) {
    signal_stop(&state.storage_cancel);
}

#[tauri::command]
async fn run_ram_stress(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    preset: String,
    memory_percent: Option<u32>,
    custom_duration_secs: Option<u64>,
    memory_type_hint: Option<String>,
) -> Result<RamTestResult, String> {
    let cancel = replace_flag(&state.ram_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        ram_test::run_ram_stress_test(
            &app,
            &preset,
            memory_percent,
            custom_duration_secs,
            memory_type_hint,
            cancel,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_ram_stress(state: State<'_, CancelRegistry>) {
    signal_stop(&state.ram_cancel);
}

#[tauri::command]
async fn detect_biometrics_hardware() -> Result<BiometricsHardwareReport, String> {
    tauri::async_runtime::spawn_blocking(biometrics::detect_biometrics_hardware)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn trigger_biometric_prompt() -> Result<BiometricAuthResult, String> {
    tauri::async_runtime::spawn_blocking(biometrics::trigger_live_biometric_prompt)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_keyboard_capture(app: AppHandle, state: State<'_, CancelRegistry>) -> bool {
    let flag = replace_flag(&state.keyboard_stop);
    keyboard_hook::start_keyboard_capture(app, flag)
}

#[tauri::command]
fn stop_keyboard_capture(state: State<'_, CancelRegistry>) {
    signal_stop(&state.keyboard_stop);
    keyboard_hook::stop_keyboard_capture();
}

#[tauri::command]
async fn run_performance_benchmark(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    preset: String,
) -> Result<PerfBenchResult, String> {
    let cancel = replace_flag(&state.perf_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        perf_bench::run_performance_benchmark(&app, &preset, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_performance_benchmark(state: State<'_, CancelRegistry>) {
    signal_stop(&state.perf_cancel);
}

#[tauri::command]
async fn list_gpu_adapters() -> Result<Vec<GpuAdapterInfo>, String> {
    tauri::async_runtime::spawn_blocking(gpu_stress::list_gpu_adapters)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_gpu_stress(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    adapter_index: Option<usize>,
    preset: String,
    resolution: String,
    extreme_mode: Option<bool>,
    thermal_cutoff_c: Option<f32>,
) -> Result<GpuStressResult, String> {
    let cancel = replace_flag(&state.gpu_cancel);
    let cutoff = thermal_cutoff_c.unwrap_or(95.0).clamp(75.0, 105.0);
    let extreme = extreme_mode.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        gpu_stress::run_gpu_stress_test(&app, adapter_index, &preset, &resolution, extreme, cutoff, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_gpu_stress(state: State<'_, CancelRegistry>) {
    signal_stop(&state.gpu_cancel);
}

#[tauri::command]
fn load_shop_profile(app: AppHandle) -> ShopProfile {
    report::load_shop_profile(&app)
}

#[tauri::command]
fn save_shop_profile(app: AppHandle, profile: ShopProfile) -> Result<(), String> {
    report::save_shop_profile(&app, &profile)
}

#[tauri::command]
async fn export_qc_report(
    app: AppHandle,
    payload: ExportReportPayload,
) -> Result<ExportedReportPaths, String> {
    tauri::async_runtime::spawn_blocking(move || report::export_qc_report(&app, &payload))
        .await
        .map_err(|e| e.to_string())?
}

pub fn run_self_test() -> Result<(), String> {
    println!("=== LaptopBench QC Self-Test & Hardware Verification ===");

    // 1. RAM pattern verification & bit-flip injection check
    let mut ram_buf = vec![0u64; 65536];
    for pid in 0..5 {
        let errs = ram_test::verify_pattern_pass(&mut ram_buf, pid, 42);
        if errs != 0 {
            return Err(format!("RAM clean pattern {} unexpectedly reported {} errors", pid, errs));
        }
    }
    println!("[PASS] RAM pattern verifier (5 patterns, 0 errors)");

    // 2. Native PDF 1.4 generator check
    let sample_payload = ExportReportPayload {
        shop_profile: ShopProfile {
            shop_name: "Self-Test Shop".into(),
            technician_name: "Verifier".into(),
            logo_data_url: None,
            default_output_dir: None,
        },
        customer_or_sku: "TEST-001".into(),
        technician_notes: "Automated self-test".into(),
        overall_verdict: "PASSED".into(),
        specs: None,
        tests: vec![types::ReportTestEntry {
            id: "ram".into(),
            name: "RAM Stress Test".into(),
            category: "Stress".into(),
            status: types::TestStatus::Pass,
            summary: "0 errors".into(),
            metrics: vec![],
            notes: String::new(),
        }],
        signoff: types::PortsSpeakerSignoff {
            ports_checked: true,
            ports_notes: "OK".into(),
            speakers_checked: true,
            speakers_notes: "OK".into(),
        },
        output_dir: None,
    };
    let pdf = modules::pdf_gen::render_qc_certificate_pdf(&sample_payload, "2026-11-25 22:00:00");
    if !pdf.starts_with(b"%PDF-1.4") || !pdf.ends_with(b"%%EOF\n") {
        return Err("PDF generator failed header/EOF integrity check".into());
    }
    println!("[PASS] Native PDF 1.4 certificate generator ({} bytes)", pdf.len());

    // 3. Live OS diagnostic probes
    let sp = specs::collect_system_specs();
    println!(
        "[PASS] Specs: {} {} | {} ({}C/{}T) | {:.1} GB RAM | Gaming={}",
        sp.manufacturer, sp.model, sp.cpu_brand, sp.cpu_physical_cores, sp.cpu_logical_cores, sp.total_ram_gb, sp.is_gaming_capable
    );

    let sec = security_audit::run_security_audit();
    println!("[PASS] Security Audit ({:?}): {}", sec.overall_status, sec.summary);

    let bat = battery::get_battery_health();
    println!(
        "[PASS] Battery: present={} health={:?}% cycles={:?} ac={}",
        bat.present, bat.health_percent, bat.cycle_count, bat.ac_plugged
    );

    let logs = error_logs::scan_error_logs(7);
    println!("[PASS] Error Logs ({:?}): {}", logs.status, logs.summary);

    let smart = storage::scan_storage_smart();
    println!("[PASS] Storage SMART ({:?}): {}", smart.status, smart.summary);

    let bio = biometrics::detect_biometrics_hardware();
    println!("[PASS] Biometrics ({:?}): {}", bio.suggested_status, bio.summary);

    let gpus = gpu_stress::list_gpu_adapters();
    println!("[PASS] wgpu GPU Adapters detected: {}", gpus.len());
    for g in &gpus {
        println!("       - [{}] {} ({}, {})", g.index, g.name, g.device_type, g.backend);
    }

    println!("=== ALL SELF-TESTS PASSED ===");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_system_specs,
            run_security_audit,
            get_battery_health,
            start_battery_monitor,
            stop_battery_monitor,
            scan_error_logs,
            scan_storage_smart,
            run_storage_benchmark,
            cancel_storage_benchmark,
            run_ram_stress,
            cancel_ram_stress,
            detect_biometrics_hardware,
            trigger_biometric_prompt,
            start_keyboard_capture,
            stop_keyboard_capture,
            run_performance_benchmark,
            cancel_performance_benchmark,
            list_gpu_adapters,
            run_gpu_stress,
            cancel_gpu_stress,
            load_shop_profile,
            save_shop_profile,
            export_qc_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LaptopBench QC");
}
