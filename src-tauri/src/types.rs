use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TestStatus {
    #[default]
    Pending,
    Running,
    Pass,
    Warn,
    Fail,
    Skipped,
    NotApplicable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRating {
    pub detected_class: String,
    pub expected_normal: String,
    pub percent_of_normal: f64,
    pub grade: String,
    pub verdict_note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct RamModuleInfo {
    pub slot: String,
    pub capacity_gb: f64,
    pub speed_mhz: Option<u32>,
    pub memory_type: String,
    pub form_factor: String,
    pub manufacturer: String,
    pub part_number: String,
    pub serial_number: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GpuSpecInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
    pub driver_version: String,
    pub driver_date: String,
    pub pnp_device_id: String,
    pub is_discrete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct DiskSpecInfo {
    pub model: String,
    pub interface_type: String,
    pub media_type: String,
    pub size_gb: f64,
    pub serial_number: String,
    pub firmware: String,
    pub partition_style: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct VolumeSpecInfo {
    pub mount: String,
    pub label: String,
    pub file_system: String,
    pub total_gb: f64,
    pub free_gb: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct DisplaySpecInfo {
    pub name: String,
    pub manufacturer: String,
    pub resolution: String,
    pub refresh_rate_hz: Option<u32>,
    pub diagonal_inches: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct NetworkAdapterInfo {
    pub name: String,
    pub kind: String, // "Wi-Fi" | "Ethernet" | "Bluetooth" | "Other"
    pub mac_address: String,
    pub link_speed: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PeripheralDeviceInfo {
    pub category: String, // "Audio" | "Camera" | "USB / Thunderbolt" | "Bluetooth" | "Input"
    pub name: String,
    pub manufacturer: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct SystemSpecs {
    pub os_family: String,
    pub os_name: String,
    pub os_version: String,
    pub os_build: String,
    pub architecture: String,
    pub hostname: String,
    pub manufacturer: String,
    pub model: String,
    pub system_sku: String,
    pub chassis_type: String,
    pub serial_number: String,
    pub system_uuid: String,
    pub motherboard_vendor: String,
    pub motherboard_product: String,
    pub motherboard_serial: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub bios_date: String,
    pub cpu_brand: String,
    pub cpu_socket: String,
    pub cpu_physical_cores: usize,
    pub cpu_logical_cores: usize,
    pub cpu_base_mhz: u64,
    pub cpu_max_mhz: Option<u64>,
    pub cpu_l2_kb: Option<u64>,
    pub cpu_l3_kb: Option<u64>,
    pub cpu_virtualization: Option<bool>,
    pub total_ram_gb: f64,
    pub ram_slots_total: Option<u32>,
    pub ram_max_capacity_gb: Option<f64>,
    pub ram_modules: Vec<RamModuleInfo>,
    pub gpus: Vec<GpuSpecInfo>,
    pub disks: Vec<DiskSpecInfo>,
    pub volumes: Vec<VolumeSpecInfo>,
    pub displays: Vec<DisplaySpecInfo>,
    pub network_adapters: Vec<NetworkAdapterInfo>,
    pub peripherals: Vec<PeripheralDeviceInfo>,
    #[serde(default)]
    pub wifi_ssid: Option<String>,
    #[serde(default)]
    pub wifi_signal_pct: Option<u32>,
    #[serde(default)]
    pub wifi_rssi_dbm: Option<i32>,
    #[serde(default)]
    pub wifi_radio_type: Option<String>,
    #[serde(default)]
    pub wifi_antenna_warning: Option<String>,
    #[serde(default)]
    pub ram_channel_mode: Option<String>,
    #[serde(default)]
    pub ram_config_warning: Option<String>,
    #[serde(default)]
    pub ram_reliability_note: Option<String>,
    #[serde(default)]
    pub reliability_notes: Vec<String>,
    #[serde(default)]
    pub plain_summary: String,
    pub is_gaming_capable: bool,
    pub is_elevated: bool,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct SecurityCheckItem {
    pub id: String,
    pub label: String,
    pub value: String,
    pub status: TestStatus,
    pub detail: String,
    #[serde(default)]
    pub buyer_note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct SecurityAuditReport {
    pub overall_status: TestStatus,
    pub platform: String,
    pub mdm_enrolled: Option<bool>,
    pub activation_locked: Option<bool>,
    pub items: Vec<SecurityCheckItem>,
    pub summary: String,
    #[serde(default)]
    pub plain_summary: String,
    #[serde(default)]
    pub ownership_risks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryHealthReport {
    pub present: bool,
    pub status: TestStatus,
    pub manufacturer: String,
    pub chemistry: String,
    pub design_capacity_mwh: Option<u64>,
    pub full_charge_capacity_mwh: Option<u64>,
    pub health_percent: Option<f64>,
    pub wear_percent: Option<f64>,
    pub cycle_count: Option<u32>,
    pub current_charge_percent: Option<f64>,
    pub is_charging: bool,
    pub ac_plugged: bool,
    pub voltage_mv: Option<u64>,
    pub rate_mw: Option<i64>,
    pub adapter_watts: Option<u32>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryLiveSample {
    pub timestamp_ms: i64,
    pub charge_percent: f64,
    pub ac_plugged: bool,
    pub is_charging: bool,
    pub voltage_mv: Option<u64>,
    pub rate_mw: Option<i64>,
    pub watts: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatterySagProgress {
    pub running: bool,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub charge_percent: f64,
    pub voltage_mv: Option<u64>,
    pub watts: Option<f64>,
    pub ac_plugged: bool,
    pub voltage_drop_mv: i64,
    pub charge_drop_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatterySagResult {
    pub status: TestStatus,
    pub duration_secs: u64,
    pub was_on_battery: bool,
    pub start_charge_pct: f64,
    pub end_charge_pct: f64,
    pub charge_drop_pct: f64,
    pub start_voltage_mv: Option<u64>,
    pub min_voltage_mv: Option<u64>,
    pub max_voltage_sag_mv: i64,
    pub peak_discharge_w: Option<f64>,
    pub summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UsbDeviceInfo {
    pub instance_id: String,
    pub name: String,
    pub speed_class: String,
    pub is_superspeed: bool,
    pub status: String,
    #[serde(default)]
    pub negotiated_mbps: Option<u32>,
    #[serde(default)]
    pub controller_type: String,
    #[serde(default)]
    pub error_code: Option<u32>,
    #[serde(default)]
    pub reliability_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbHotplugEvent {
    pub event_kind: String, // "CONNECTED" | "DISCONNECTED" | "SNAPSHOT"
    pub timestamp: String,
    pub device: Option<UsbDeviceInfo>,
    pub devices: Vec<UsbDeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSessionPayload {
    pub serial_number: String,
    pub model: String,
    pub saved_at: String,
    pub active_stress_stage: Option<String>,
    pub state_json: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct ErrorLogEntry {
    pub timestamp: String,
    pub source: String,
    pub level: String,
    pub event_id: Option<u32>,
    pub category: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct ErrorLogsReport {
    pub status: TestStatus,
    pub days_scanned: u32,
    pub critical_count: usize,
    pub error_count: usize,
    pub bsod_or_panic_count: usize,
    pub whea_or_hw_count: usize,
    pub disk_error_count: usize,
    pub gpu_reset_count: usize,
    pub minidump_files: Vec<String>,
    pub entries: Vec<ErrorLogEntry>,
    pub summary: String,
    #[serde(default)]
    pub thermal_event_count: usize,
    #[serde(default)]
    pub plain_summary: String,
    #[serde(default)]
    pub buyer_interpretation: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct DriveSmartInfo {
    pub device_id: String,
    pub model: String,
    pub serial_number: String,
    pub interface_type: String,
    pub media_type: String,
    pub size_gb: f64,
    pub health_status: String,
    pub status: TestStatus,
    pub health_percent: Option<u32>,
    pub wear_percent: Option<u32>,
    pub temperature_c: Option<i32>,
    pub power_on_hours: Option<u64>,
    pub power_cycles: Option<u64>,
    pub unsafe_shutdowns: Option<u64>,
    pub media_errors: Option<u64>,
    pub read_errors: Option<u64>,
    pub write_errors: Option<u64>,
    pub tbw_gb: Option<f64>,
    pub available_spare_pct: Option<u32>,
    pub notes: String,
    #[serde(default)]
    pub critical_warning_flags: Vec<String>,
    #[serde(default)]
    pub available_spare_threshold_pct: Option<u32>,
    #[serde(default)]
    pub percentage_used_raw: Option<u32>,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct StorageSmartReport {
    pub status: TestStatus,
    pub drives: Vec<DriveSmartInfo>,
    pub summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct StorageBenchResult {
    pub status: TestStatus,
    pub preset: String,
    pub test_size_mb: u64,
    pub direct_io: bool,
    pub seq_write_mb_s: f64,
    pub seq_read_mb_s: f64,
    pub rand_4k_write_mb_s: f64,
    pub rand_4k_read_mb_s: f64,
    pub rand_4k_write_iops: u64,
    pub rand_4k_read_iops: u64,
    pub avg_4k_latency_ms: f64,
    pub p99_4k_latency_ms: f64,
    pub integrity_errors: u64,
    pub elapsed_secs: f64,
    pub baseline: BaselineRating,
    pub summary: String,
    #[serde(default)]
    pub total_written_mb: u64,
    #[serde(default)]
    pub rand_4k_qd32_read_mb_s: f64,
    #[serde(default)]
    pub rand_4k_qd32_write_mb_s: f64,
    #[serde(default)]
    pub rand_4k_qd32_read_iops: u64,
    #[serde(default)]
    pub rand_4k_qd32_write_iops: u64,
    #[serde(default)]
    pub mixed_rw_mb_s: f64,
    #[serde(default)]
    pub mixed_rw_iops: u64,
    #[serde(default)]
    pub slc_sustained_mb_s: f64,
    #[serde(default)]
    pub slc_cache_drop_pct: f64,
    #[serde(default)]
    pub write_stability_pct: f64,
    #[serde(default)]
    pub peak_drive_temp_c: Option<i32>,
    #[serde(default)]
    pub thermal_warning: bool,
    #[serde(default)]
    pub thermal_cutoff_triggered: bool,
    #[serde(default)]
    pub userbenchmark_rating: Option<UserBenchmarkComponentRating>,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct StorageBenchProgress {
    pub phase: String,
    pub percent: f64,
    pub current_mb_s: f64,
    pub elapsed_secs: f64,
    pub integrity_errors: u64,
    #[serde(default)]
    pub drive_temp_c: Option<i32>,
    #[serde(default)]
    pub thermal_warning: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct RamTestProgress {
    pub running: bool,
    pub profile_name: String,
    pub test_index: usize,
    pub pattern_name: String,
    pub cycle: u32,
    pub percent: f64,
    pub allocated_mb: u64,
    pub total_gb_verified: f64,
    pub bandwidth_gb_s: f64,
    pub errors_found: u64,
    pub per_test_passes: Vec<u32>,
    pub per_test_errors: Vec<u64>,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    #[serde(default)]
    pub cpu_temp_c: Option<f32>,
    #[serde(default)]
    pub thermal_warning: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct RamTestResult {
    pub status: TestStatus,
    pub preset: String,
    pub profile_name: String,
    pub allocated_mb: u64,
    pub total_ram_mb: u64,
    pub total_gb_verified: f64,
    pub cycles_completed: u32,
    pub patterns_tested: Vec<String>,
    pub per_test_passes: Vec<u32>,
    pub per_test_errors: Vec<u64>,
    pub errors_found: u64,
    pub peak_bandwidth_gb_s: f64,
    pub avg_bandwidth_gb_s: f64,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub baseline: BaselineRating,
    pub summary: String,
    #[serde(default)]
    pub os_reserve_mb: u64,
    #[serde(default)]
    pub peak_cpu_temp_c: Option<f32>,
    #[serde(default)]
    pub thermal_cutoff_triggered: bool,
    #[serde(default)]
    pub sensor_unavailable: bool,
    #[serde(default)]
    pub userbenchmark_rating: Option<UserBenchmarkComponentRating>,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricSensorInfo {
    pub kind: String,
    pub name: String,
    pub driver_ok: bool,
    pub error_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricsHardwareReport {
    pub platform: String,
    pub fingerprint_present: bool,
    pub face_ir_present: bool,
    pub sensors: Vec<BiometricSensorInfo>,
    pub suggested_status: TestStatus,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricAuthResult {
    pub outcome: String,
    pub status: TestStatus,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct LiveTelemetrySnapshot {
    pub cpu_usage_pct: f32,
    pub cpu_clock_mhz: u64,
    pub cpu_temp_c: Option<f32>,
    pub cpu_power_w: Option<f32>,
    pub gpu_temp_c: Option<f32>,
    pub gpu_load_pct: Option<f32>,
    pub gpu_power_w: Option<f32>,
    pub fan_rpm: Option<u32>,
    pub ac_plugged: Option<bool>,
    pub battery_percent: Option<f64>,
    pub battery_watts: Option<f64>,
    pub sensor_source: String,
    // M2.1 Sensor Availability & Attribution
    pub cpu_temp_available: bool,
    pub gpu_temp_available: bool,
    pub power_watts_available: bool,
    pub temp_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopModelBenchmarkAvg {
    pub model_key: String,
    pub display_label: String,
    pub units_tested: u32,
    pub avg_composite_score: Option<f64>,
    pub avg_office_score: Option<f64>,
    pub avg_creator_score: Option<f64>,
    pub avg_memory_mark: Option<f64>,
    pub avg_gpu_fps: Option<f64>,
    pub avg_ssd_read_mb_s: Option<f64>,
    pub last_tested_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopModelComparison {
    pub found: bool,
    pub units_tested: u32,
    pub shop_avg_composite: Option<f64>,
    pub shop_avg_office: Option<f64>,
    pub shop_avg_creator: Option<f64>,
    pub shop_avg_gpu_fps: Option<f64>,
    pub shop_avg_ssd_read: Option<f64>,
    pub percent_vs_shop: Option<f64>,
    pub last_tested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopRecordSample {
    pub manufacturer: String,
    pub model: String,
    pub cpu_brand: String,
    pub composite_score: Option<f64>,
    pub office_score: Option<f64>,
    pub creator_score: Option<f64>,
    pub memory_mark: Option<f64>,
    pub gpu_fps: Option<f64>,
    pub ssd_read_mb_s: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PerfBenchProgress {
    pub phase: String,
    pub percent: f64,
    pub elapsed_secs: f64,
    pub cpu_usage_pct: f32,
    pub cpu_clock_mhz: u64,
    pub cpu_temp_c: Option<f32>,
    pub raytrace_preview_url: Option<String>,
    pub telemetry: Option<LiveTelemetrySnapshot>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PerfBenchResult {
    pub status: TestStatus,
    pub preset: String,
    pub simd_isa: String,
    pub integer_math_score: u64,
    pub float_math_score: u64,
    pub prime_score: u64,
    pub vector_score: u64,
    pub compression_score: u64,
    pub encryption_score: u64,
    pub physics_score: u64,
    pub sorting_score: u64,
    pub database_score: u64,
    pub single_core_score: u64,
    pub multi_core_score: u64,
    pub office_score: u64,
    pub creator_score: u64,
    pub creator_raytrace_score: u64,
    pub creator_mega_rays_s: f64,
    pub creator_ai_gemm_score: u64,
    pub creator_image_score: u64,
    pub raytrace_preview_url: Option<String>,
    pub memory_cached_gb_s: f64,
    pub memory_bandwidth_gb_s: f64,
    pub memory_write_gb_s: f64,
    pub memory_latency_ns: f64,
    pub memory_mark: u64,
    pub composite_score: u64,
    pub throttle_drop_pct: f64,
    pub tier: String,
    pub durability_grade: String,
    pub peak_cpu_temp_c: Option<f32>,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub baseline: BaselineRating,
    pub shop_comparison: Option<ShopModelComparison>,
    pub summary: String,
    #[serde(default)]
    pub memory_uncached_read_gb_s: f64,
    #[serde(default)]
    pub memory_threaded_gb_s: f64,
    #[serde(default)]
    pub memory_database_kops: f64,
    #[serde(default)]
    pub available_ram_mb: u64,
    #[serde(default)]
    pub thermal_cutoff_triggered: bool,
    #[serde(default)]
    pub sensor_unavailable: bool,
    #[serde(default)]
    pub userbenchmark_rating: Option<UserBenchmarkComponentRating>,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct VramTestProgress {
    pub running: bool,
    pub adapter_name: String,
    pub pattern_name: String,
    pub pass_number: u32,
    pub percent: f64,
    pub allocated_vram_mb: u64,
    pub total_gb_verified: f64,
    pub bandwidth_gb_s: f64,
    pub errors_found: u64,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub gpu_temp_c: Option<f32>,
    #[serde(default)]
    pub thermal_warning: bool,
    #[serde(default)]
    pub gpu_temp_available: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct VramTestResult {
    pub status: TestStatus,
    pub adapter_name: String,
    pub backend: String,
    pub allocated_vram_mb: u64,
    pub passes_completed: u32,
    pub total_gb_verified: f64,
    pub avg_bandwidth_gb_s: f64,
    pub errors_found: u64,
    pub peak_temp_c: Option<f32>,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub baseline: BaselineRating,
    pub summary: String,
    #[serde(default)]
    pub thermal_cutoff_triggered: bool,
    #[serde(default)]
    pub effective_cutoff_c: f32,
    #[serde(default)]
    pub sensor_available: bool,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PowerTortureProgress {
    pub running: bool,
    pub adapter_name: String,
    pub simd_isa: String,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub percent: f64,
    pub gpu_fps: f64,
    pub gpu_avg_fps: f64,
    pub cpu_ops_per_sec: f64,
    pub telemetry: LiveTelemetrySnapshot,
    pub battery_start_pct: Option<f64>,
    pub battery_delta_pct: Option<f64>,
    pub battery_drain_while_plugged: bool,
    pub thermal_warning: bool,
    pub preview_data_url: Option<String>,
    #[serde(default)]
    pub artifact_errors: u64,
    #[serde(default)]
    pub throttle_state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PowerTortureResult {
    pub status: TestStatus,
    pub adapter_name: String,
    pub simd_isa: String,
    pub duration_secs: u64,
    pub elapsed_secs: f64,
    pub avg_fps: f64,
    pub fps_drop_pct: f64,
    pub peak_cpu_temp_c: Option<f32>,
    pub peak_gpu_temp_c: Option<f32>,
    pub peak_gpu_power_w: Option<f32>,
    pub battery_start_pct: Option<f64>,
    pub battery_end_pct: Option<f64>,
    pub battery_delta_pct: Option<f64>,
    pub battery_drain_while_plugged: bool,
    pub thermal_cutoff_triggered: bool,
    pub cancelled: bool,
    pub durability_grade: String,
    pub baseline: BaselineRating,
    pub summary: String,
    #[serde(default)]
    pub artifact_errors: u64,
    #[serde(default)]
    pub avg_gpu_power_w: Option<f32>,
    #[serde(default)]
    pub peak_cpu_power_w: Option<f32>,
    #[serde(default)]
    pub thermal_throttling_detected: bool,
    #[serde(default)]
    pub power_limit_throttling: bool,
    #[serde(default)]
    pub throttle_reason: String,
    #[serde(default)]
    pub sensor_available: bool,
    #[serde(default)]
    pub effective_cpu_cutoff_c: f32,
    #[serde(default)]
    pub effective_gpu_cutoff_c: f32,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct BurnInProgress {
    pub running: bool,
    pub stage_index: u32,
    pub total_stages: u32,
    pub stage_name: String,
    pub stage_detail: String,
    pub overall_percent: f64,
    pub elapsed_secs: f64,
    pub total_duration_secs: u64,
    pub ram_errors: u64,
    pub vram_errors: u64,
    pub battery_drain_alert: bool,
    pub telemetry: Option<LiveTelemetrySnapshot>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct BurnInResult {
    pub status: TestStatus,
    pub total_minutes: u64,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub ram_result: Option<RamTestResult>,
    pub vram_result: Option<VramTestResult>,
    pub torture_result: Option<PowerTortureResult>,
    pub durability_grade: String,
    pub summary: String,
    #[serde(default)]
    pub thermal_cutoff_triggered: bool,
    #[serde(default)]
    pub plain_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapterInfo {
    pub index: usize,
    pub name: String,
    pub backend: String,
    pub device_type: String,
    pub vendor_id: u32,
    pub is_discrete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GpuStressProgress {
    pub running: bool,
    pub adapter_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub avg_fps: f64,
    pub min_fps: f64,
    pub low_1pct_fps: f64,
    pub frame_time_ms: f64,
    pub frames_rendered: u64,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub gpu_temp_c: Option<f32>,
    pub gpu_load_pct: Option<f32>,
    pub gpu_power_w: Option<f32>,
    pub thermal_warning: bool,
    pub preview_data_url: Option<String>,
    #[serde(default)]
    pub artifact_errors: u64,
    #[serde(default)]
    pub gpu_temp_available: bool,
    #[serde(default)]
    pub throttle_state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GpuStressResult {
    pub status: TestStatus,
    pub adapter_name: String,
    pub backend: String,
    pub resolution: String,
    pub preset: String,
    pub avg_fps: f64,
    pub min_fps: f64,
    pub max_fps: f64,
    pub low_1pct_fps: f64,
    pub fps_drop_pct: f64,
    pub frames_rendered: u64,
    pub peak_temp_c: Option<f32>,
    pub peak_power_w: Option<f32>,
    pub thermal_cutoff_triggered: bool,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub baseline: BaselineRating,
    pub summary: String,
    #[serde(default)]
    pub artifact_errors: u64,
    #[serde(default)]
    pub avg_power_w: Option<f32>,
    #[serde(default)]
    pub avg_load_pct: Option<f32>,
    #[serde(default)]
    pub thermal_throttling_detected: bool,
    #[serde(default)]
    pub power_limit_throttling: bool,
    #[serde(default)]
    pub throttle_reason: String,
    #[serde(default)]
    pub sensor_available: bool,
    #[serde(default)]
    pub effective_cutoff_c: f32,
    #[serde(default)]
    pub plain_summary: String,
    #[serde(default)]
    pub userbenchmark_rating: Option<UserBenchmarkComponentRating>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopProfile {
    pub shop_name: String,
    pub technician_name: String,
    pub logo_data_url: Option<String>,
    pub default_output_dir: Option<String>,
}

impl Default for ShopProfile {
    fn default() -> Self {
        Self {
            shop_name: String::new(),
            technician_name: String::new(),
            logo_data_url: None,
            default_output_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTestEntry {
    pub id: String,
    pub name: String,
    pub category: String,
    pub status: TestStatus,
    pub summary: String,
    pub metrics: Vec<(String, String)>,
    pub notes: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct TouchscreenTestResult {
    pub touch_capable: bool,
    pub max_touch_points_reported: u32,
    pub grid_rows: u32,
    pub grid_cols: u32,
    pub covered_cells: u32,
    pub total_cells: u32,
    pub coverage_pct: f64,
    pub max_simultaneous_touches: u32,
    pub swipe_linearity_rms_px: f64,
    pub max_linearity_error_px: Option<f64>,
    pub polling_hz: f64,
    pub tap_latency_ms: Option<f64>,
    pub status: TestStatus,
    pub verdict: String,
    pub plain_summary: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PortsSpeakerSignoff {
    pub ports_checked: bool,
    pub ports_notes: String,
    pub speakers_checked: bool,
    pub speakers_notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsystemScoreBar {
    pub label: String,
    pub score_pct: f64,
    pub metric_text: String,
    pub status_label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct ExportReportPayload {
    pub shop_profile: ShopProfile,
    pub customer_or_sku: String,
    pub technician_notes: String,
    pub overall_verdict: String,
    #[serde(default)]
    pub durability_grade: Option<String>,
    #[serde(default)]
    pub subsystem_scores: Vec<SubsystemScoreBar>,
    pub specs: Option<SystemSpecs>,
    pub tests: Vec<ReportTestEntry>,
    pub signoff: PortsSpeakerSignoff,
    pub output_dir: Option<String>,
    #[serde(default)]
    pub plain_verdict_summary: Option<String>,
    #[serde(default, alias = "userbenchmarkComparison")]
    pub user_benchmark: Option<UserBenchmarkComparison>,
    #[serde(default, alias = "batteryDischargeResult")]
    pub battery_discharge: Option<BatteryDischargeResult>,
    #[serde(default, alias = "touchscreenResult")]
    pub touchscreen: Option<TouchscreenTestResult>,
    #[serde(default, alias = "networkDiagnostics")]
    pub network_report: Option<NetworkDiagnosticsReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedReportPaths {
    pub directory: String,
    pub pdf_path: String,
    pub html_path: String,
    pub json_path: String,
    pub generated_at: String,
}

// ============================================================================
// Hardware Safety Constants & Bounds (v2.3.0)
// ============================================================================

#[allow(dead_code)]
pub const CPU_THERMAL_CUTOFF_DEFAULT_C: f32 = 92.0;
#[allow(dead_code)]
pub const CPU_THERMAL_CUTOFF_MIN_C: f32 = 80.0;
#[allow(dead_code)]
pub const CPU_THERMAL_CUTOFF_MAX_C: f32 = 95.0;
#[allow(dead_code)]
pub const GPU_THERMAL_CUTOFF_DEFAULT_C: f32 = 92.0;
#[allow(dead_code)]
pub const GPU_THERMAL_CUTOFF_MIN_C: f32 = 75.0;
#[allow(dead_code)]
pub const GPU_THERMAL_CUTOFF_MAX_C: f32 = 92.0;
#[allow(dead_code)]
pub const SSD_WRITE_BUDGET_QUICK_MB: u64 = 128;
#[allow(dead_code)]
pub const SSD_WRITE_BUDGET_STD_MB: u64 = 256;
#[allow(dead_code)]
pub const SSD_WRITE_BUDGET_MAX_MB: u64 = 512;
#[allow(dead_code)]
pub const SSD_FREE_SPACE_MULTIPLIER: u64 = 4;
#[allow(dead_code)]
pub const RAM_OS_RESERVE_FLOOR_MB: u64 = 512;
#[allow(dead_code)]
pub const RAM_OS_RESERVE_PCT: u64 = 22;
#[allow(dead_code)]
pub const RAM_OS_RESERVE_16GB_CAP_MB: u64 = 1800;
pub const BATTERY_LOW_SOC_ABORT_PCT: f64 = 15.0;
pub const BATTERY_DISCHARGE_MAX_SECS: u64 = 90;

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSafetyBounds {
    pub cpu_thermal_cutoff_c: f32,
    pub gpu_thermal_cutoff_c: f32,
    pub ssd_write_budget_quick_mb: u64,
    pub ssd_write_budget_std_mb: u64,
    pub ssd_write_budget_max_mb: u64,
    pub ssd_free_space_multiplier: u64,
    pub ram_os_reserve_floor_mb: u64,
    pub ram_os_reserve_pct: u64,
    pub battery_low_soc_abort_pct: f64,
    pub battery_discharge_max_secs: u64,
}

impl Default for HardwareSafetyBounds {
    fn default() -> Self {
        Self {
            cpu_thermal_cutoff_c: CPU_THERMAL_CUTOFF_DEFAULT_C,
            gpu_thermal_cutoff_c: GPU_THERMAL_CUTOFF_DEFAULT_C,
            ssd_write_budget_quick_mb: SSD_WRITE_BUDGET_QUICK_MB,
            ssd_write_budget_std_mb: SSD_WRITE_BUDGET_STD_MB,
            ssd_write_budget_max_mb: SSD_WRITE_BUDGET_MAX_MB,
            ssd_free_space_multiplier: SSD_FREE_SPACE_MULTIPLIER,
            ram_os_reserve_floor_mb: RAM_OS_RESERVE_FLOOR_MB,
            ram_os_reserve_pct: RAM_OS_RESERVE_PCT,
            battery_low_soc_abort_pct: BATTERY_LOW_SOC_ABORT_PCT,
            battery_discharge_max_secs: BATTERY_DISCHARGE_MAX_SECS,
        }
    }
}

// ============================================================================
// UserBenchmark Comparison & Rating Contracts
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UserBenchmarkComponentRating {
    pub component: String,
    pub detected_model: String,
    pub effective_speed_pct: f64,
    pub expected_class_pct: f64,
    pub relative_standing_pct: f64,
    pub vehicle_tier: String,
    pub standing_label: String,
    pub plain_summary: String,
    pub source_mode: String,
    pub sub_metrics: Vec<(String, String)>,
    pub bottleneck_flag: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UserBenchmarkComparison {
    pub gaming_pct: f64,
    pub desktop_pct: f64,
    pub workstation_pct: f64,
    pub overall_vehicle_tier: String,
    pub cpu: Option<UserBenchmarkComponentRating>,
    pub gpu: Option<UserBenchmarkComponentRating>,
    pub ssd: Option<UserBenchmarkComponentRating>,
    pub ram: Option<UserBenchmarkComponentRating>,
    pub headline_summary: String,
    pub recommendations: Vec<String>,
    pub source_mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UserBenchmarkInput {
    pub cpu_brand: String,
    pub cpu_physical_cores: Option<usize>,
    pub cpu_logical_cores: Option<usize>,
    pub cpu_single_core: Option<u64>,
    pub cpu_multi_core: Option<u64>,
    pub cpu_composite: Option<u64>,
    pub gpu_name: Option<String>,
    pub gpu_resolution: Option<String>,
    pub gpu_avg_fps: Option<f64>,
    pub gpu_fps_drop_pct: Option<f64>,
    pub gpu_thermal_cutoff: bool,
    pub ssd_model: Option<String>,
    pub ssd_interface: Option<String>,
    pub ssd_media_type: Option<String>,
    pub ssd_seq_read_mb_s: Option<f64>,
    pub ssd_seq_write_mb_s: Option<f64>,
    pub ssd_rand_4k_read_mb_s: Option<f64>,
    pub ssd_rand_4k_write_mb_s: Option<f64>,
    pub ssd_integrity_errors: u64,
    pub ram_type: Option<String>,
    pub ram_bandwidth_gb_s: Option<f64>,
    pub ram_latency_ns: Option<f64>,
    pub ram_channel_mode: Option<String>,
    pub ram_errors_found: u64,
    pub allow_live_lookup: bool,
    pub specs: Option<SystemSpecs>,
    pub perf: Option<PerfBenchResult>,
    pub gpu: Option<GpuStressResult>,
    pub storage: Option<StorageBenchResult>,
    pub ram: Option<RamTestResult>,
}

// ============================================================================
// Battery Discharge Normality Contracts (R3)
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct BatteryDischargeProgress {
    pub running: bool,
    pub phase: String,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub charge_percent: f64,
    pub voltage_mv: Option<u64>,
    pub watts: Option<f64>,
    pub ac_plugged: bool,
    pub voltage_sag_mv: i64,
    pub charge_drop_pct: f64,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct BatteryDischargeResult {
    pub status: TestStatus,
    pub verdict: String,
    pub plain_summary: String,
    pub reasons: Vec<String>,
    pub idle_avg_watts: f64,
    pub load_avg_watts: f64,
    pub power_cv_pct: f64,
    pub voltage_sag_mv: f64,
    pub soc_start_pct: f64,
    pub soc_end_pct: f64,
    pub max_step_drop_pct: f64,
    pub wear_pct: f64,
    pub cycle_count: u32,
    pub bms_drift_ratio: f64,
    pub duration_secs: f64,
    pub samples: Vec<BatteryLiveSample>,
}

// ============================================================================
// Network Reliability Diagnostic Contract
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct NetworkDiagnosticsReport {
    pub status: TestStatus,
    pub interface_name: String,
    pub link_speed_mbps: Option<f64>,
    pub wifi_ssid: Option<String>,
    pub wifi_signal_pct: Option<u32>,
    pub rssi_dbm: Option<i32>,
    pub gateway_ping_ms: Option<f64>,
    pub dns_resolve_ok: bool,
    pub packet_loss_pct: f64,
    pub verdict: String,
    pub plain_summary: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gpu_thermal_cutoff_max_bound() {
        assert!(GPU_THERMAL_CUTOFF_MAX_C <= 92.0);
        assert!(GPU_THERMAL_CUTOFF_DEFAULT_C <= GPU_THERMAL_CUTOFF_MAX_C);
        assert!(CPU_THERMAL_CUTOFF_DEFAULT_C <= CPU_THERMAL_CUTOFF_MAX_C);
    }

    #[test]
    fn test_v22_json_backward_compat_deserialization() {
        let drive_json = r#"{"deviceId":"0","model":"Samsung 980","status":"pass"}"#;
        let drive: DriveSmartInfo = serde_json::from_str(drive_json).unwrap();
        assert_eq!(drive.model, "Samsung 980");
        assert!(drive.critical_warning_flags.is_empty());
        assert_eq!(drive.percentage_used_raw, None);

        let storage_json = r#"{"status":"pass","preset":"quick","testSizeMb":128,"seqReadMbS":3200.0}"#;
        let storage: StorageBenchResult = serde_json::from_str(storage_json).unwrap();
        assert_eq!(storage.test_size_mb, 128);
        assert_eq!(storage.total_written_mb, 0);
        assert!(storage.userbenchmark_rating.is_none());

        let ram_json = r#"{"status":"pass","preset":"quick","allocatedMb":1024,"errorsFound":0}"#;
        let ram: RamTestResult = serde_json::from_str(ram_json).unwrap();
        assert_eq!(ram.allocated_mb, 1024);
        assert_eq!(ram.os_reserve_mb, 0);
        assert!(!ram.thermal_cutoff_triggered);

        let perf_json = r#"{"status":"pass","preset":"quick","compositeScore":12500,"memoryMark":3400}"#;
        let perf: PerfBenchResult = serde_json::from_str(perf_json).unwrap();
        assert_eq!(perf.composite_score, 12500);
        assert_eq!(perf.memory_uncached_read_gb_s, 0.0);
        assert!(!perf.thermal_cutoff_triggered);

        let empty_gpu: GpuStressResult = serde_json::from_str("{}").unwrap();
        assert_eq!(empty_gpu.artifact_errors, 0);
        let empty_vram: VramTestResult = serde_json::from_str("{}").unwrap();
        assert!(!empty_vram.thermal_cutoff_triggered);
        let empty_pt: PowerTortureResult = serde_json::from_str("{}").unwrap();
        assert_eq!(empty_pt.artifact_errors, 0);
        let empty_bi: BurnInResult = serde_json::from_str("{}").unwrap();
        assert!(!empty_bi.thermal_cutoff_triggered);
    }

    #[test]
    fn test_m23_reliability_structs_backward_compat_deserialization() {
        let legacy_specs_json = r#"{
            "osFamily": "windows",
            "manufacturer": "Lenovo",
            "model": "ThinkPad T14",
            "cpuBrand": "AMD Ryzen 7 PRO 6850U",
            "cpuPhysicalCores": 8,
            "cpuLogicalCores": 16,
            "totalRamGb": 16.0,
            "ramModules": [{"slot": "DIMM 0", "capacityGb": 16.0, "memoryType": "LPDDR5"}],
            "gpus": [{"name": "AMD Radeon 680M"}],
            "disks": [{"model": "SK hynix PC801", "sizeGb": 512.0}],
            "volumes": [{"mount": "C:\\", "totalGb": 475.0}],
            "displays": [{"name": "Internal Panel", "resolution": "1920x1200"}],
            "networkAdapters": [{"name": "Qualcomm Wi-Fi 6E", "kind": "Wi-Fi"}],
            "peripherals": [{"category": "Camera", "name": "Integrated Camera"}]
        }"#;
        let specs: SystemSpecs = serde_json::from_str(legacy_specs_json).unwrap();
        assert_eq!(specs.manufacturer, "Lenovo");
        assert!(specs.ram_reliability_note.is_none());
        assert!(specs.reliability_notes.is_empty());
        assert_eq!(specs.plain_summary, "");

        let empty_specs: SystemSpecs = serde_json::from_str("{}").unwrap();
        assert_eq!(empty_specs.cpu_physical_cores, 0);

        let legacy_usb_json = r#"{"instanceId":"USB\\VID_1234","name":"SanDisk Extreme","speedClass":"USB 3.0","isSuperspeed":true,"status":"OK"}"#;
        let usb: UsbDeviceInfo = serde_json::from_str(legacy_usb_json).unwrap();
        assert_eq!(usb.name, "SanDisk Extreme");
        assert_eq!(usb.negotiated_mbps, None);
        assert_eq!(usb.controller_type, "");
        assert_eq!(usb.error_code, None);
        assert_eq!(usb.reliability_note, "");

        let legacy_err_json = r#"{"status":"pass","daysScanned":30,"summary":"Clean"}"#;
        let err: ErrorLogsReport = serde_json::from_str(legacy_err_json).unwrap();
        assert_eq!(err.thermal_event_count, 0);
        assert_eq!(err.plain_summary, "");
        assert!(err.buyer_interpretation.is_empty());

        let legacy_sec_json = r#"{"overallStatus":"pass","platform":"Windows","items":[{"id":"mdm","label":"MDM","value":"Clean","status":"pass","detail":"OK"}],"summary":"Clean"}"#;
        let sec: SecurityAuditReport = serde_json::from_str(legacy_sec_json).unwrap();
        assert_eq!(sec.items.len(), 1);
        assert_eq!(sec.items[0].buyer_note, "");
        assert_eq!(sec.plain_summary, "");
        assert!(sec.ownership_risks.is_empty());

        let _: BatteryDischargeProgress = serde_json::from_str("{}").unwrap();
        let _: BatteryDischargeResult = serde_json::from_str("{}").unwrap();
        let _: NetworkDiagnosticsReport = serde_json::from_str("{}").unwrap();
        let _: TouchscreenTestResult = serde_json::from_str("{}").unwrap();
    }

    #[test]
    fn test_export_report_payload_legacy_and_v230_roundtrip() {
        // Legacy v2.1/v2.2 payload omitting all 5 v2.3.0 fields must deserialize cleanly
        let legacy_json = r#"{
            "shopProfile": {
                "shopName": "Legacy Lab",
                "technicianName": "Tech",
                "logoDataUrl": null,
                "defaultOutputDir": null
            },
            "customerOrSku": "SKU-LEGACY-01",
            "technicianNotes": "Unit inspected cleanly",
            "overallVerdict": "PASSED",
            "durabilityGrade": "A",
            "subsystemScores": [],
            "specs": null,
            "tests": [],
            "signoff": {
                "portsChecked": true,
                "portsNotes": "OK",
                "speakersChecked": true,
                "speakersNotes": "OK"
            },
            "outputDir": null
        }"#;
        let legacy: ExportReportPayload = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy.overall_verdict, "PASSED");
        assert!(legacy.plain_verdict_summary.is_none());
        assert!(legacy.user_benchmark.is_none());
        assert!(legacy.battery_discharge.is_none());
        assert!(legacy.touchscreen.is_none());
        assert!(legacy.network_report.is_none());

        // Full v2.3.0 payload must serialize exact camelCase keys and round-trip cleanly
        let full = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss QC Lab".into(),
                technician_name: "Hein Htet Zaw".into(),
                logo_data_url: None,
                default_output_dir: None,
            },
            customer_or_sku: "SKU-230-PRO".into(),
            technician_notes: "Verified v2.3.0".into(),
            overall_verdict: "PASSED".into(),
            durability_grade: Some("A+".into()),
            plain_verdict_summary: Some("All 14 stages passed cleanly.".into()),
            user_benchmark: Some(UserBenchmarkComparison {
                gaming_pct: 92.4,
                desktop_pct: 98.1,
                workstation_pct: 89.5,
                overall_vehicle_tier: "Nuclear Submarine".into(),
                headline_summary: "High-end laptop performing as expected.".into(),
                source_mode: "offline_calibrated".into(),
                ..Default::default()
            }),
            battery_discharge: Some(BatteryDischargeResult {
                status: TestStatus::Pass,
                verdict: "NORMAL".into(),
                plain_summary: "Stable discharge curve.".into(),
                idle_avg_watts: 6.4,
                load_avg_watts: 24.8,
                power_cv_pct: 7.2,
                voltage_sag_mv: 210.0,
                soc_start_pct: 82.0,
                soc_end_pct: 80.5,
                max_step_drop_pct: 1.0,
                wear_pct: 8.5,
                cycle_count: 42,
                bms_drift_ratio: 1.04,
                duration_secs: 55.0,
                ..Default::default()
            }),
            touchscreen: Some(TouchscreenTestResult {
                touch_capable: true,
                max_touch_points_reported: 10,
                grid_rows: 10,
                grid_cols: 16,
                covered_cells: 160,
                total_cells: 160,
                coverage_pct: 100.0,
                max_simultaneous_touches: 10,
                swipe_linearity_rms_px: 1.4,
                max_linearity_error_px: Some(3.2),
                polling_hz: 120.0,
                tap_latency_ms: Some(9.5),
                status: TestStatus::Pass,
                verdict: "PASS".into(),
                plain_summary: "All 160 grid cells and 10-point multitouch verified.".into(),
            }),
            network_report: Some(NetworkDiagnosticsReport {
                status: TestStatus::Pass,
                interface_name: "Wi-Fi 6E".into(),
                link_speed_mbps: Some(1200.0),
                wifi_ssid: Some("LabBench_5G".into()),
                wifi_signal_pct: Some(94),
                rssi_dbm: Some(-48),
                gateway_ping_ms: Some(2.1),
                dns_resolve_ok: true,
                packet_loss_pct: 0.0,
                verdict: "HEALTHY".into(),
                plain_summary: "Fast Wi-Fi link with zero packet loss.".into(),
            }),
            ..Default::default()
        };

        let json_str = serde_json::to_string(&full).unwrap();
        assert!(json_str.contains("\"userBenchmark\""));
        assert!(json_str.contains("\"batteryDischarge\""));
        assert!(json_str.contains("\"touchscreen\""));
        assert!(json_str.contains("\"networkReport\""));
        assert!(json_str.contains("\"plainVerdictSummary\""));

        let decoded: ExportReportPayload = serde_json::from_str(&json_str).unwrap();
        assert_eq!(decoded.user_benchmark.as_ref().unwrap().overall_vehicle_tier, "Nuclear Submarine");
        assert_eq!(decoded.battery_discharge.as_ref().unwrap().verdict, "NORMAL");
        assert_eq!(decoded.touchscreen.as_ref().unwrap().covered_cells, 160);
        assert_eq!(decoded.network_report.as_ref().unwrap().verdict, "HEALTHY");
        assert_eq!(decoded.plain_verdict_summary.as_deref(), Some("All 14 stages passed cleanly."));

        // Alias compatibility check
        let alias_json = r#"{
            "shopProfile": {"shopName": "A", "technicianName": "B", "logoDataUrl": null, "defaultOutputDir": null},
            "customerOrSku": "",
            "technicianNotes": "",
            "overallVerdict": "PASSED",
            "tests": [],
            "signoff": {"portsChecked": true, "portsNotes": "", "speakersChecked": true, "speakersNotes": ""},
            "userbenchmarkComparison": {"overallVehicleTier": "UFO"},
            "batteryDischargeResult": {"verdict": "ABNORMAL"},
            "touchscreenResult": {"verdict": "SKIPPED"},
            "networkDiagnostics": {"verdict": "HEALTHY"}
        }"#;
        let aliased: ExportReportPayload = serde_json::from_str(alias_json).unwrap();
        assert_eq!(aliased.user_benchmark.unwrap().overall_vehicle_tier, "UFO");
        assert_eq!(aliased.battery_discharge.unwrap().verdict, "ABNORMAL");
        assert_eq!(aliased.touchscreen.unwrap().verdict, "SKIPPED");
        assert_eq!(aliased.network_report.unwrap().verdict, "HEALTHY");
    }
}
