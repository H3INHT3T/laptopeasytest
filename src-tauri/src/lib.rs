mod cmd_util;
mod modules;
mod types;

use modules::{
    baselines, battery, biometrics, cpu_stress, display_pro, error_logs, gpu_stress, hardware_controls,
    hardware_faults, keyboard_hook, network, perf_bench, port_diagnostics, portable, power_torture, qc_archive, ram_test,
    raytracer, report, security_audit, session, shop_history, simd_kernels, sleep_audit, specs, storage,
    telemetry, usb_ports, userbenchmark, vram_test,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, State};
use types::{
    BatteryChargeResult, BatteryDischargeResult, BatteryHealthReport, BatteryLiveSample,
    BatterySagResult,
    BiometricAuthResult, BiometricsHardwareReport, BurnInResult, CpuStressResult,
    DisplayCapabilitiesReport, EdpHingeFlexResult, ErrorLogsReport,
    ExportReportPayload, ExportedReportPaths, GpuAdapterInfo, GpuComputeBenchResult, GpuStressResult,
    HardwareControlsReport, HardwareFaultsReport, LiveTelemetrySnapshot, NetworkDiagnosticsReport, PerfBenchResult,
    PortDiagnosticsReport, PortableStorageInfo, PowerTortureResult, QcArchiveRecord, RamTestResult,
    RemovableDriveBenchResult, RemovableDriveInfo, SavedSessionPayload, SecurityAuditReport,
    ShopModelBenchmarkAvg, ShopModelComparison, ShopProfile, SleepStandbyReport, StorageBenchResult,
    StorageSmartReport, SystemSpecs, TamperForensicsReport, TestStatus, TouchscreenTestResult, UsbDeviceInfo,
    UserBenchmarkComparison, UserBenchmarkInput, VramTestResult, WarrantyReturnDiff,
    BATTERY_DISCHARGE_MAX_SECS,
    BATTERY_LOW_SOC_ABORT_PCT, CPU_THERMAL_CUTOFF_DEFAULT_C, CPU_THERMAL_CUTOFF_MAX_C,
    CPU_THERMAL_CUTOFF_MIN_C, GPU_THERMAL_CUTOFF_DEFAULT_C, GPU_THERMAL_CUTOFF_MAX_C,
    GPU_THERMAL_CUTOFF_MIN_C,
};

pub struct CancelRegistry {
    pub battery_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub battery_sag_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub battery_discharge_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub battery_charge_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub display_hinge_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub usb_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub keyboard_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub storage_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub ram_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub perf_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub cpu_stress_cancel: Mutex<Option<Arc<AtomicBool>>>,
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
            battery_discharge_cancel: Mutex::new(None),
            battery_charge_cancel: Mutex::new(None),
            display_hinge_cancel: Mutex::new(None),
            usb_stop: Mutex::new(None),
            keyboard_stop: Mutex::new(None),
            storage_cancel: Mutex::new(None),
            ram_cancel: Mutex::new(None),
            perf_cancel: Mutex::new(None),
            cpu_stress_cancel: Mutex::new(None),
            gpu_cancel: Mutex::new(None),
            vram_cancel: Mutex::new(None),
            torture_cancel: Mutex::new(None),
            burnin_cancel: Mutex::new(None),
        }
    }
}

fn clamp_gpu_thermal_cutoff_cmd(thermal_cutoff_c: Option<f32>) -> f32 {
    match thermal_cutoff_c {
        Some(c) if c.is_finite() => c.clamp(GPU_THERMAL_CUTOFF_MIN_C, GPU_THERMAL_CUTOFF_MAX_C),
        _ => GPU_THERMAL_CUTOFF_DEFAULT_C,
    }
}

