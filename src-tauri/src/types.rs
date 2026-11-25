use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TestStatus {
    Pending,
    Running,
    Pass,
    Warn,
    Fail,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RamModuleInfo {
    pub slot: String,
    pub capacity_gb: f64,
    pub speed_mhz: Option<u32>,
    pub memory_type: String,
    pub manufacturer: String,
    pub part_number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSpecInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
    pub driver_version: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySpecInfo {
    pub name: String,
    pub resolution: String,
    pub refresh_rate_hz: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpecs {
    pub os_family: String,
    pub os_name: String,
    pub os_version: String,
    pub architecture: String,
    pub hostname: String,
    pub manufacturer: String,
    pub model: String,
    pub serial_number: String,
    pub bios_version: String,
    pub cpu_brand: String,
    pub cpu_physical_cores: usize,
    pub cpu_logical_cores: usize,
    pub cpu_base_mhz: u64,
    pub total_ram_gb: f64,
    pub ram_modules: Vec<RamModuleInfo>,
    pub gpus: Vec<GpuSpecInfo>,
    pub disks: Vec<DiskSpecInfo>,
    pub displays: Vec<DisplaySpecInfo>,
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
    pub seq_write_mb_s: f64,
    pub seq_read_mb_s: f64,
    pub rand_4k_write_mb_s: f64,
    pub rand_4k_read_mb_s: f64,
    pub rand_4k_write_iops: u64,
    pub rand_4k_read_iops: u64,
    pub elapsed_secs: f64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBenchProgress {
    pub phase: String,
    pub percent: f64,
    pub current_mb_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RamTestProgress {
    pub running: bool,
    pub pattern_name: String,
    pub cycle: u32,
    pub total_cycles: u32,
    pub percent: f64,
    pub allocated_mb: u64,
    pub bandwidth_gb_s: f64,
    pub errors_found: u64,
    pub elapsed_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RamTestResult {
    pub status: TestStatus,
    pub preset: String,
    pub allocated_mb: u64,
    pub total_ram_mb: u64,
    pub cycles_completed: u32,
    pub patterns_tested: Vec<String>,
    pub errors_found: u64,
    pub peak_bandwidth_gb_s: f64,
    pub elapsed_secs: f64,
    pub cancelled: bool,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricSensorInfo {
    pub kind: String, // "Fingerprint" | "Face ID / IR Camera" | "Touch ID"
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
    pub outcome: String, // "Verified" | "NotEnrolled" | "NotPresent" | "Canceled" | "Error"
    pub status: TestStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfBenchProgress {
    pub phase: String,
    pub percent: f64,
    pub cpu_usage_pct: f32,
    pub cpu_temp_c: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfBenchResult {
    pub status: TestStatus,
    pub preset: String,
    pub single_core_score: u64,
    pub multi_core_score: u64,
    pub crypto_score: u64,
    pub matrix_score: u64,
    pub memory_bandwidth_gb_s: f64,
    pub composite_score: u64,
    pub tier: String,
    pub peak_cpu_temp_c: Option<f32>,
    pub elapsed_secs: f64,
    pub cancelled: bool,
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
    pub frames_rendered: u64,
    pub peak_temp_c: Option<f32>,
    pub peak_power_w: Option<f32>,
    pub thermal_cutoff_triggered: bool,
    pub elapsed_secs: f64,
    pub cancelled: bool,
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
pub struct ExportReportPayload {
    pub shop_profile: ShopProfile,
    pub customer_or_sku: String,
    pub technician_notes: String,
    pub overall_verdict: String, // "PASSED" | "PASSED WITH WARNINGS" | "FAILED" | "INCOMPLETE"
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
