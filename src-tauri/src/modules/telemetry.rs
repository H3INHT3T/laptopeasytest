use crate::modules::battery;
use crate::types::LiveTelemetrySnapshot;
use std::time::Instant;
use sysinfo::{Components, System};

/// Zero-driver native hardware telemetry collector (v2.2):
/// - Real Windows Turbo Boost MHz via PDH `% Processor Performance` * MaxClockSpeed
/// - Zero-driver Windows CPU Temperature via `MSAcpi_ThermalZoneTemperature` & `ThermalZoneInformation`
/// - Automatic HWiNFO / LibreHardwareMonitor / OpenHardwareMonitor WMI bridge
/// - NVIDIA NVML (`nvidia-smi`) GPU temp/load/wattage
/// - Native macOS IOKit/SMC sensors via `sysinfo`
pub struct TelemetryReader {
    sys: System,
    components: Components,
    lhm_available: Option<bool>,
    #[cfg(target_os = "windows")]
    cached_max_clock_mhz: u64,
    #[cfg(target_os = "windows")]
    last_wmi_probe: Option<Instant>,
    #[cfg(target_os = "windows")]
    cached_wmi_temp: Option<f32>,
    #[cfg(target_os = "windows")]
    cached_wmi_turbo_mhz: Option<u64>,
    #[cfg(target_os = "windows")]
    cached_wmi_source: Option<String>,
}

impl TelemetryReader {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let components = Components::new_with_refreshed_list();
        #[cfg(target_os = "windows")]
        let cached_max_clock_mhz = sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);
        Self {
            sys,
            components,
            lhm_available: None,
            #[cfg(target_os = "windows")]
            cached_max_clock_mhz,
            #[cfg(target_os = "windows")]
            last_wmi_probe: None,
            #[cfg(target_os = "windows")]
            cached_wmi_temp: None,
            #[cfg(target_os = "windows")]
            cached_wmi_turbo_mhz: None,
            #[cfg(target_os = "windows")]
            cached_wmi_source: None,
        }
    }

    pub fn sample(&mut self, include_battery: bool) -> LiveTelemetrySnapshot {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_cpu_frequency();
        self.components.refresh(true);

        let cpu_usage_pct = (self.sys.global_cpu_usage() * 10.0).round() / 10.0;
        let mut cpu_clock_mhz = self.sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);

        let mut cpu_temp_c: Option<f32> = None;
        let mut gpu_temp_c: Option<f32> = None;
        let mut gpu_load_pct: Option<f32> = None;
        let mut gpu_power_w: Option<f32> = None;
        let mut fan_rpm: Option<u32> = None;
        let mut cpu_power_w: Option<f32> = None;
        let mut sensor_source = "OS Native".to_string();

        // 1. Cross-platform sysinfo thermal components (macOS Apple Silicon/Intel & Linux)
        for comp in self.components.list() {
            let lbl = comp.label().to_lowercase();
            if let Some(t) = comp.temperature() {
                if t > 15.0 && t < 120.0 {
                    if lbl.contains("cpu")
                        || lbl.contains("core")
                        || lbl.contains("package")
                        || lbl.contains("soc")
                        || lbl.contains("tdie")
                    {
                        cpu_temp_c = Some(cpu_temp_c.map_or(t, |p| p.max(t)));
                    } else if lbl.contains("gpu") || lbl.contains("radeon") {
                        gpu_temp_c = Some(gpu_temp_c.map_or(t, |p| p.max(t)));
                    }
                }
            }
        }

        // 2. Windows Native Turbo Clock (PDH) + ACPI Thermal Zone + NVML + Optional LHM/OHM Bridge
        #[cfg(target_os = "windows")]
        {
            let should_probe_wmi = self
                .last_wmi_probe
                .map(|t| t.elapsed().as_secs_f64() >= 2.2)
                .unwrap_or(true);

            if should_probe_wmi {
                self.last_wmi_probe = Some(Instant::now());
                if let Some((turbo_mhz, acpi_temp, base_max)) =
                    read_windows_native_perf_and_thermal(self.cached_max_clock_mhz)
                {
                    if base_max > 0 {
                        self.cached_max_clock_mhz = base_max;
                    }
                    self.cached_wmi_turbo_mhz = turbo_mhz;
                    if acpi_temp.is_some() {
                        self.cached_wmi_temp = acpi_temp;
                        self.cached_wmi_source = Some("Windows ACPI + PDH".to_string());
                    } else if turbo_mhz.is_some() {
                        self.cached_wmi_source = Some("Windows PDH Turbo".to_string());
                    }
                }
            }

            if let Some(tmhz) = self.cached_wmi_turbo_mhz {
                if tmhz >= 400 {
                    cpu_clock_mhz = tmhz;
                }
            }
            if cpu_temp_c.is_none() {
                cpu_temp_c = self.cached_wmi_temp;
            }
            if let Some(ref src) = self.cached_wmi_source {
                sensor_source = src.clone();
            }

            // NVIDIA NVML CLI for discrete NVIDIA GPUs
            if let Ok(out) = crate::cmd_util::run_cmd_stdout(
                "nvidia-smi",
                &[
                    "--query-gpu=temperature.gpu,utilization.gpu,power.draw",
                    "--format=csv,noheader,nounits",
                ],
            ) {
                if let Some(line) = out.lines().next() {
                    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                    if parts.len() >= 3 {
                        if let Ok(t) = parts[0].parse::<f32>() {
                            gpu_temp_c = Some(t);
                            sensor_source = "Native + NVML".to_string();
                        }
                        gpu_load_pct = parts[1].parse::<f32>().ok();
                        gpu_power_w = parts[2].parse::<f32>().ok();
                    }
                }
            }

            // Optional LibreHardwareMonitor / OpenHardwareMonitor WMI auto-link
            if self.lhm_available != Some(false) {
                if let Some((ct, cp, fr, gt)) = read_lhm_wmi_sensors() {
                    self.lhm_available = Some(true);
                    sensor_source = "Native + LHM/OHM Bridge".to_string();
                    if ct.is_some() {
                        cpu_temp_c = ct;
                    }
                    if cp.is_some() {
                        cpu_power_w = cp;
                    }
                    if fr.is_some() {
                        fan_rpm = fr;
                    }
                    if gpu_temp_c.is_none() && gt.is_some() {
                        gpu_temp_c = gt;
                    }
                } else {
                    self.lhm_available = Some(false);
                }
            }
        }

        // 3. Optional Battery & AC Wattage sample
        let (ac_plugged, battery_percent, battery_watts) = if include_battery {
            if let Some(b) = battery::sample_battery_live() {
                (Some(b.ac_plugged), Some(b.charge_percent), b.watts)
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        };

        LiveTelemetrySnapshot {
            cpu_usage_pct,
            cpu_clock_mhz,
            cpu_temp_c: cpu_temp_c.map(|t| (t * 10.0).round() / 10.0),
            cpu_power_w: cpu_power_w.map(|w| (w * 10.0).round() / 10.0),
            gpu_temp_c: gpu_temp_c.map(|t| (t * 10.0).round() / 10.0),
            gpu_load_pct,
            gpu_power_w: gpu_power_w.map(|w| (w * 10.0).round() / 10.0),
            fan_rpm,
            ac_plugged,
            battery_percent,
            battery_watts,
            sensor_source,
        }
    }
}

