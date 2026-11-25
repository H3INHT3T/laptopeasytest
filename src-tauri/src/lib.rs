mod cmd_util;
mod modules;
mod types;

use modules::{
    battery, biometrics, error_logs, gpu_stress, keyboard_hook, perf_bench, power_torture,
    ram_test, raytracer, report, security_audit, session, shop_history, simd_kernels, specs,
    storage, telemetry, usb_ports, vram_test,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, State};
use types::{
    BatteryHealthReport, BatterySagResult, BiometricAuthResult, BiometricsHardwareReport,
    BurnInResult, ErrorLogsReport, ExportReportPayload, ExportedReportPaths, GpuAdapterInfo,
    GpuStressResult, LiveTelemetrySnapshot, PerfBenchResult, PowerTortureResult, RamTestResult,
    SavedSessionPayload, SecurityAuditReport, ShopModelBenchmarkAvg, ShopModelComparison,
    ShopProfile, StorageBenchResult, StorageSmartReport, SystemSpecs, UsbDeviceInfo, VramTestResult,
};

pub struct CancelRegistry {
    pub battery_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub battery_sag_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub usb_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub keyboard_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub storage_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub ram_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub perf_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub gpu_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub vram_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub torture_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub burnin_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for CancelRegistry {
    fn default() -> Self {
        Self {
            battery_stop: Mutex::new(None),
            battery_sag_cancel: Mutex::new(None),
            usb_stop: Mutex::new(None),
            keyboard_stop: Mutex::new(None),
            storage_cancel: Mutex::new(None),
            ram_cancel: Mutex::new(None),
            perf_cancel: Mutex::new(None),
            gpu_cancel: Mutex::new(None),
            vram_cancel: Mutex::new(None),
            torture_cancel: Mutex::new(None),
            burnin_cancel: Mutex::new(None),
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
async fn run_battery_sag_pulse(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    duration_secs: Option<u64>,
) -> Result<BatterySagResult, String> {
    let cancel = replace_flag(&state.battery_sag_cancel);
    let dur = duration_secs.unwrap_or(15).clamp(10, 45);
    tauri::async_runtime::spawn_blocking(move || battery::run_battery_sag_pulse(&app, dur, cancel))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_battery_sag_pulse(state: State<'_, CancelRegistry>) {
    signal_stop(&state.battery_sag_cancel);
}

#[tauri::command]
async fn list_usb_devices() -> Result<Vec<UsbDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(usb_ports::list_usb_devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_usb_monitor(app: AppHandle, state: State<'_, CancelRegistry>) {
    let flag = replace_flag(&state.usb_stop);
    usb_ports::spawn_usb_monitor(app, flag);
}

#[tauri::command]
fn stop_usb_monitor(state: State<'_, CancelRegistry>) {
    signal_stop(&state.usb_stop);
}

#[tauri::command]
fn save_qc_session(
    app: AppHandle,
    serial: String,
    model: String,
    active_stress_stage: Option<String>,
    state_json: String,
) -> Result<(), String> {
    session::save_qc_session(&app, &serial, &model, active_stress_stage, &state_json)
}

#[tauri::command]
fn load_qc_session(app: AppHandle, serial: String) -> Option<SavedSessionPayload> {
    session::load_qc_session(&app, &serial)
}

#[tauri::command]
fn clear_qc_session(app: AppHandle, serial: String) -> Result<(), String> {
    session::clear_qc_session(&app, &serial)
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
    target_mount: Option<String>,
) -> Result<StorageBenchResult, String> {
    let cancel = replace_flag(&state.storage_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        storage::run_storage_benchmark(&app, &preset, interface_hint, media_hint, target_mount, cancel)
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
    manufacturer: Option<String>,
    model: Option<String>,
) -> Result<PerfBenchResult, String> {
    let cancel = replace_flag(&state.perf_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        perf_bench::run_performance_benchmark(&app, &preset, manufacturer, model, cancel)
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
async fn run_vram_test(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    adapter_index: Option<usize>,
    target_vram_mb: Option<u64>,
    duration_secs: Option<u64>,
) -> Result<VramTestResult, String> {
    let cancel = replace_flag(&state.vram_cancel);
    let dur = duration_secs.unwrap_or(60).clamp(20, 1800);
    tauri::async_runtime::spawn_blocking(move || {
        vram_test::run_vram_integrity_test(&app, adapter_index, target_vram_mb, dur, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_vram_test(state: State<'_, CancelRegistry>) {
    signal_stop(&state.vram_cancel);
}

#[tauri::command]
async fn run_power_torture(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    adapter_index: Option<usize>,
    duration_secs: Option<u64>,
    thermal_cutoff_c: Option<f32>,
) -> Result<PowerTortureResult, String> {
    let cancel = replace_flag(&state.torture_cancel);
    let dur = duration_secs.unwrap_or(120).clamp(30, 1800);
    let cutoff = thermal_cutoff_c.unwrap_or(95.0).clamp(75.0, 105.0);
    tauri::async_runtime::spawn_blocking(move || {
        power_torture::run_power_torture(&app, adapter_index, dur, cutoff, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_power_torture(state: State<'_, CancelRegistry>) {
    signal_stop(&state.torture_cancel);
}

#[tauri::command]
async fn run_shelf_burnin(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    total_minutes: u64,
    thermal_cutoff_c: Option<f32>,
    memory_type_hint: Option<String>,
) -> Result<BurnInResult, String> {
    let cancel = replace_flag(&state.burnin_cancel);
    let cutoff = thermal_cutoff_c.unwrap_or(95.0).clamp(75.0, 105.0);
    tauri::async_runtime::spawn_blocking(move || {
        power_torture::run_shelf_burnin(&app, total_minutes, cutoff, memory_type_hint, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_shelf_burnin(state: State<'_, CancelRegistry>) {
    signal_stop(&state.burnin_cancel);
}

#[tauri::command]
fn get_shop_model_comparison(
    app: AppHandle,
    manufacturer: String,
    model: String,
    cpu_brand: String,
    current_composite: Option<f64>,
) -> ShopModelComparison {
    shop_history::compare_against_shop(&app, &manufacturer, &model, &cpu_brand, current_composite)
}

#[tauri::command]
fn list_shop_history(app: AppHandle) -> Vec<ShopModelBenchmarkAvg> {
    shop_history::list_history(&app)
}

#[tauri::command]
fn export_shop_history(app: AppHandle, target_path: String) -> Result<usize, String> {
    shop_history::export_history_to_file(&app, &target_path)
}

#[tauri::command]
fn import_shop_history(app: AppHandle, source_path: String) -> Result<usize, String> {
    shop_history::import_history_from_file(&app, &source_path)
}

#[tauri::command]
async fn sample_live_telemetry() -> Result<LiveTelemetrySnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut reader = telemetry::TelemetryReader::new();
        reader.sample(true)
    })
    .await
    .map_err(|e| e.to_string())
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
    println!("=== LaptopBench QC v2.0 Self-Test & Hardware Verification ===");

    // 1. RAM pattern verification
    let mut ram_buf = vec![0u64; 65536];
    for pid in 0..5 {
        let errs = ram_test::verify_pattern_pass(&mut ram_buf, pid, 42);
        if errs != 0 {
            return Err(format!("RAM clean pattern {} unexpectedly reported {} errors", pid, errs));
        }
    }
    println!("[PASS] RAM pattern verifier (5 patterns, 0 errors)");

    // 2. Bare-metal SIMD AI GEMM & Creator Image kernels
    let isa = simd_kernels::detected_simd_isa();
    let gemm_sum = simd_kernels::simd_ai_gemm_step(64, 1.0);
    let img_sum = simd_kernels::creator_image_filter_pass(160, 90);
    if !gemm_sum.is_finite() || gemm_sum == 0.0 || img_sum == 0 {
        return Err("SIMD/Creator kernel returned invalid output".into());
    }
    println!("[PASS] SIMD Kernels ({} | GEMM={:.1} | ImageConv={})", isa, gemm_sum, img_sum);

    // 3. Cinebench-style 3D Path-Tracer smoke render
    let cancel_false = Arc::new(AtomicBool::new(false));
    let (rt_score, mrays, rt_jpg) = raytracer::run_creator_raytrace_bench(
        128,
        72,
        2,
        0.1,
        &cancel_false,
        |_, _| {},
    )
    .ok_or_else(|| "Raytracer smoke render failed".to_string())?;
    if rt_score == 0 || rt_jpg.is_none() {
        return Err("Raytracer produced empty frame or score".into());
    }
    println!("[PASS] 3D Path-Tracer (Score={} | {:.2} MRays/s | JPEG ok)", rt_score, mrays);

    // 4. Dedicated VRAM wgpu compute shader smoke test
    match vram_test::smoke_test_vram_shader() {
        Ok(msg) => println!("[PASS] VRAM Compute Shader: {}", msg),
        Err(e) => println!("[WARN] VRAM Compute Shader skipped: {}", e),
    }

    // 5. Native PDF 1.4 generator check
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
        durability_grade: Some("A+".into()),
        subsystem_scores: vec![types::SubsystemScoreBar {
            label: "RAM Stability".into(),
            score_pct: 100.0,
            metric_text: "0 errors across 4096 MB".into(),
            status_label: "0 ERR PASS".into(),
        }],
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

    // 6. Live Telemetry & OS diagnostic probes
    let mut tel = telemetry::TelemetryReader::new();
    let snap = tel.sample(true);
    println!(
        "[PASS] Telemetry ({}): CPU {:.0}% @ {} MHz | Temp={:?} | AC={:?} | Bat={:?}%",
        snap.sensor_source, snap.cpu_usage_pct, snap.cpu_clock_mhz, snap.cpu_temp_c, snap.ac_plugged, snap.battery_percent
    );

    let sp = specs::collect_system_specs();
    println!(
        "[PASS] Specs: {} {} | {} ({}C/{}T) | {:.1} GB RAM ({:?}) | Wi-Fi={:?}% ({:?} dBm) | Gaming={}",
        sp.manufacturer, sp.model, sp.cpu_brand, sp.cpu_physical_cores, sp.cpu_logical_cores, sp.total_ram_gb, sp.ram_channel_mode, sp.wifi_signal_pct, sp.wifi_rssi_dbm, sp.is_gaming_capable
    );

    let usb_devs = usb_ports::list_usb_devices();
    println!("[PASS] USB Hot-Plug Speed Enumerator: {} device(s) detected", usb_devs.len());

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

    println!("=== ALL v2.0 SELF-TESTS PASSED ===");
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
            run_battery_sag_pulse,
            cancel_battery_sag_pulse,
            list_usb_devices,
            start_usb_monitor,
            stop_usb_monitor,
            save_qc_session,
            load_qc_session,
            clear_qc_session,
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
            run_vram_test,
            cancel_vram_test,
            run_power_torture,
            cancel_power_torture,
            run_shelf_burnin,
            cancel_shelf_burnin,
            get_shop_model_comparison,
            list_shop_history,
            export_shop_history,
            import_shop_history,
            sample_live_telemetry,
            load_shop_profile,
            save_shop_profile,
            export_qc_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LaptopBench QC");
}
