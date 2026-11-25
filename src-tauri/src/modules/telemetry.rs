use crate::modules::battery;
use crate::types::LiveTelemetrySnapshot;
use sysinfo::{Components, System};

/// Zero-driver native hardware telemetry collector with automatic HWiNFO/LibreHardwareMonitor
/// WMI bridge detection on Windows and native IOKit/SMC sensor reading on macOS.
pub struct TelemetryReader {
    sys: System,
    components: Components,
    lhm_available: Option<bool>,
}

impl TelemetryReader {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let components = Components::new_with_refreshed_list();
        Self {
            sys,
            components,
            lhm_available: None,
        }
    }

    pub fn sample(&mut self, include_battery: bool) -> LiveTelemetrySnapshot {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_cpu_frequency();
        self.components.refresh(true);

        let cpu_usage_pct = (self.sys.global_cpu_usage() * 10.0).round() / 10.0;
        let cpu_clock_mhz = self.sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);

        let mut cpu_temp_c: Option<f32> = None;
        let mut gpu_temp_c: Option<f32> = None;
        let mut gpu_load_pct: Option<f32> = None;
        let mut gpu_power_w: Option<f32> = None;
        let mut fan_rpm: Option<u32> = None;
        let mut cpu_power_w: Option<f32> = None;
        let mut sensor_source = "OS Native".to_string();

        // 1. Cross-platform sysinfo thermal components (great on macOS Apple Silicon/Intel & Linux)
        for comp in self.components.list() {
            let lbl = comp.label().to_lowercase();
            if let Some(t) = comp.temperature() {
                if t > 15.0 && t < 120.0 {
                    if lbl.contains("cpu") || lbl.contains("core") || lbl.contains("package") || lbl.contains("soc") || lbl.contains("tdie") {
                        cpu_temp_c = Some(cpu_temp_c.map_or(t, |p| p.max(t)));
                    } else if lbl.contains("gpu") || lbl.contains("radeon") {
                        gpu_temp_c = Some(gpu_temp_c.map_or(t, |p| p.max(t)));
                    }
                }
            }
        }

        // 2. Windows NVIDIA NVML CLI + Optional LibreHardwareMonitor/OpenHardwareMonitor WMI Auto-Link
        #[cfg(target_os = "windows")]
        {
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

            // Probe LibreHardwareMonitor / OpenHardwareMonitor WMI once (zero-driver auto-link!)
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

        // 3. Optional Battery & AC Wattage sample (catches charger drain during Combined Power Torture!)
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