#[cfg(target_os = "windows")]
fn read_windows_native_perf_and_thermal(cached_base_mhz: u64) -> Option<(Option<u64>, Option<f32>, u64)> {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = format!(
        r#"
$base = {base}
if ($base -le 0) {{
    $proc = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.MaxClockSpeed -gt 0) {{ $base = [uint64]$proc.MaxClockSpeed }}
}}
$perf = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" -ErrorAction SilentlyContinue | Select-Object -First 1
$turbo = $null
if ($perf -and $base -gt 0 -and $perf.PercentProcessorPerformance -gt 0) {{
    $turbo = [uint64][math]::Round($base * ([double]$perf.PercentProcessorPerformance / 100.0))
}}
$tempC = $null
$tz1 = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Where-Object {{ $_.Temperature -gt 285 -and $_.Temperature -lt 395 }} | Sort-Object Temperature -Descending | Select-Object -First 1
if ($tz1) {{
    $tempC = [math]::Round(([double]$tz1.Temperature - 273.15), 1)
}}
if ($null -eq $tempC) {{
    $tz2 = Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Where-Object {{ $_.CurrentTemperature -gt 2850 -and $_.CurrentTemperature -lt 3950 }} | Sort-Object CurrentTemperature -Descending | Select-Object -First 1
    if ($tz2) {{
        $tempC = [math]::Round((([double]$tz2.CurrentTemperature - 2732.0) / 10.0), 1)
    }}
}}
@{{ turbo = $turbo; tempC = $tempC; base = $base }} | ConvertTo-Json -Compress
"#,
        base = cached_base_mhz
    );

    let raw = run_powershell(&ps).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let turbo = v["turbo"].as_u64().filter(|&m| m >= 400 && m <= 8000);
    let temp = v["tempC"]
        .as_f64()
        .map(|t| t as f32)
        .filter(|&t| t > 15.0 && t < 120.0);
    let base = v["base"].as_u64().unwrap_or(cached_base_mhz);
    Some((turbo, temp, base))
}

#[cfg(target_os = "windows")]
fn read_lhm_wmi_sensors() -> Option<(Option<f32>, Option<f32>, Option<u32>, Option<f32>)> {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$ns = $null
foreach ($cand in @('root\LibreHardwareMonitor','root\OpenHardwareMonitor')) {
    if (Get-CimInstance -Namespace $cand -ClassName Sensor -ErrorAction SilentlyContinue | Select-Object -First 1) {
        $ns = $cand; break
    }
}
if (-not $ns) { exit 1 }
$sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue
$ct = ($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU Package|Core Max|Tctl|Tdie' } | Select-Object -First 1).Value
$cp = ($sensors | Where-Object { $_.SensorType -eq 'Power' -and $_.Name -match 'CPU Package' } | Select-Object -First 1).Value
$fr = ($sensors | Where-Object { $_.SensorType -eq 'Fan' -and $_.Value -gt 0 } | Select-Object -First 1).Value
$gt = ($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'GPU Core|GPU Hot' } | Select-Object -First 1).Value
@{ ct = $ct; cp = $cp; fr = $fr; gt = $gt } | ConvertTo-Json -Compress
"#;

    let raw = run_powershell(ps).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ct = v["ct"].as_f64().map(|x| x as f32).filter(|&x| x > 10.0 && x < 125.0);
    let cp = v["cp"].as_f64().map(|x| x as f32).filter(|&x| x >= 0.0 && x < 350.0);
    let fr = v["fr"].as_f64().map(|x| x.round() as u32).filter(|&x| x > 0 && x < 15000);
    let gt = v["gt"].as_f64().map(|x| x as f32).filter(|&x| x > 10.0 && x < 125.0);
    Some((ct, cp, fr, gt))
}