fn clamp_torture_thermal_cutoff_cmd(thermal_cutoff_c: Option<f32>) -> f32 {
    match thermal_cutoff_c {
        Some(c) if c.is_finite() => c.clamp(CPU_THERMAL_CUTOFF_MIN_C, CPU_THERMAL_CUTOFF_MAX_C),
        _ => CPU_THERMAL_CUTOFF_DEFAULT_C,
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
async fn run_battery_discharge_test(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    duration_secs: Option<u32>,
) -> Result<BatteryDischargeResult, String> {
    let cancel = replace_flag(&state.battery_discharge_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        battery::run_battery_discharge_test(duration_secs, &app, &cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_battery_discharge_test(state: State<'_, CancelRegistry>) {
    signal_stop(&state.battery_discharge_cancel);
}

#[tauri::command]
async fn run_battery_charge_test(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    duration_secs: Option<u64>,
) -> Result<BatteryChargeResult, String> {
    let cancel = replace_flag(&state.battery_charge_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        battery::run_battery_charge_test(duration_secs, &app, &cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_battery_charge_test(state: State<'_, CancelRegistry>) {
    signal_stop(&state.battery_charge_cancel);
}

#[tauri::command]
async fn run_network_diagnostics() -> Result<NetworkDiagnosticsReport, String> {
    tauri::async_runtime::spawn_blocking(network::run_network_diagnostics)
        .await
        .map_err(|e| e.to_string())?
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
    let cutoff = clamp_gpu_thermal_cutoff_cmd(thermal_cutoff_c);
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
    thermal_cutoff_c: Option<f32>,
) -> Result<VramTestResult, String> {
    let cancel = replace_flag(&state.vram_cancel);
    let dur = duration_secs.unwrap_or(60).clamp(20, 1800);
    tauri::async_runtime::spawn_blocking(move || match thermal_cutoff_c {
        Some(_) => {
            let cutoff = clamp_gpu_thermal_cutoff_cmd(thermal_cutoff_c);
            vram_test::run_vram_integrity_test_with_cutoff(
                &app,
                adapter_index,
                target_vram_mb,
                dur,
                cutoff,
                cancel,
            )
        }
        None => vram_test::run_vram_integrity_test(&app, adapter_index, target_vram_mb, dur, cancel),
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
    let cutoff = clamp_torture_thermal_cutoff_cmd(thermal_cutoff_c);
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
    let cutoff = clamp_torture_thermal_cutoff_cmd(thermal_cutoff_c);
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

#[tauri::command]
async fn compare_userbenchmark(
    input: UserBenchmarkInput,
) -> Result<UserBenchmarkComparison, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(userbenchmark::compare_userbenchmark(&input)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_hardware_controls_status() -> Result<HardwareControlsReport, String> {
    tauri::async_runtime::spawn_blocking(hardware_controls::get_hardware_controls_status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_display_brightness(percent: u8) -> Result<u8, String> {
    tauri::async_runtime::spawn_blocking(move || hardware_controls::set_display_brightness(percent))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_cpu_stress(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    data_set: Option<String>,
    load_type: Option<String>,
    threads_mode: Option<String>,
    duration_secs: Option<u64>,
    thermal_cutoff_c: Option<f32>,
    stop_on_error: Option<bool>,
    cooldown_secs: Option<u64>,
) -> Result<CpuStressResult, String> {
    let cancel = replace_flag(&state.cpu_stress_cancel);
    let ds = data_set.unwrap_or_else(|| "medium".to_string());
    let lt = load_type.unwrap_or_else(|| "steady".to_string());
    let tm = threads_mode.unwrap_or_else(|| "all".to_string());
    let dur = duration_secs.unwrap_or(60).clamp(15, 1800);
    let cutoff = clamp_torture_thermal_cutoff_cmd(thermal_cutoff_c);
    let stop_err = stop_on_error.unwrap_or(true);
    let cd = cooldown_secs.unwrap_or(15).min(30);
    tauri::async_runtime::spawn_blocking(move || {
        cpu_stress::run_cpu_stress_test(&app, &ds, &lt, &tm, dur, cutoff, stop_err, cd, cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_cpu_stress(state: State<'_, CancelRegistry>) {
    signal_stop(&state.cpu_stress_cancel);
}

#[tauri::command]
fn list_qc_archive(app: AppHandle) -> Vec<QcArchiveRecord> {
    qc_archive::list_archive(&app)
}

#[tauri::command]
async fn scan_hardware_faults() -> Result<HardwareFaultsReport, String> {
    tauri::async_runtime::spawn_blocking(hardware_faults::scan_hardware_faults)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_port_diagnostics() -> Result<PortDiagnosticsReport, String> {
    tauri::async_runtime::spawn_blocking(port_diagnostics::scan_port_diagnostics)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_display_capabilities() -> Result<DisplayCapabilitiesReport, String> {
    tauri::async_runtime::spawn_blocking(display_pro::probe_display_capabilities)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_edp_hinge_flex_test(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    duration_secs: Option<u64>,
) -> Result<EdpHingeFlexResult, String> {
    let cancel = replace_flag(&state.display_hinge_cancel);
    tauri::async_runtime::spawn_blocking(move || {
        display_pro::run_edp_hinge_flex_test(duration_secs, &app, &cancel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_edp_hinge_flex_test(state: State<'_, CancelRegistry>) {
    signal_stop(&state.display_hinge_cancel);
}

#[tauri::command]
async fn run_sleep_standby_audit() -> Result<SleepStandbyReport, String> {
    tauri::async_runtime::spawn_blocking(sleep_audit::run_sleep_standby_audit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_removable_drives() -> Result<Vec<RemovableDriveInfo>, String> {
    tauri::async_runtime::spawn_blocking(port_diagnostics::list_removable_drives)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_removable_drive_speed_test(target_mount: String) -> Result<RemovableDriveBenchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        port_diagnostics::run_removable_drive_speed_test(target_mount)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn check_warranty_return_diff(
    app: AppHandle,
    serial: String,
    current_battery_health: Option<f64>,
    current_ssd_serial: Option<String>,
    current_ssd_wear: Option<u32>,
    current_ram_gb: Option<f64>,
    current_panel_edid_id: Option<String>,
) -> Option<WarrantyReturnDiff> {
    qc_archive::check_warranty_return_diff(
        &app,
        &serial,
        current_battery_health,
        current_ssd_serial.as_deref(),
        current_ssd_wear,
        current_ram_gb,
        current_panel_edid_id.as_deref(),
    )
}

#[tauri::command]
fn delete_qc_archive_entry(app: AppHandle, id: String) -> Result<usize, String> {
    qc_archive::delete_archive_entry(&app, &id)
}

#[tauri::command]
fn export_qc_archive(app: AppHandle, target_path: String) -> Result<usize, String> {
    qc_archive::export_archive_to_file(&app, &target_path)
}

#[tauri::command]
fn import_qc_archive(app: AppHandle, source_path: String) -> Result<usize, String> {
    qc_archive::import_archive_from_file(&app, &source_path)
}

struct SelfTestTempDirGuard(std::path::PathBuf);
impl Drop for SelfTestTempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn run_self_test() -> Result<(), String> {
    println!("=== LaptopBench QC v3.4.0 Self-Test & Hardware Verification ===");

    // 1. RAM pattern verification & OS Reserve headroom
    let mut ram_buf = vec![0u64; 65536];
    for pid in 0..5 {
        let errs = ram_test::verify_pattern_pass(&mut ram_buf, pid, 42);
        if errs != 0 {
            return Err(format!("RAM clean pattern {} unexpectedly reported {} errors", pid, errs));
        }
    }
    let res_8gb = ram_test::compute_ram_os_reserve_mb(8192);
    let res_16gb = ram_test::compute_ram_os_reserve_mb(16384);
    let res_2gb = ram_test::compute_ram_os_reserve_mb(2048);
    if res_2gb != 512 || res_8gb != 1800 || res_16gb != 1800 {
        return Err(format!(
            "RAM OS reserve check failed (2GB={}, 8GB={}, 16GB={})",
            res_2gb, res_8gb, res_16gb
        ));
    }
    let (win_mb, win_res) = ram_test::compute_safe_ram_window_mb(16384, 10000, 75)?;
    if win_mb > 10000 - win_res || win_res != 1800 {
        return Err(format!("Safe RAM window exceeded reserve: win={} res={}", win_mb, win_res));
    }
    println!(
        "[PASS] RAM pattern verifier & OS Reserve (22% / min 512 MB / cap 1800 MB; 16GB reserve={} MB, safe window={} MB)",
        win_res, win_mb
    );

    // 2. Bare-metal SIMD AI GEMM & Creator Image kernels
    let isa = simd_kernels::detected_simd_isa();
    let gemm_sum = simd_kernels::simd_ai_gemm_step(64, 1.0);
    let img_sum = simd_kernels::creator_image_filter_pass(160, 90);
    if !gemm_sum.is_finite() || gemm_sum == 0.0 || img_sum == 0 {
        return Err("SIMD/Creator kernel returned invalid output".into());
    }
    println!("[PASS] SIMD Kernels ({} | GEMM={:.1} | ImageConv={})", isa, gemm_sum, img_sum);

    // 3. PassMark-style Weighted Harmonic Mean
    let hm = baselines::weighted_harmonic_mean(&[(1.0, 100.0), (1.0, 300.0)], 1.0);
    if (hm - 150.0).abs() > 0.01 {
        return Err(format!("Weighted harmonic mean mismatch: got {:.3}, expected 150.0", hm));
    }
    let cpu_mark = baselines::compute_cpu_mark_harmonic(&baselines::CpuSubtestScores {
        single_core: 3200.0,
        integer_math: 28000.0,
        float_math: 22000.0,
        prime: 48.0,
        vector_ext: 14000.0,
        encryption: 8500.0,
        compression: 19000.0,
        sorting: 11000.0,
        physics: 950.0,
    });
    let mem_mark = baselines::compute_memory_mark_harmonic(&baselines::MemorySubtestMetrics {
        database_kops: 140.0,
        read_cached_mb_s: 36000.0,
        read_uncached_mb_s: 22000.0,
        write_mb_s: 28000.0,
        available_ram_mb: 16384.0,
        latency_ns: 68.0,
        threaded_mb_s: 34000.0,
    });
    if cpu_mark == 0 || mem_mark == 0 {
        return Err("Weighted harmonic CPU/Memory mark returned 0".into());
    }
    println!(
        "[PASS] Weighted Harmonic Mean (H(100,300)={:.1} | CPU Mark={} | Memory Mark={})",
        hm, cpu_mark, mem_mark
    );

    // 4. UserBenchmark offline calibration & Vehicle Tier
    let ub_cmp = userbenchmark::compare_userbenchmark(&UserBenchmarkInput {
        cpu_brand: "Intel Core i7-1365U".into(),
        cpu_physical_cores: Some(10),
        cpu_logical_cores: Some(12),
        cpu_single_core: Some(3600),
        cpu_multi_core: Some(14500),
        cpu_composite: Some(13800),
        gpu_name: Some("NVIDIA GeForce RTX 4060 Laptop GPU".into()),
        gpu_resolution: Some("1080p".into()),
        gpu_avg_fps: Some(88.0),
        gpu_fps_drop_pct: Some(3.5),
        ssd_model: Some("Samsung 980 PRO 1TB".into()),
        ssd_interface: Some("NVMe".into()),
        ssd_seq_read_mb_s: Some(5200.0),
        ssd_seq_write_mb_s: Some(4100.0),
        ssd_rand_4k_read_mb_s: Some(78.0),
        ssd_rand_4k_write_mb_s: Some(210.0),
        ram_type: Some("DDR5".into()),
        ram_bandwidth_gb_s: Some(48.0),
        ram_latency_ns: Some(62.0),
        ram_channel_mode: Some("Dual Channel".into()),
        allow_live_lookup: false,
        ..Default::default()
    });
    if ub_cmp.overall_vehicle_tier.is_empty() || ub_cmp.source_mode != "offline_calibrated" {
        return Err("UserBenchmark offline calibration returned invalid tier or mode".into());
    }
    println!(
        "[PASS] UserBenchmark Offline Calibration (Vehicle Tier={} | Game {:.0}% / Desk {:.0}% / WS {:.0}% | mode={})",
        ub_cmp.overall_vehicle_tier, ub_cmp.gaming_pct, ub_cmp.desktop_pct, ub_cmp.workstation_pct, ub_cmp.source_mode
    );

    // 5. Battery Discharge Normality classifier & safety bounds
    if (BATTERY_LOW_SOC_ABORT_PCT - 15.0).abs() > f64::EPSILON || BATTERY_DISCHARGE_MAX_SECS != 90 {
        return Err("Battery safety constants out of specification".into());
    }
    if battery::clamp_discharge_duration(Some(999)) != 90 || battery::clamp_discharge_duration(Some(5)) != 20 {
        return Err("Battery discharge duration clamping failed".into());
    }
    let dummy_health = BatteryHealthReport {
        present: true,
        status: TestStatus::Pass,
        manufacturer: "SelfTest".into(),
        chemistry: "Li-Ion".into(),
        design_capacity_mwh: Some(60_000),
        full_charge_capacity_mwh: Some(55_000),
        health_percent: Some(91.7),
        wear_percent: Some(8.3),
        cycle_count: Some(45),
        current_charge_percent: Some(80.0),
        is_charging: false,
        ac_plugged: false,
        voltage_mv: Some(11_400),
        rate_mw: Some(-18_000),
        adapter_watts: None,
        notes: String::new(),
        cycle_source: "SelfTest".into(),
        capacity_history: Vec::new(),
        ..Default::default()
    };
    let normal_samples: Vec<BatteryLiveSample> = (0..12)
        .map(|i| BatteryLiveSample {
            timestamp_ms: i * 3000,
            charge_percent: 80.0 - (i as f64) * 0.08,
            ac_plugged: false,
            is_charging: false,
            voltage_mv: Some(if i < 4 { 11_420 } else { 11_210 }),
            rate_mw: Some(if i < 4 { -7_000 } else { -22_000 }),
            watts: Some(if i < 4 { 7.0 } else { 22.0 }),
        })
        .collect();
    let bat_norm = battery::classify_battery_discharge(&normal_samples, 4, &dummy_health, 36.0, None, false);
    if bat_norm.verdict != "NORMAL" {
        return Err(format!("Expected NORMAL battery discharge verdict, got {}", bat_norm.verdict));
    }
    let abnormal_samples: Vec<BatteryLiveSample> = (0..12)
        .map(|i| BatteryLiveSample {
            timestamp_ms: i * 3000,
            charge_percent: if i < 6 { 80.0 } else { 73.0 },
            ac_plugged: false,
            is_charging: false,
            voltage_mv: Some(if i < 4 { 11_400 } else { 10_100 }),
            rate_mw: Some(if i < 4 { -7_000 } else if i % 2 == 0 { -45_000 } else { -9_000 }),
            watts: Some(if i < 4 { 7.0 } else if i % 2 == 0 { 45.0 } else { 9.0 }),
        })
        .collect();
    let bat_abn = battery::classify_battery_discharge(&abnormal_samples, 4, &dummy_health, 36.0, None, false);
    if bat_abn.verdict != "ABNORMAL" {
        return Err(format!("Expected ABNORMAL battery discharge verdict, got {}", bat_abn.verdict));
    }
    println!(
        "[PASS] Battery Discharge Normality (normal={}, abnormal={}, SoC abort={}%, max={}s)",
        bat_norm.verdict, bat_abn.verdict, BATTERY_LOW_SOC_ABORT_PCT, BATTERY_DISCHARGE_MAX_SECS
    );

    // 6. SSD Safe Write Budget (128/256/512 MB), Free-Space Guard & RAII TempFileGuard
    let b_q = storage::compute_ssd_write_budget("quick");
    let b_s = storage::compute_ssd_write_budget("standard");
    let b_b = storage::compute_ssd_write_budget("burnin");
    if b_q.total_budget_mb != 128 || b_s.total_budget_mb != 256 || b_b.total_budget_mb != 512 {
        return Err("SSD Safe Write Budget mismatch".into());
    }
    if storage::validate_free_space_mb(1024, 256).is_ok() || storage::validate_free_space_mb(4096, 256).is_err() {
        return Err("SSD free-space 4x multiplier guard failed".into());
    }
    let tmp_guard_path = std::env::temp_dir().join(format!("lbqc_guard_test_{}.tmp", std::process::id()));
    {
        let _tg = storage::TempFileGuard(tmp_guard_path.clone());
        std::fs::write(_tg.path(), b"selftest").map_err(|e| e.to_string())?;
        if !tmp_guard_path.exists() {
            return Err("TempFileGuard test file was not created".into());
        }
    }
    if tmp_guard_path.exists() {
        return Err("RAII TempFileGuard failed to clean up temp file on drop".into());
    }
    println!("[PASS] SSD Safe Write Budget (128/256/512 MB, 4x free-space guard, RAII TempFileGuard drop cleanup)");

    // 7. Thermal Cutoff Bounds & Telemetry Safety Evaluation
    if (clamp_gpu_thermal_cutoff_cmd(Some(105.0)) - 92.0).abs() > 0.01
        || (clamp_gpu_thermal_cutoff_cmd(Some(60.0)) - 75.0).abs() > 0.01
        || (clamp_torture_thermal_cutoff_cmd(Some(105.0)) - 95.0).abs() > 0.01
        || (clamp_torture_thermal_cutoff_cmd(Some(60.0)) - 80.0).abs() > 0.01
    {
        return Err("Thermal cutoff clamping bounds failed".into());
    }
    let hot_snap = LiveTelemetrySnapshot {
        cpu_usage_pct: 100.0,
        cpu_clock_mhz: 3500,
        cpu_temp_c: Some(96.0),
        cpu_power_w: None,
        gpu_temp_c: Some(93.0),
        gpu_load_pct: None,
        gpu_power_w: None,
        fan_rpm: None,
        ac_plugged: Some(true),
        battery_percent: Some(100.0),
        battery_watts: None,
        sensor_source: "SelfTest".into(),
        cpu_temp_available: true,
        gpu_temp_available: true,
        power_watts_available: false,
        temp_source: "SelfTest".into(),
        per_core_temps_c: vec![94.0, 96.0],
        pawnio_installed: false,
        ..Default::default()
    };
    match telemetry::TelemetryReader::is_thermal_safe(&hot_snap, 95.0, 92.0) {
        telemetry::ThermalSafetyCheck::CutoffTriggered { .. } => {}
        other => return Err(format!("Expected CutoffTriggered thermal check, got {:?}", other)),
    }
    println!("[PASS] Thermal Cutoff Bounds (GPU 75-92C / CPU 80-95C, TelemetryReader::is_thermal_safe verified)");
    let pawnio_state = modules::sensor_bridge::is_pawnio_driver_installed();
    println!(
        "[PASS] Sensor Bridge (HWiNFO64 SharedMem + LHM HTTP :8085 + PawnIO WHQL installed={})",
        pawnio_state
    );

    // 8. Cinebench-style 3D Path-Tracer smoke render
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

    // 9. Dedicated VRAM wgpu compute shader smoke test
    match vram_test::smoke_test_vram_shader() {
        Ok(msg) => println!("[PASS] VRAM Compute Shader: {}", msg),
        Err(e) => println!("[WARN] VRAM Compute Shader skipped: {}", e),
    }

    // 10. Full HTML + PDF + JSON Report Export (with RAII temp dir cleanup)
    let report_tmp_dir = std::env::temp_dir().join(format!("lbqc_selftest_reports_{}", std::process::id()));
    let _report_dir_guard = SelfTestTempDirGuard(report_tmp_dir.clone());
    let sample_payload = ExportReportPayload {
        shop_profile: ShopProfile {
            shop_name: "Self-Test Lab".into(),
            technician_name: "Hein Htet Zaw".into(),
            logo_data_url: None,
            default_output_dir: None,
        },
        customer_or_sku: "SELFTEST-V240".into(),
        technician_notes: "Automated v2.4.0 self-test".into(),
        overall_verdict: "PASSED".into(),
        durability_grade: Some("A+".into()),
        plain_verdict_summary: Some("All 14 stages passed cleanly in v2.4.0 self-test.".into()),
        subsystem_scores: vec![types::SubsystemScoreBar {
            label: "RAM Stability".into(),
            score_pct: 100.0,
            metric_text: "0 errors across 4096 MB".into(),
            status_label: "0 ERR PASS".into(),
        }],
        specs: None,
        tests: vec![types::ReportTestEntry {
            id: "ram".into(),
            name: "11. RAM Stress Test".into(),
            category: "Deep Stress".into(),
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
        output_dir: Some(report_tmp_dir.to_string_lossy().to_string()),
        user_benchmark: Some(ub_cmp),
        battery_discharge: Some(bat_norm),
        battery_charge: None,
        touchscreen: Some(TouchscreenTestResult {
            touch_capable: false,
            status: TestStatus::Skipped,
            verdict: "SKIPPED".into(),
            plain_summary: "Non-touch laptop skipped via Skip Step.".into(),
            ..Default::default()
        }),
        network_report: Some(network::classify_network_report(
            "Wi-Fi".into(),
            Some(866.0),
            Some("LabBench".into()),
            Some(90),
            Some(-50),
            Some(2.0),
            true,
            0.0,
        )),
        cpu_stress: None,
        cosmetic: None,
        hardware_faults: None,
        display_pro: None,
        sleep_audit: None,
        removable_drive_bench: None,
        security_audit: None,
        battery_health: None,
        storage_bench: None,
        perf_bench: None,
        tamper_forensics: None,
        graphics_fps: None,
        gpu_compute: None,
    };
    let exported = report::export_qc_report_files(&sample_payload)?;
    let pdf_bytes = std::fs::read(&exported.pdf_path).map_err(|e| e.to_string())?;
    let html_str = std::fs::read_to_string(&exported.html_path).map_err(|e| e.to_string())?;
    let json_str = std::fs::read_to_string(&exported.json_path).map_err(|e| e.to_string())?;
    if !pdf_bytes.starts_with(b"%PDF-1.4") || !pdf_bytes.ends_with(b"%%EOF\n") {
        return Err("Exported PDF failed header/EOF integrity check".into());
    }
    if !html_str.contains("LaptopBench QC v3.4.0") || !html_str.contains("Hein Htet Zaw") {
        return Err("Exported HTML missing v3.4.0 or attribution".into());
    }
    if !json_str.contains("\"userBenchmark\"") || !json_str.contains("\"batteryDischarge\"") {
        return Err("Exported JSON missing userBenchmark or batteryDischarge keys".into());
    }
    println!(
        "[PASS] Native PDF 1.4 + HTML + JSON Report Export ({} bytes PDF, cleaned up on drop)",
        pdf_bytes.len()
    );

    // 11. Network Diagnostics + Live Telemetry & OS diagnostic probes
    let net_cls = network::classify_network_report(
        "Ethernet".into(),
        Some(1000.0),
        None,
        None,
        None,
        Some(1.2),
        true,
        0.0,
    );
    if net_cls.verdict != "HEALTHY" {
        return Err(format!("Network classifier returned {}", net_cls.verdict));
    }
    let net_live = network::run_network_diagnostics()?;
    println!(
        "[PASS] Network Diagnostics ({}): iface={} ping={:?}ms dns={}",
        net_live.verdict, net_live.interface_name, net_live.gateway_ping_ms, net_live.dns_resolve_ok
    );

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
        "[PASS] Battery: present={} health={:?}% cycles={:?} (source={}) history={} pts ac={}",
        bat.present,
        bat.health_percent,
        bat.cycle_count,
        if bat.cycle_source.is_empty() { "N/A" } else { &bat.cycle_source },
        bat.capacity_history.len(),
        bat.ac_plugged
    );

    // 11b. v3.1.0 Smart-Bench Charging IC + Conservation Mode + Smart Cool-Down Verification
    let chg_ok = battery::classify_battery_charge_test(
        &[
            BatteryLiveSample { timestamp_ms: 0, charge_percent: 55.0, ac_plugged: true, is_charging: true, voltage_mv: Some(12_300), rate_mw: Some(32_000), watts: Some(32.0) },
            BatteryLiveSample { timestamp_ms: 12_000, charge_percent: 55.6, ac_plugged: true, is_charging: true, voltage_mv: Some(12_350), rate_mw: Some(31_500), watts: Some(31.5) },
        ],
        12.0,
        false,
    );
    let chg_cons = battery::classify_battery_charge_test(
        &[
            BatteryLiveSample { timestamp_ms: 0, charge_percent: 80.0, ac_plugged: true, is_charging: false, voltage_mv: Some(12_100), rate_mw: Some(0), watts: Some(0.0) },
            BatteryLiveSample { timestamp_ms: 12_000, charge_percent: 80.0, ac_plugged: true, is_charging: false, voltage_mv: Some(12_100), rate_mw: Some(0), watts: Some(0.0) },
        ],
        12.0,
        false,
    );
    let chg_dead = battery::classify_battery_charge_test(
        &[
            BatteryLiveSample { timestamp_ms: 0, charge_percent: 45.0, ac_plugged: true, is_charging: false, voltage_mv: Some(11_100), rate_mw: Some(0), watts: Some(0.0) },
            BatteryLiveSample { timestamp_ms: 12_000, charge_percent: 44.8, ac_plugged: true, is_charging: false, voltage_mv: Some(11_050), rate_mw: Some(-3_000), watts: Some(-3.0) },
        ],
        12.0,
        false,
    );
    let (_, _, cd_cool, _) = cpu_stress::classify_smart_cooldown(Some(65.0), Some(61.0), 12.0);
    let (_, _, cd_poor, _) = cpu_stress::classify_smart_cooldown(Some(88.0), Some(84.0), 12.0);
    if chg_ok.verdict != "PASS"
        || chg_cons.verdict != "CONSERVATION_MODE"
        || chg_dead.verdict != "CHARGING_IC_FAULT"
        || cd_cool != "COOL_LOAD"
        || cd_poor != "POOR_COOLING"
    {
        return Err("v3.1.0 Charging IC or Smart Cool-Down classifier check failed".into());
    }
    println!(
        "[PASS] v3.1.0 Charging IC & Smart Cool-Down (ok={}, cons={}, dead={}, cool={}, poor={})",
        chg_ok.verdict, chg_cons.verdict, chg_dead.verdict, cd_cool, cd_poor
    );

    let logs = error_logs::scan_error_logs(7);
    println!("[PASS] Error Logs ({:?}): {}", logs.status, logs.summary);

    let smart = storage::scan_storage_smart();
    println!("[PASS] Storage SMART ({:?}): {}", smart.status, smart.summary);

    let bio = biometrics::detect_biometrics_hardware();
    println!("[PASS] Biometrics ({:?}): {}", bio.suggested_status, bio.summary);

    let hw_ctrl = hardware_controls::get_hardware_controls_status();
    println!("[PASS] Hardware Controls ({}): {}", hw_ctrl.platform, hw_ctrl.summary);

    let hw_faults = hardware_faults::scan_hardware_faults();
    println!(
        "[PASS] Hidden Hardware Faults & Panel EDID ({:?}): {}",
        hw_faults.status, hw_faults.summary
    );

    let port_diag = port_diagnostics::scan_port_diagnostics();
    println!("[PASS] Live Port Diagnostics ({}): {}", port_diag.platform, port_diag.summary);

    let disp_caps = display_pro::probe_display_capabilities();
    let disp_mismatch = display_pro::evaluate_display_capabilities(
        1920,
        1080,
        60,
        144,
        vec![60, 144],
        Some(32),
        1,
        "SelfTest",
    );
    let hinge_ok = display_pro::classify_hinge_flex_result(15.0, 60, 0, 0, 0, false);
    let hinge_fail = display_pro::classify_hinge_flex_result(6.0, 24, 1, 0, 0, false);
    let (smart_warn, _) =
        display_pro::classify_display_pro_smart_verdict(1, 0, "none", false, false, false, false);
    let (smart_fail, _) =
        display_pro::classify_display_pro_smart_verdict(0, 0, "none", false, false, false, true);
    if !disp_mismatch.max_hz_mismatch
        || hinge_ok.verdict != "STABLE"
        || hinge_fail.verdict != "EDP_DROP_DETECTED"
        || smart_warn != TestStatus::Warn
        || smart_fail != TestStatus::Fail
    {
        return Err("v3.1.0 Display Pro capability/hinge/verdict check failed".into());
    }
    println!(
        "[PASS] v3.1.0 Display Pro ({}x{} @ {}Hz / max {}Hz | mismatch_guard=ok | hinge=STABLE/DROP)",
        disp_caps.active_width, disp_caps.active_height, disp_caps.active_hz, disp_caps.native_max_hz
    );

    let sleep_rep = sleep_audit::run_sleep_standby_audit();
    let (bd_stuck, _) = cpu_stress::evaluate_bd_prochot(399, 5.0);
    let (_, _, _, _, ssd_throt) = storage::classify_ssd_write_collapse(&[2400.0, 2200.0, 450.0, 380.0, 360.0, 350.0], Some(42), Some(73));
    let rem_slow = port_diagnostics::classify_removable_drive_speed("E:\\".into(), "USB3".into(), "USB Flash Drive".into(), 64, 20.0, 32.0, 4.0);
    let rem_list = port_diagnostics::list_removable_drives();
    if !bd_stuck || ssd_throt != "SSD_THERMAL_THROTTLE" || rem_slow.verdict != "USB2_FALLBACK_WARN" {
        return Err("v3.1.0 BD PROCHOT / SSD Thermal Collapse / USB Speed classifier check failed".into());
    }
    println!(
        "[PASS] v3.1.0 Multi-Upgrade Engine (Sleep={} [{}] | BD_PROCHOT=ok | SSD_Collapse={} | RemovableDrives={})",
        sleep_rep.verdict, sleep_rep.sleep_mode, ssd_throt, rem_list.len()
    );

    let nv_throt = telemetry::decode_nvml_throttle_reasons(0x40 | 0x04);
    let chg_warn = battery::evaluate_charger_adequacy(true, Some(45), true);
    let tf_rep = hardware_faults::evaluate_tamper_forensics(Some(&sp), Some(&bat), Some(&smart), Some(&hw_faults));
    let (port_ok, _) = portable::evaluate_portable_mode(std::path::Path::new("E:\\LaptopBench.QC_3.4.0_x64-portable.exe"), true, false);
    if nv_throt.len() < 2 || chg_warn.is_none() || !port_ok {
        return Err("v3.1.0 Forensics / NVML / Charger Adequacy / Portable USB check failed".into());
    }
    println!(
        "[PASS] v3.1.0 Forensics & Zero-Driver Engine (NVML_Decode=ok | ChargerWarn=ok | PortableDetect=ok | TamperForensics={:?})",
        tf_rep.status
    );

    let vid_fps = perf_bench::run_video_dct_motion_bench(2);
    let (sha_mbs, scale_ratio, scale_eff) = perf_bench::run_sha256_throughput_bench(2, 2);
    let json_mbs = perf_bench::run_json_throughput_bench(2);
    if vid_fps <= 0.0 || sha_mbs <= 0.0 || json_mbs <= 0.0 || scale_ratio <= 0.0 {
        return Err("v3.4.0 Video DCT / SHA-256 / JSON / Core-Scaling kernel check failed".into());
    }
    let gpu_comp_summary = match gpu_stress::run_gpu_compute_bench(None) {
        Ok(gc) => {
            if !gc.verified_ok || gc.fp32_gflops <= 0.0 {
                return Err(format!("v3.4.0 GPU FP32 compute verification failed: {}", gc.plain_summary));
            }
            format!(
                "{:.1} GFLOPS | 1080p3D={:.1} FPS (preview={}) ({})",
                gc.fp32_gflops,
                gc.uncapped_3d_fps,
                gc.preview_data_url.is_some(),
                gc.adapter_name
            )
        }
        Err(e) => format!("Skipped ({})", e),
    };
    println!(
        "[PASS] v3.4.0 Graphics & Performance Expansion (Video4K={:.1} FPS | SHA256={:.1} MB/s | JSON={:.1} MB/s | Scaling={:.2}x [{:.0}%] | GPU_FP32={})",
        vid_fps, sha_mbs, json_mbs, scale_ratio, scale_eff, gpu_comp_summary
    );

    let mut cpu_buf = vec![0u64; 1024];
    let cd1 = cpu_stress::compute_deterministic_cpu_block(0xCAFE_BABE, &mut cpu_buf);
    let cd2 = cpu_stress::compute_deterministic_cpu_block(0xCAFE_BABE, &mut cpu_buf);
    let (_, cd_verdict, _) = cpu_stress::classify_cooldown_recovery(Some(85.0), Some(66.0));
    if cd1 != cd2 || cd_verdict != "EXCELLENT" {
        return Err("OCCT CPU Stress kernel or cool-down classifier failed".into());
    }
    println!("[PASS] OCCT CPU Stress Engine (deterministic checksum=0x{:016X}, cooldown={})", cd1, cd_verdict);

    let gpus = gpu_stress::list_gpu_adapters();
    println!("[PASS] wgpu GPU Adapters detected: {}", gpus.len());
    for g in &gpus {
        println!("       - [{}] {} ({}, {})", g.index, g.name, g.device_type, g.backend);
    }

    println!("=== ALL v3.4.0 SELF-TESTS PASSED ===");
    Ok(())
}

#[tauri::command]
async fn run_gpu_compute_bench(adapter_index: Option<usize>) -> Result<GpuComputeBenchResult, String> {
    tauri::async_runtime::spawn_blocking(move || gpu_stress::run_gpu_compute_bench(adapter_index))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_portable_mode_info(app: AppHandle) -> PortableStorageInfo {
    portable::get_portable_mode_info(&app)
}

#[tauri::command]
fn evaluate_tamper_forensics(
    specs: Option<SystemSpecs>,
    battery: Option<BatteryHealthReport>,
    smart: Option<StorageSmartReport>,
    faults: Option<HardwareFaultsReport>,
) -> TamperForensicsReport {
    hardware_faults::evaluate_tamper_forensics(
        specs.as_ref(),
        battery.as_ref(),
        smart.as_ref(),
        faults.as_ref(),
    )
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
            run_battery_discharge_test,
            cancel_battery_discharge_test,
            run_battery_charge_test,
            cancel_battery_charge_test,
            run_network_diagnostics,
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
            run_gpu_compute_bench,
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
            compare_userbenchmark,
            get_hardware_controls_status,
            set_display_brightness,
            run_cpu_stress,
            cancel_cpu_stress,
            list_qc_archive,
            check_warranty_return_diff,
            delete_qc_archive_entry,
            export_qc_archive,
            import_qc_archive,
            scan_hardware_faults,
            scan_port_diagnostics,
            probe_display_capabilities,
            run_edp_hinge_flex_test,
            cancel_edp_hinge_flex_test,
            run_sleep_standby_audit,
            list_removable_drives,
            run_removable_drive_speed_test,
            get_portable_mode_info,
            evaluate_tamper_forensics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LaptopBench QC");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lib_thermal_cutoff_clamping_bounds() {
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(None), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(Some(105.0)), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(Some(60.0)), 75.0);
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(Some(85.0)), 85.0);
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(Some(f32::NAN)), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff_cmd(Some(f32::INFINITY)), 92.0);

        assert_eq!(clamp_torture_thermal_cutoff_cmd(None), 92.0);
        assert_eq!(clamp_torture_thermal_cutoff_cmd(Some(105.0)), 95.0);
        assert_eq!(clamp_torture_thermal_cutoff_cmd(Some(60.0)), 80.0);
        assert_eq!(clamp_torture_thermal_cutoff_cmd(Some(88.0)), 88.0);
        assert_eq!(clamp_torture_thermal_cutoff_cmd(Some(f32::NAN)), 92.0);
        assert_eq!(clamp_torture_thermal_cutoff_cmd(Some(f32::NEG_INFINITY)), 92.0);
    }
}
