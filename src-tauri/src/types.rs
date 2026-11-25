use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TestStatus {
    Pending,
    Running,
    Pass,
    Warn,
    Fail,
    Skipped,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRating {
    pub detected_class: String,
    pub expected_normal: String,
    pub percent_of_normal: f64,
    pub grade: String,
    pub verdict_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSpecInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
    pub driver_version: String,
    pub driver_date: String,
    pub pnp_device_id: String,
    pub is_discrete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpecInfo {
    pub model: String,
    pub interface_type: String,
    pub media_type: String,
    pub size_gb: f64,
    pub serial_number: String,
    pub firmware: String,
    pub partition_style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSpecInfo {
    pub mount: String,
    pub label: String,
    pub file_system: String,
    pub total_gb: f64,
    pub free_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySpecInfo {
    pub name: String,
    pub manufacturer: String,
    pub resolution: String,
    pub refresh_rate_hz: Option<u32>,
    pub diagonal_inches: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAdapterInfo {
    pub name: String,
    pub kind: String, // "Wi-Fi" | "Ethernet" | "Bluetooth" | "Other"
    pub mac_address: String,
    pub link_speed: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeripheralDeviceInfo {
    pub category: String, // "Audio" | "Camera" | "USB / Thunderbolt" | "Bluetooth" | "Input"
    pub name: String,
    pub manufacturer: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub is_gaming_capable: bool,
    pub is_elevated: bool,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityCheckItem {
    pub id: String,
    pub label: String,
    pub value: String,
    pub status: TestStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAuditReport {
    pub overall_status: TestStatus,
    pub platform: String,
    pub mdm_enrolled: Option<bool>,
    pub activation_locked: Option<bool>,
    pub items: Vec<SecurityCheckItem>,
    pub summary: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceInfo {
    pub instance_id: String,
    pub name: String,
    pub speed_class: String,
    pub is_superspeed: bool,
    pub status: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorLogEntry {
    pub timestamp: String,
    pub source: String,
    pub level: String,
    pub event_id: Option<u32>,
    pub category: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSmartReport {
    pub status: TestStatus,
    pub drives: Vec<DriveSmartInfo>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBenchProgress {
    pub phase: String,
    pub percent: f64,
    pub current_mb_s: f64,
    pub elapsed_secs: f64,
    pub integrity_errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
