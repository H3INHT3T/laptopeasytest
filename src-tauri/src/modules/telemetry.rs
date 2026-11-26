#[cfg(not(target_os = "windows"))]
use crate::modules::battery;
use crate::types::{BatteryLiveSample, LiveTelemetrySnapshot};
use std::time::{Duration, Instant};
use sysinfo::{Components, System};

/// Result of evaluating a `LiveTelemetrySnapshot` against thermal safety cutoffs.
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub enum ThermalSafetyCheck {
    Safe,
    CutoffTriggered {
        sensor: &'static str,
        temp_c: f32,
    },
    SensorUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ClassifiedComponentTemp {
    Cpu(f32),
    Gpu(f32),
    Ignore,
}

/// Converts Kelvin (e.g. `Win32_PerfFormattedData_Counters_ThermalZoneInformation.Temperature`)
/// to Celsius, rejecting non-finite or physically implausible readings outside `15°C..120°C`.
#[allow(dead_code)]
pub(crate) fn kelvin_to_celsius(k: f64) -> Option<f32> {
    if !k.is_finite() {
        return None;
    }
    let c = k - 273.15;
    if c > 15.0 && c < 120.0 {
        Some(((c * 10.0).round() / 10.0) as f32)
    } else {
        None
    }
}

/// Converts tenths of Kelvin (e.g. `MSAcpi_ThermalZoneTemperature.CurrentTemperature`,
/// PDH `High Precision Temperature`) to Celsius within `15°C..120°C`.
#[allow(dead_code)]
pub(crate) fn tenths_kelvin_to_celsius(tk: f64) -> Option<f32> {
    if !tk.is_finite() {
        return None;
    }
    kelvin_to_celsius(tk / 10.0)
}

/// Parses a `nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,power.draw --format=csv,noheader,nounits`
/// output line into `(gpu_temp_c, gpu_load_pct, gpu_power_w)`.
#[allow(dead_code)]
pub(crate) fn parse_nvidia_smi_csv(stdout: &str) -> Option<(Option<f32>, Option<f32>, Option<f32>)> {
    let line = stdout.lines().find(|l| !l.trim().is_empty())?;
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 3 {
        return None;
    }
    let temp = parts[0]
        .parse::<f32>()
        .ok()
        .filter(|t| t.is_finite() && *t > 10.0 && *t < 125.0);
    let load = parts[1]
        .parse::<f32>()
        .ok()
        .filter(|u| u.is_finite() && *u >= 0.0 && *u <= 100.0);
    let power = parts[2]
        .parse::<f32>()
        .ok()
        .filter(|w| w.is_finite() && *w >= 0.0 && *w <= 600.0);
    if temp.is_none() && load.is_none() && power.is_none() {
        None
    } else {
        Some((temp, load, power))
    }
}

/// Classifies a `sysinfo::Components` sensor label into CPU, GPU, or Ignore.
/// Covers Apple Silicon (`pACC`, `eACC`, `PMU tdie`, `SOC MTR`, `GPU MTR`) alongside
/// Intel (`Package id 0`, `Core`), AMD (`Tctl/Tdie`), and Radeon sensors.
pub(crate) fn classify_sysinfo_component_temp(label: &str, temp_c: f32) -> ClassifiedComponentTemp {
    if !temp_c.is_finite() || temp_c <= 15.0 || temp_c >= 120.0 {
        return ClassifiedComponentTemp::Ignore;
    }
    let lbl = label.to_lowercase();
    if lbl.contains("cpu")
        || lbl.contains("core")
        || lbl.contains("package")
        || lbl.contains("soc")
        || lbl.contains("tdie")
        || lbl.contains("tctl")
        || lbl.contains("pacc")
        || lbl.contains("eacc")
    {
        ClassifiedComponentTemp::Cpu(temp_c)
    } else if lbl.contains("gpu") || lbl.contains("radeon") {
        ClassifiedComponentTemp::Gpu(temp_c)
    } else {
        ClassifiedComponentTemp::Ignore
    }
}

/// Computes `(cpu_temp_available, gpu_temp_available, power_watts_available, temp_source)`.
pub(crate) fn compute_sensor_availability(
    cpu_temp: Option<f32>,
    gpu_temp: Option<f32>,
    cpu_power: Option<f32>,
    gpu_power: Option<f32>,
    bat_watts: Option<f64>,
    raw_temp_source: &str,
) -> (bool, bool, bool, String) {
    let cpu_temp_available = cpu_temp.is_some();
    let gpu_temp_available = gpu_temp.is_some();
    let power_watts_available = cpu_power.is_some() || gpu_power.is_some() || bat_watts.is_some();
    let temp_source = if !cpu_temp_available && !gpu_temp_available {
        "Unavailable".to_string()
    } else if !raw_temp_source.trim().is_empty() {
        raw_temp_source.trim().to_string()
    } else if gpu_temp_available && !cpu_temp_available {
        "NVML (GPU only)".to_string()
    } else {
        "OS Native".to_string()
    };
    (
        cpu_temp_available,
        gpu_temp_available,
        power_watts_available,
        temp_source,
    )
}

/// Computes effective Turbo Boost frequency (MHz) from base clock and PDH `% Processor Performance`.
#[allow(dead_code)]
pub(crate) fn compute_turbo_mhz(base_mhz: u64, perf_pct: f64) -> Option<u64> {
    if base_mhz == 0 || !perf_pct.is_finite() || perf_pct <= 0.0 || perf_pct > 500.0 {
        return None;
    }
    let mhz = ((base_mhz as f64) * (perf_pct / 100.0)).round();
    if !mhz.is_finite() {
        return None;
    }
    let val = mhz as u64;
    if (400..=8000).contains(&val) {
        Some(val)
    } else {
        None
    }
}

/// Normalizes Windows `\Power Meter(*)\Power` readings (which drivers report in mW or W) into Watts.
#[allow(dead_code)]
pub(crate) fn normalize_power_meter_watts(raw: f64) -> Option<f32> {
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let watts = if raw >= 400.0 && raw <= 400_000.0 {
        raw / 1000.0
    } else if raw >= 0.5 && raw < 400.0 {
        raw
    } else {
        return None;
    };
    if (0.5..=350.0).contains(&watts) {
        Some(((watts * 10.0).round() / 10.0) as f32)
    } else {
        None
    }
}

/// Zero-driver native hardware telemetry collector (v2.3):
/// - Windows fast in-process PDH (`pdh.dll` English counters) + Registry base MHz (`advapi32.dll`)
/// - Windows direct in-process NVIDIA NVML (`nvml.dll`) with one-time `nvidia-smi` probe fallback
/// - Windows fast in-process AC/Battery (`kernel32.dll` + `powrprof.dll`) with throttled WMI fallback
/// - Throttled LHM/OHM & ACPI thermal zone fallbacks (never spawning PowerShell on `< 1s` ticks)
/// - Native macOS IOKit/SMC sensors via `sysinfo` + throttled `ioreg` battery telemetry
pub struct TelemetryReader {
    sys: System,
    components: Components,
    last_snapshot: Option<(Instant, bool, LiveTelemetrySnapshot)>,
    last_battery_probe: Option<Instant>,
    cached_battery: Option<BatteryLiveSample>,
    #[cfg(target_os = "windows")]
    lhm_available: Option<bool>,
    #[cfg(target_os = "windows")]
    cached_max_clock_mhz: u64,
    #[cfg(target_os = "windows")]
    pdh_sampler: Option<windows_native::PdhSampler>,
}

impl Default for TelemetryReader {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryReader {
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        let pdh_sampler = windows_native::PdhSampler::new();

        let mut sys = System::new_all();
        sys.refresh_all();
        let components = Components::new_with_refreshed_list();

        #[cfg(target_os = "windows")]
        let cached_max_clock_mhz = {
            let sys_mhz = sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);
            windows_native::cached_registry_base_mhz(sys_mhz)
        };

        Self {
            sys,
            components,
            last_snapshot: None,
            last_battery_probe: None,
            cached_battery: None,
            #[cfg(target_os = "windows")]
            lhm_available: None,
            #[cfg(target_os = "windows")]
            cached_max_clock_mhz,
            #[cfg(target_os = "windows")]
            pdh_sampler,
        }
    }

    /// Samples hardware telemetry, returning a cached snapshot if called again within `min_interval`
    /// with compatible `include_battery` requirements.
    #[allow(dead_code)]
    pub fn sample_throttled(
        &mut self,
        include_battery: bool,
        min_interval: Duration,
    ) -> LiveTelemetrySnapshot {
        if min_interval > Duration::ZERO {
            if let Some((ts, prev_bat, ref snap)) = self.last_snapshot {
                if ts.elapsed() < min_interval && (!include_battery || prev_bat) {
                    return snap.clone();
                }
            }
        }
        self.sample(include_battery)
    }

    /// Samples only GPU temperature, GPU utilization %, and GPU power (W) for GPU/VRAM stress loops.
    #[allow(dead_code)]
    pub fn sample_gpu_only(&mut self) -> (Option<f32>, Option<f32>, Option<f32>) {
        let mut gpu_temp_c: Option<f32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut gpu_load_pct: Option<f32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut gpu_power_w: Option<f32> = None;

        #[cfg(target_os = "windows")]
        {
            if let Some((gt, gl, gp)) = windows_native::read_nvidia_gpu_telemetry() {
                gpu_temp_c = gt;
                gpu_load_pct = gl;
                gpu_power_w = gp;
            }
            if gpu_load_pct.is_none() {
                if let Some(ref pdh) = self.pdh_sampler {
                    let pdh_read = pdh.sample(self.cached_max_clock_mhz);
                    if pdh_read.gpu_load_pct.is_some() {
                        gpu_load_pct = pdh_read.gpu_load_pct;
                    }
                }
            }
            if gpu_temp_c.is_none() {
                if let Some((_, _, _, lhm_gt)) = windows_native::read_lhm_wmi_sensors_throttled(&mut self.lhm_available) {
                    gpu_temp_c = lhm_gt;
                }
            }
        }

        if gpu_temp_c.is_none() {
            self.components.refresh(true);
            for comp in self.components.list() {
                if let Some(t) = comp.temperature() {
                    if let ClassifiedComponentTemp::Gpu(gt) =
                        classify_sysinfo_component_temp(comp.label(), t)
                    {
                        gpu_temp_c = Some(gpu_temp_c.map_or(gt, |p| p.max(gt)));
                    }
                }
            }
        }

        (
            gpu_temp_c.map(|t| (t * 10.0).round() / 10.0),
            gpu_load_pct.map(|u| (u * 10.0).round() / 10.0),
            gpu_power_w.map(|w| (w * 10.0).round() / 10.0),
        )
    }

    /// Evaluates thermal safety conservatively: distinguishes `Safe`, `CutoffTriggered`, and `SensorUnavailable`.
    #[allow(dead_code)]
    pub fn is_thermal_safe(
        snap: &LiveTelemetrySnapshot,
        cpu_cutoff_c: f32,
        gpu_cutoff_c: f32,
    ) -> ThermalSafetyCheck {
        if let Some(t) = snap.cpu_temp_c {
            if t.is_finite() && cpu_cutoff_c.is_finite() && t >= cpu_cutoff_c {
                return ThermalSafetyCheck::CutoffTriggered {
                    sensor: "CPU",
                    temp_c: t,
                };
            }
        }
        if let Some(t) = snap.gpu_temp_c {
            if t.is_finite() && gpu_cutoff_c.is_finite() && t >= gpu_cutoff_c {
                return ThermalSafetyCheck::CutoffTriggered {
                    sensor: "GPU",
                    temp_c: t,
                };
            }
        }
        let check_cpu = cpu_cutoff_c.is_finite() && cpu_cutoff_c < 200.0;
        let check_gpu = gpu_cutoff_c.is_finite() && gpu_cutoff_c < 200.0;
        if !check_cpu && !check_gpu {
            return ThermalSafetyCheck::SensorUnavailable;
        }
        let cpu_finite = snap.cpu_temp_c.filter(|t| t.is_finite());
        let gpu_finite = snap.gpu_temp_c.filter(|t| t.is_finite());
        let has_relevant_sensor =
            (check_cpu && cpu_finite.is_some()) || (check_gpu && gpu_finite.is_some());
        if has_relevant_sensor {
            ThermalSafetyCheck::Safe
        } else {
            ThermalSafetyCheck::SensorUnavailable
        }
    }

    pub fn sample(&mut self, include_battery: bool) -> LiveTelemetrySnapshot {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_cpu_frequency();
        self.components.refresh(true);

        let cpu_usage_pct = (self.sys.global_cpu_usage() * 10.0).round() / 10.0;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut cpu_clock_mhz = self.sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);

        let mut cpu_temp_c: Option<f32> = None;
        let mut gpu_temp_c: Option<f32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut gpu_load_pct: Option<f32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut gpu_power_w: Option<f32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut fan_rpm: Option<u32> = None;
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut cpu_power_w: Option<f32> = None;
        #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(unused_mut))]
        let mut sensor_source = "OS Native".to_string();
        let mut raw_temp_source = String::new();

        // 1. Cross-platform sysinfo thermal components (macOS Apple Silicon/Intel & Linux)
        for comp in self.components.list() {
            if let Some(t) = comp.temperature() {
                match classify_sysinfo_component_temp(comp.label(), t) {
                    ClassifiedComponentTemp::Cpu(ct) => {
                        cpu_temp_c = Some(cpu_temp_c.map_or(ct, |p| p.max(ct)));
                    }
                    ClassifiedComponentTemp::Gpu(gt) => {
                        gpu_temp_c = Some(gpu_temp_c.map_or(gt, |p| p.max(gt)));
                    }
                    ClassifiedComponentTemp::Ignore => {}
                }
            }
        }
        if cpu_temp_c.is_some() || gpu_temp_c.is_some() {
            #[cfg(target_os = "macos")]
            {
                sensor_source = "SMC/IOKit".to_string();
                raw_temp_source = "SMC/IOKit".to_string();
            }
            #[cfg(not(target_os = "macos"))]
            {
                raw_temp_source = "OS Native".to_string();
            }
        }

        // 2. Windows fast in-process PDH + NVML + throttled LHM/ACPI fallbacks
        #[cfg(target_os = "windows")]
        {
            // Tier A: Fast In-Process Windows PDH
            if let Some(ref pdh) = self.pdh_sampler {
                let pdh_read = pdh.sample(self.cached_max_clock_mhz);
                if let Some(tmhz) = pdh_read.turbo_mhz {
                    cpu_clock_mhz = tmhz;
                    sensor_source = "Windows PDH Turbo".to_string();
                }
                if cpu_temp_c.is_none() {
                    if let Some(pt) = pdh_read.thermal_zone_temp_c {
                        cpu_temp_c = Some(pt);
                        raw_temp_source = "Windows PDH ThermalZone".to_string();
                        sensor_source = "Windows PDH + ThermalZone".to_string();
                    }
                }
                if cpu_power_w.is_none() {
                    cpu_power_w = pdh_read.power_meter_w;
                }
                if gpu_load_pct.is_none() {
                    gpu_load_pct = pdh_read.gpu_load_pct;
                }
            }

            // Tier B: Direct In-Process NVIDIA NVML (or one-time-probed throttled nvidia-smi)
            if let Some((nv_temp, nv_load, nv_power)) = windows_native::read_nvidia_gpu_telemetry()
            {
                if let Some(gt) = nv_temp {
                    gpu_temp_c = Some(gt);
                    sensor_source = "Native + NVML".to_string();
                    if raw_temp_source.is_empty() {
                        raw_temp_source = "NVML (GPU only)".to_string();
                    }
                }
                if nv_load.is_some() {
                    gpu_load_pct = nv_load;
                }
                if nv_power.is_some() {
                    gpu_power_w = nv_power;
                }
            }

            // Tier C1: Throttled LibreHardwareMonitor / OpenHardwareMonitor WMI bridge
            if let Some((ct, cp, fr, gt)) =
                windows_native::read_lhm_wmi_sensors_throttled(&mut self.lhm_available)
            {
                sensor_source = "Native + LHM/OHM Bridge".to_string();
                if let Some(c) = ct {
                    cpu_temp_c = Some(c);
                    raw_temp_source = "LHM/OHM WMI".to_string();
                }
                if cp.is_some() {
                    cpu_power_w = cp;
                }
                if fr.is_some() {
                    fan_rpm = fr;
                }
                if gpu_temp_c.is_none() {
                    if let Some(g) = gt {
                        gpu_temp_c = Some(g);
                        if raw_temp_source.is_empty() {
                            raw_temp_source = "LHM/OHM WMI".to_string();
                        }
                    }
                }
            }

            // Tier C2: Throttled ACPI / WMI ThermalZone fallback ONLY when CPU temp is still None
            if cpu_temp_c.is_none() {
                if let Some(acpi_temp) = windows_native::read_windows_native_acpi_wmi_throttled() {
                    cpu_temp_c = Some(acpi_temp);
                    raw_temp_source = "Windows ACPI ThermalZone".to_string();
                    sensor_source = "Windows ACPI + PDH".to_string();
                }
            }
        }

        // 3. Optional Battery & AC Wattage sample
        let (ac_plugged, battery_percent, battery_watts) = if include_battery {
            self.sample_battery_fast()
        } else {
            (None, None, None)
        };

        let cpu_temp_rounded = cpu_temp_c.map(|t| (t * 10.0).round() / 10.0);
        let cpu_power_rounded = cpu_power_w.map(|w| (w * 10.0).round() / 10.0);
        let gpu_temp_rounded = gpu_temp_c.map(|t| (t * 10.0).round() / 10.0);
        let gpu_load_rounded = gpu_load_pct.map(|u| (u * 10.0).round() / 10.0);
        let gpu_power_rounded = gpu_power_w.map(|w| (w * 10.0).round() / 10.0);

        let (cpu_temp_available, gpu_temp_available, power_watts_available, temp_source) =
            compute_sensor_availability(
                cpu_temp_rounded,
                gpu_temp_rounded,
                cpu_power_rounded,
                gpu_power_rounded,
                battery_watts,
                &raw_temp_source,
            );

        let snap = LiveTelemetrySnapshot {
            cpu_usage_pct,
            cpu_clock_mhz,
            cpu_temp_c: cpu_temp_rounded,
            cpu_power_w: cpu_power_rounded,
            gpu_temp_c: gpu_temp_rounded,
            gpu_load_pct: gpu_load_rounded,
            gpu_power_w: gpu_power_rounded,
            fan_rpm,
            ac_plugged,
            battery_percent,
            battery_watts,
            sensor_source,
            cpu_temp_available,
            gpu_temp_available,
            power_watts_available,
            temp_source,
        };
        self.last_snapshot = Some((Instant::now(), include_battery, snap.clone()));
        snap
    }

    fn sample_battery_fast(&mut self) -> (Option<bool>, Option<f64>, Option<f64>) {
        #[cfg(target_os = "windows")]
        {
            if let Some((ac, present, pct, watts)) = windows_native::read_windows_fast_power() {
                if present == Some(false) {
                    return (ac, None, None);
                }
                if ac.is_some() && pct.is_some() {
                    return (ac, pct, watts);
                }
            }

            // Throttled WMI fallback (>= 5.0s) only if fast native APIs returned incomplete status
            let should_refresh = self
                .last_battery_probe
                .map(|t| t.elapsed() >= Duration::from_secs(5))
                .unwrap_or(true);
            if should_refresh {
                self.last_battery_probe = Some(Instant::now());
                self.cached_battery = windows_native::sample_battery_live_cached();
            }
            if let Some(ref b) = self.cached_battery {
                (Some(b.ac_plugged), Some(b.charge_percent), b.watts)
            } else {
                (None, None, None)
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let should_refresh = self
                .last_battery_probe
                .map(|t| t.elapsed() >= Duration::from_secs(1))
                .unwrap_or(true);
            if should_refresh {
                self.last_battery_probe = Some(Instant::now());
                self.cached_battery = battery::sample_battery_live();
            }
            if let Some(ref b) = self.cached_battery {
                (Some(b.ac_plugged), Some(b.charge_percent), b.watts)
            } else {
                (None, None, None)
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::{
        compute_turbo_mhz, kelvin_to_celsius, normalize_power_meter_watts, parse_nvidia_smi_csv,
        tenths_kelvin_to_celsius,
    };
    use crate::cmd_util::{run_cmd_stdout, run_powershell};
    use crate::modules::battery;
    use crate::types::BatteryLiveSample;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::{size_of, transmute_copy};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HMODULE;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA, LoadLibraryW};

    unsafe fn load_proc<T>(module: HMODULE, symbol_nul: &[u8]) -> Option<T> {
        let fp = GetProcAddress(module, symbol_nul.as_ptr())?;
        Some(transmute_copy(&fp))
    }

    fn to_wide_nul(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // ------------------------------------------------------------------------
    // 1. Registry Base CPU Frequency (advapi32.dll RegGetValueW, OnceLock<u64>)
    // ------------------------------------------------------------------------

    pub(super) fn cached_registry_base_mhz(fallback_mhz: u64) -> u64 {
        static BASE_CPU_MHZ: OnceLock<u64> = OnceLock::new();
        let val = *BASE_CPU_MHZ.get_or_init(|| {
            read_registry_base_mhz()
                .filter(|&m| (400..=7000).contains(&m))
                .unwrap_or(fallback_mhz)
        });
        if val > 0 {
            val
        } else {
            fallback_mhz
        }
    }

    fn read_registry_base_mhz() -> Option<u64> {
        type RegGetValueWFn = unsafe extern "system" fn(
            hkey: isize,
            lp_sub_key: *const u16,
            lp_value: *const u16,
            dw_flags: u32,
            pdw_type: *mut u32,
            pv_data: *mut c_void,
            pcb_data: *mut u32,
        ) -> i32;

        const HKEY_LOCAL_MACHINE: isize = -2147483646_i32 as isize; // 0x80000002
        const RRF_RT_REG_DWORD: u32 = 0x0000_0010;

        unsafe {
            let advapi = LoadLibraryA(b"advapi32.dll\0".as_ptr());
            if advapi.is_null() {
                return None;
            }
            let reg_get_value: RegGetValueWFn = load_proc(advapi, b"RegGetValueW\0")?;
            let subkey = to_wide_nul(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            let val_name = to_wide_nul("~MHz");
            let mut mhz: u32 = 0;
            let mut size: u32 = size_of::<u32>() as u32;
            let rc = reg_get_value(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                val_name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut mhz as *mut u32).cast::<c_void>(),
                &mut size,
            );
            if rc == 0 && mhz > 0 {
                Some(mhz as u64)
            } else {
                None
            }
        }
    }

    // ------------------------------------------------------------------------
    // 2. Fast In-Process Windows PDH (pdh.dll via PdhAddEnglishCounterW)
    // ------------------------------------------------------------------------

    const PDH_ERROR_SUCCESS: u32 = 0;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_FMT_NOCAP100: u32 = 0x0000_8000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct PdhFmtCounterValue {
        c_status: u32,
        double_value: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct PdhFmtCounterValueItemW {
        sz_name: *const u16,
        fmt_value: PdhFmtCounterValue,
    }

    type PdhOpenQueryWFn = unsafe extern "system" fn(*const u16, usize, *mut isize) -> u32;
    type PdhAddEnglishCounterWFn =
        unsafe extern "system" fn(isize, *const u16, usize, *mut isize) -> u32;
    type PdhCollectQueryDataFn = unsafe extern "system" fn(isize) -> u32;
    type PdhGetFormattedCounterValueFn =
        unsafe extern "system" fn(isize, u32, *mut u32, *mut PdhFmtCounterValue) -> u32;
    type PdhGetFormattedCounterArrayWFn =
        unsafe extern "system" fn(isize, u32, *mut u32, *mut u32, *mut u8) -> u32;
    type PdhCloseQueryFn = unsafe extern "system" fn(isize) -> u32;

    #[derive(Clone, Copy)]
    struct PdhDll {
        open_query: PdhOpenQueryWFn,
        add_english_counter: PdhAddEnglishCounterWFn,
        collect_query_data: PdhCollectQueryDataFn,
        get_formatted_value: PdhGetFormattedCounterValueFn,
        get_formatted_array: PdhGetFormattedCounterArrayWFn,
        close_query: PdhCloseQueryFn,
    }

    impl PdhDll {
        fn load() -> Option<Self> {
            unsafe {
                let h = LoadLibraryA(b"pdh.dll\0".as_ptr());
                if h.is_null() {
                    return None;
                }
                Some(Self {
                    open_query: load_proc(h, b"PdhOpenQueryW\0")?,
                    add_english_counter: load_proc(h, b"PdhAddEnglishCounterW\0")?,
                    collect_query_data: load_proc(h, b"PdhCollectQueryData\0")?,
                    get_formatted_value: load_proc(h, b"PdhGetFormattedCounterValue\0")?,
                    get_formatted_array: load_proc(h, b"PdhGetFormattedCounterArrayW\0")?,
                    close_query: load_proc(h, b"PdhCloseQuery\0")?,
                })
            }
        }
    }

    fn pdh_dll() -> Option<&'static PdhDll> {
        static PDH: OnceLock<Option<PdhDll>> = OnceLock::new();
        PDH.get_or_init(PdhDll::load).as_ref()
    }

    pub(super) struct PdhSample {
        pub(super) turbo_mhz: Option<u64>,
        pub(super) thermal_zone_temp_c: Option<f32>,
        pub(super) power_meter_w: Option<f32>,
        pub(super) gpu_load_pct: Option<f32>,
    }

    pub(super) struct PdhSampler {
        dll: PdhDll,
        query: isize,
        perf_counter: Option<isize>,
        actual_freq_counter: Option<isize>,
        tz_hp_counter: Option<isize>,
        tz_temp_counter: Option<isize>,
        power_meter_counter: Option<isize>,
        gpu_engine_counter: Option<isize>,
    }

    impl Drop for PdhSampler {
        fn drop(&mut self) {
            if self.query != 0 {
                unsafe {
                    let _ = (self.dll.close_query)(self.query);
                }
                self.query = 0;
            }
        }
    }

    impl PdhSampler {
        pub(super) fn new() -> Option<Self> {
            let dll = *pdh_dll()?;
            let mut query: isize = 0;
            let rc = unsafe { (dll.open_query)(std::ptr::null(), 0, &mut query) };
            if rc != PDH_ERROR_SUCCESS || query == 0 {
                return None;
            }

            let add = |path: &str| -> Option<isize> {
                let wide = to_wide_nul(path);
                let mut counter: isize = 0;
                let st =
                    unsafe { (dll.add_english_counter)(query, wide.as_ptr(), 0, &mut counter) };
                if st == PDH_ERROR_SUCCESS && counter != 0 {
                    Some(counter)
                } else {
                    None
                }
            };

            let perf_counter = add(r"\Processor Information(_Total)\% Processor Performance");
            let actual_freq_counter = add(r"\Processor Information(_Total)\Actual Frequency");
            let tz_hp_counter = add(r"\Thermal Zone Information(*)\High Precision Temperature");
            let tz_temp_counter = add(r"\Thermal Zone Information(*)\Temperature");
            let power_meter_counter = add(r"\Power Meter(*)\Power");
            let gpu_engine_counter = add(r"\GPU Engine(*)\Utilization Percentage");

            // Prime rate/delta counters once at creation
            unsafe {
                let _ = (dll.collect_query_data)(query);
            }

            Some(Self {
                dll,
                query,
                perf_counter,
                actual_freq_counter,
                tz_hp_counter,
                tz_temp_counter,
                power_meter_counter,
                gpu_engine_counter,
            })
        }

        pub(super) fn sample(&self, base_mhz: u64) -> PdhSample {
            let rc = unsafe { (self.dll.collect_query_data)(self.query) };
            if rc != PDH_ERROR_SUCCESS {
                return PdhSample {
                    turbo_mhz: None,
                    thermal_zone_temp_c: None,
                    power_meter_w: None,
                    gpu_load_pct: None,
                };
            }

            let mut turbo_mhz = self
                .perf_counter
                .and_then(|c| self.read_scalar(c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100))
                .and_then(|pct| compute_turbo_mhz(base_mhz, pct));

            if turbo_mhz.is_none() {
                turbo_mhz = self
                    .actual_freq_counter
                    .and_then(|c| self.read_scalar(c, PDH_FMT_DOUBLE))
                    .and_then(|mhz| {
                        let m = mhz.round() as u64;
                        if (400..=8000).contains(&m) {
                            Some(m)
                        } else {
                            None
                        }
                    });
            }

            let mut thermal_zone_temp_c = self.tz_hp_counter.and_then(|c| {
                self.read_array(c, PDH_FMT_DOUBLE, |_, val| {
                    tenths_kelvin_to_celsius(val).or_else(|| {
                        if val < 500.0 {
                            kelvin_to_celsius(val)
                        } else {
                            None
                        }
                    })
                })
                .into_iter()
                .reduce(f32::max)
            });

            if thermal_zone_temp_c.is_none() {
                thermal_zone_temp_c = self.tz_temp_counter.and_then(|c| {
                    self.read_array(c, PDH_FMT_DOUBLE, |_, val| kelvin_to_celsius(val))
                        .into_iter()
                        .reduce(f32::max)
                });
            }

            let power_meter_w = self.power_meter_counter.and_then(|c| {
                self.read_array(c, PDH_FMT_DOUBLE, |_, val| normalize_power_meter_watts(val))
                    .into_iter()
                    .reduce(f32::max)
            });

            let gpu_load_pct = self.gpu_engine_counter.and_then(|c| {
                let entries = self.read_array(c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, |name, val| {
                    if val.is_finite() && val >= 0.0 && val <= 100.0 {
                        let eng = name
                            .split("engtype_")
                            .nth(1)
                            .unwrap_or("total")
                            .to_string();
                        Some((eng, val))
                    } else {
                        None
                    }
                });
                if entries.is_empty() {
                    return None;
                }
                let mut per_engine: HashMap<String, f64> = HashMap::new();
                for (eng, val) in entries {
                    *per_engine.entry(eng).or_insert(0.0) += val;
                }
                per_engine
                    .values()
                    .copied()
                    .reduce(f64::max)
                    .map(|v| v.clamp(0.0, 100.0) as f32)
            });

            PdhSample {
                turbo_mhz,
                thermal_zone_temp_c,
                power_meter_w,
                gpu_load_pct,
            }
        }

        fn read_scalar(&self, counter: isize, fmt: u32) -> Option<f64> {
            let mut val = PdhFmtCounterValue {
                c_status: 0,
                double_value: 0.0,
            };
            let st = unsafe {
                (self.dll.get_formatted_value)(counter, fmt, std::ptr::null_mut(), &mut val)
            };
            if st == PDH_ERROR_SUCCESS && val.c_status <= 1 && val.double_value.is_finite() {
                Some(val.double_value)
            } else {
                None
            }
        }

        fn read_array<R>(
            &self,
            counter: isize,
            fmt: u32,
            mut map_fn: impl FnMut(&str, f64) -> Option<R>,
        ) -> Vec<R> {
            let mut out = Vec::new();
            let mut buf_size: u32 = 0;
            let mut item_count: u32 = 0;

            let st1 = unsafe {
                (self.dll.get_formatted_array)(
                    counter,
                    fmt,
                    &mut buf_size,
                    &mut item_count,
                    std::ptr::null_mut(),
                )
            };
            if st1 != PDH_MORE_DATA || buf_size == 0 || buf_size > 4 * 1024 * 1024 {
                return out;
            }

            let words = (buf_size as usize + size_of::<PdhFmtCounterValueItemW>() - 1)
                / size_of::<PdhFmtCounterValueItemW>();
            let mut buf: Vec<PdhFmtCounterValueItemW> = vec![
                PdhFmtCounterValueItemW {
                    sz_name: std::ptr::null(),
                    fmt_value: PdhFmtCounterValue {
                        c_status: 0,
                        double_value: 0.0,
                    },
                };
                words.max(1)
            ];

            let st2 = unsafe {
                (self.dll.get_formatted_array)(
                    counter,
                    fmt,
                    &mut buf_size,
                    &mut item_count,
                    buf.as_mut_ptr().cast::<u8>(),
                )
            };
            if st2 != PDH_ERROR_SUCCESS {
                return out;
            }

            let max_items = (buf_size as usize) / size_of::<PdhFmtCounterValueItemW>();
            let count = (item_count as usize).min(max_items).min(buf.len());
            for item in &buf[..count] {
                if item.fmt_value.c_status <= 1 && item.fmt_value.double_value.is_finite() {
                    let name = unsafe { utf16_ptr_to_lower_bounded(item.sz_name, 512) };
                    if let Some(mapped) = map_fn(&name, item.fmt_value.double_value) {
                        out.push(mapped);
                    }
                }
            }
            out
        }
    }

    unsafe fn utf16_ptr_to_lower_bounded(ptr: *const u16, max_chars: usize) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0;
        while len < max_chars && *ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        String::from_utf16_lossy(slice).to_lowercase()
    }

    // ------------------------------------------------------------------------
    // 3. Direct In-Process NVIDIA NVML (nvml.dll) + One-Time nvidia-smi Fallback
    // ------------------------------------------------------------------------

    #[repr(C)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }

    type NvmlInitFn = unsafe extern "system" fn() -> i32;
    type NvmlDeviceGetCountFn = unsafe extern "system" fn(*mut u32) -> i32;
    type NvmlDeviceGetHandleByIndexFn = unsafe extern "system" fn(u32, *mut usize) -> i32;
    type NvmlDeviceGetTemperatureFn = unsafe extern "system" fn(usize, u32, *mut u32) -> i32;
    type NvmlDeviceGetUtilizationRatesFn =
        unsafe extern "system" fn(usize, *mut NvmlUtilization) -> i32;
    type NvmlDeviceGetPowerUsageFn = unsafe extern "system" fn(usize, *mut u32) -> i32;

    struct NvmlLib {
        device_get_count: NvmlDeviceGetCountFn,
        device_get_handle: NvmlDeviceGetHandleByIndexFn,
        device_get_temp: NvmlDeviceGetTemperatureFn,
        device_get_util: Option<NvmlDeviceGetUtilizationRatesFn>,
        device_get_power: Option<NvmlDeviceGetPowerUsageFn>,
    }

    impl NvmlLib {
        fn load() -> Option<Self> {
            unsafe {
                let mut h = LoadLibraryA(b"nvml.dll\0".as_ptr());
                if h.is_null() {
                    if let Some(pf) = std::env::var_os("ProgramFiles") {
                        let candidate = format!(
                            "{}\\NVIDIA Corporation\\NVSMI\\nvml.dll",
                            pf.to_string_lossy()
                        );
                        let wide = to_wide_nul(&candidate);
                        h = LoadLibraryW(wide.as_ptr());
                    }
                }
                if h.is_null() {
                    return None;
                }

                let init: NvmlInitFn = load_proc(h, b"nvmlInit_v2\0")
                    .or_else(|| load_proc(h, b"nvmlInit\0"))?;
                if init() != 0 {
                    return None;
                }

                let device_get_count: NvmlDeviceGetCountFn =
                    load_proc(h, b"nvmlDeviceGetCount_v2\0")
                        .or_else(|| load_proc(h, b"nvmlDeviceGetCount\0"))?;
                let mut count: u32 = 0;
                if device_get_count(&mut count) != 0 || count == 0 {
                    return None;
                }

                let device_get_handle: NvmlDeviceGetHandleByIndexFn =
                    load_proc(h, b"nvmlDeviceGetHandleByIndex_v2\0")
                        .or_else(|| load_proc(h, b"nvmlDeviceGetHandleByIndex\0"))?;
                let device_get_temp: NvmlDeviceGetTemperatureFn =
                    load_proc(h, b"nvmlDeviceGetTemperature\0")?;
                let device_get_util = load_proc(h, b"nvmlDeviceGetUtilizationRates\0");
                let device_get_power = load_proc(h, b"nvmlDeviceGetPowerUsage\0");

                Some(Self {
                    device_get_count,
                    device_get_handle,
                    device_get_temp,
                    device_get_util,
                    device_get_power,
                })
            }
        }

        fn sample(&self) -> Option<(Option<f32>, Option<f32>, Option<f32>)> {
            const NVML_TEMPERATURE_GPU: u32 = 0;
            let mut count: u32 = 0;
            if unsafe { (self.device_get_count)(&mut count) } != 0 || count == 0 {
                return None;
            }
            for idx in 0..count.min(4) {
                let mut handle: usize = 0;
                if unsafe { (self.device_get_handle)(idx, &mut handle) } != 0 || handle == 0 {
                    continue;
                }
                let mut temp_u: u32 = 0;
                let temp = if unsafe { (self.device_get_temp)(handle, NVML_TEMPERATURE_GPU, &mut temp_u) }
                    == 0
                    && (10..125).contains(&temp_u)
                {
                    Some(temp_u as f32)
                } else {
                    None
                };

                let load = self.device_get_util.and_then(|f| {
                    let mut util = NvmlUtilization { gpu: 0, memory: 0 };
                    if unsafe { f(handle, &mut util) } == 0 && util.gpu <= 100 {
                        Some(util.gpu as f32)
                    } else {
                        None
                    }
                });

                let power = self.device_get_power.and_then(|f| {
                    let mut mw: u32 = 0;
                    if unsafe { f(handle, &mut mw) } == 0 && mw <= 600_000 {
                        Some(mw as f32 / 1000.0)
                    } else {
                        None
                    }
                });

                if temp.is_some() || load.is_some() || power.is_some() {
                    return Some((temp, load, power));
                }
            }
            None
        }
    }

    pub(super) fn read_nvidia_gpu_telemetry() -> Option<(Option<f32>, Option<f32>, Option<f32>)> {
        static NVML: OnceLock<Option<NvmlLib>> = OnceLock::new();
        if let Some(lib) = NVML.get_or_init(NvmlLib::load).as_ref() {
            return lib.sample();
        }

        // One-time probe for `nvidia-smi` on PATH so non-NVIDIA laptops never spawn it repeatedly
        static HAS_NVIDIA_SMI: OnceLock<bool> = OnceLock::new();
        let has_cli = *HAS_NVIDIA_SMI.get_or_init(|| {
            run_cmd_stdout("where", &["nvidia-smi"]).is_ok()
        });
        if !has_cli {
            return None;
        }

        static CLI_CACHE: Mutex<Option<(Instant, Option<(Option<f32>, Option<f32>, Option<f32>)>)>> =
            Mutex::new(None);
        if let Ok(guard) = CLI_CACHE.lock() {
            if let Some((ts, cached)) = *guard {
                if ts.elapsed() < Duration::from_secs(2) {
                    return cached;
                }
            }
        }

        let parsed = run_cmd_stdout(
            "nvidia-smi",
            &[
                "--query-gpu=temperature.gpu,utilization.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
        )
        .ok()
        .and_then(|out| parse_nvidia_smi_csv(&out));

        if let Ok(mut guard) = CLI_CACHE.lock() {
            *guard = Some((Instant::now(), parsed));
        }
        parsed
    }

    // ------------------------------------------------------------------------
    // 4. Throttled LHM/OHM & ACPI/WMI Thermal Fallbacks (Process-Scoped)
    // ------------------------------------------------------------------------

    type LhmValues = (Option<f32>, Option<f32>, Option<u32>, Option<f32>);

    struct LhmCacheState {
        available: Option<bool>,
        last_probe: Option<Instant>,
        last_values: Option<LhmValues>,
    }

    pub(super) fn read_lhm_wmi_sensors_throttled(
        instance_flag: &mut Option<bool>,
    ) -> Option<LhmValues> {
        static LHM_CACHE: Mutex<LhmCacheState> = Mutex::new(LhmCacheState {
            available: None,
            last_probe: None,
            last_values: None,
        });

        if let Ok(guard) = LHM_CACHE.lock() {
            if let Some(ts) = guard.last_probe {
                let elapsed = ts.elapsed();
                match guard.available {
                    Some(false) if elapsed < Duration::from_secs(30) => {
                        *instance_flag = Some(false);
                        return None;
                    }
                    Some(true) if elapsed < Duration::from_millis(2500) => {
                        *instance_flag = Some(true);
                        return guard.last_values;
                    }
                    _ => {}
                }
            }
        }

        let res = read_lhm_wmi_sensors();
        let present = res.is_some();
        *instance_flag = Some(present);

        if let Ok(mut guard) = LHM_CACHE.lock() {
            guard.available = Some(present);
            guard.last_probe = Some(Instant::now());
            guard.last_values = res;
        }
        res
    }

    fn read_lhm_wmi_sensors() -> Option<LhmValues> {
        use serde_json::Value;

        let ps = r#"
$ns = $null
foreach ($cand in @('root\LibreHardwareMonitor','root\OpenHardwareMonitor','root\HWiNFO')) {
    if (Get-CimInstance -Namespace $cand -ClassName Sensor -ErrorAction SilentlyContinue | Select-Object -First 1) {
        $ns = $cand; break
    }
}
if (-not $ns) { exit 1 }
$sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue
$ct = ($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU Package|Core Max|Core Average|Tctl|Tdie|CPU \(Tctl' } | Select-Object -First 1).Value
$cp = ($sensors | Where-Object { $_.SensorType -eq 'Power' -and $_.Name -match 'CPU Package' } | Select-Object -First 1).Value
$fr = ($sensors | Where-Object { $_.SensorType -eq 'Fan' -and $_.Value -gt 0 } | Select-Object -First 1).Value
$gt = ($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'GPU Core|GPU Hot|GPU Temperature' } | Select-Object -First 1).Value
@{ ct = $ct; cp = $cp; fr = $fr; gt = $gt } | ConvertTo-Json -Compress
"#;

        let raw = run_powershell(ps).ok()?;
        let v: Value = serde_json::from_str(&raw).ok()?;
        let ct = v["ct"]
            .as_f64()
            .map(|x| x as f32)
            .filter(|&x| x > 10.0 && x < 125.0);
        let cp = v["cp"]
            .as_f64()
            .map(|x| x as f32)
            .filter(|&x| x >= 0.0 && x < 350.0);
        let fr = v["fr"]
            .as_f64()
            .map(|x| x.round() as u32)
            .filter(|&x| x > 0 && x < 15000);
        let gt = v["gt"]
            .as_f64()
            .map(|x| x as f32)
            .filter(|&x| x > 10.0 && x < 125.0);
        Some((ct, cp, fr, gt))
    }

    pub(super) fn read_windows_native_acpi_wmi_throttled() -> Option<f32> {
        static ACPI_WMI_CACHE: Mutex<Option<(Instant, Option<f32>)>> = Mutex::new(None);
        if let Ok(guard) = ACPI_WMI_CACHE.lock() {
            if let Some((ts, cached)) = *guard {
                if ts.elapsed() < Duration::from_secs(5) {
                    return cached;
                }
            }
        }

        let temp = read_windows_native_acpi_wmi();
        if let Ok(mut guard) = ACPI_WMI_CACHE.lock() {
            *guard = Some((Instant::now(), temp));
        }
        temp
    }

    fn read_windows_native_acpi_wmi() -> Option<f32> {
        use serde_json::Value;

        let ps = r#"
$tempC = $null
$tz1 = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Select-Object HighPrecisionTemperature, Temperature
foreach ($z in $tz1) {
    if ($z.HighPrecisionTemperature -gt 2881 -and $z.HighPrecisionTemperature -lt 3931) {
        $c = [math]::Round(([double]$z.HighPrecisionTemperature / 10.0 - 273.15), 1)
        if ($null -eq $tempC -or $c -gt $tempC) { $tempC = $c }
    } elseif ($z.Temperature -gt 288 -and $z.Temperature -lt 393) {
        $c = [math]::Round(([double]$z.Temperature - 273.15), 1)
        if ($null -eq $tempC -or $c -gt $tempC) { $tempC = $c }
    }
}
if ($null -eq $tempC) {
    $tz2 = Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Where-Object { $_.CurrentTemperature -gt 2881 -and $_.CurrentTemperature -lt 3931 } | Sort-Object CurrentTemperature -Descending | Select-Object -First 1
    if ($tz2) {
        $tempC = [math]::Round(([double]$tz2.CurrentTemperature / 10.0 - 273.15), 1)
    }
}
if ($null -eq $tempC) {
    $tp = Get-CimInstance Win32_TemperatureProbe -ErrorAction SilentlyContinue | Where-Object { $_.CurrentReading -gt 150 -and $_.CurrentReading -lt 1200 } | Select-Object -First 1
    if ($tp) {
        $tempC = [math]::Round(([double]$tp.CurrentReading / 10.0), 1)
    }
}
if ($null -eq $tempC) {
    # Dell Command | Monitor OEM temperature sensor (root\dcim\sysman)
    $dell = Get-CimInstance -Namespace root\dcim\sysman -ClassName DCIM_NumericSensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq 2 -and $_.CurrentReading -gt 15 -and $_.CurrentReading -lt 120 } | Sort-Object CurrentReading -Descending | Select-Object -First 1
    if ($dell) { $tempC = [double]$dell.CurrentReading }
}
if ($null -eq $tempC) {
    # HP Instrumented BIOS temperature sensor
    $hp = Get-CimInstance -Namespace root\hp\instrumentedBIOS -ClassName HP_BIOSNumericSensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq 2 -and $_.CurrentReading -gt 15 -and $_.CurrentReading -lt 120 } | Sort-Object CurrentReading -Descending | Select-Object -First 1
    if ($hp) { $tempC = [double]$hp.CurrentReading }
}
if ($null -eq $tempC) {
    # Lenovo / Generic CIM_TemperatureSensor fallback
    $cim = Get-CimInstance -Namespace root\cimv2 -ClassName CIM_TemperatureSensor -ErrorAction SilentlyContinue | Where-Object { $_.CurrentReading -gt 150 -and $_.CurrentReading -lt 1200 } | Select-Object -First 1
    if ($cim) { $tempC = [math]::Round(([double]$cim.CurrentReading / 10.0), 1) }
}
@{ tempC = $tempC } | ConvertTo-Json -Compress
"#;

        let raw = run_powershell(ps).ok()?;
        let v: Value = serde_json::from_str(&raw).ok()?;
        v["tempC"]
            .as_f64()
            .map(|t| t as f32)
            .filter(|&t| t > 15.0 && t < 120.0)
    }

    // ------------------------------------------------------------------------
    // 5. Fast In-Process Windows AC / Battery (kernel32.dll + powrprof.dll)
    // ------------------------------------------------------------------------

    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[repr(C)]
    struct SystemBatteryState {
        ac_on_line: u8,
        battery_present: u8,
        charging: u8,
        discharging: u8,
        spare1: [u8; 3],
        tag: u8,
        max_capacity: u32,
        remaining_capacity: u32,
        rate: i32,
        estimated_time: u32,
        default_alert1: u32,
        default_alert2: u32,
    }

    type GetSystemPowerStatusFn = unsafe extern "system" fn(*mut SystemPowerStatus) -> i32;
    type CallNtPowerInformationFn = unsafe extern "system" fn(
        information_level: u32,
        input_buffer: *const c_void,
        input_buffer_length: u32,
        output_buffer: *mut c_void,
        output_buffer_length: u32,
    ) -> i32;

    struct PowerApi {
        get_system_power_status: Option<GetSystemPowerStatusFn>,
        call_nt_power_information: Option<CallNtPowerInformationFn>,
    }

    impl PowerApi {
        fn load() -> Self {
            unsafe {
                let k32 = LoadLibraryA(b"kernel32.dll\0".as_ptr());
                let powr = LoadLibraryA(b"powrprof.dll\0".as_ptr());
                let get_system_power_status = if !k32.is_null() {
                    load_proc(k32, b"GetSystemPowerStatus\0")
                } else {
                    None
                };
                let call_nt_power_information = if !powr.is_null() {
                    load_proc(powr, b"CallNtPowerInformation\0")
                } else {
                    None
                };
                Self {
                    get_system_power_status,
                    call_nt_power_information,
                }
            }
        }
    }

    pub(super) fn read_windows_fast_power(
    ) -> Option<(Option<bool>, Option<bool>, Option<f64>, Option<f64>)> {
        static POWER_API: OnceLock<PowerApi> = OnceLock::new();
        let api = POWER_API.get_or_init(PowerApi::load);

        let mut ac_plugged: Option<bool> = None;
        let mut battery_present: Option<bool> = None;
        let mut battery_percent: Option<f64> = None;
        let mut battery_watts: Option<f64> = None;

        if let Some(f) = api.get_system_power_status {
            let mut sps = SystemPowerStatus {
                ac_line_status: 255,
                battery_flag: 255,
                battery_life_percent: 255,
                system_status_flag: 0,
                battery_life_time: 0,
                battery_full_life_time: 0,
            };
            if unsafe { f(&mut sps) } != 0 {
                ac_plugged = match sps.ac_line_status {
                    0 => Some(false),
                    1 => Some(true),
                    _ => None,
                };
                if sps.battery_flag != 255 && (sps.battery_flag & 128) != 0 {
                    battery_present = Some(false);
                } else if sps.battery_life_percent <= 100 {
                    battery_present = Some(true);
                    battery_percent = Some(sps.battery_life_percent as f64);
                }
            }
        }

        if let Some(f) = api.call_nt_power_information {
            const SYSTEM_BATTERY_STATE: u32 = 5;
            let mut sbs = SystemBatteryState {
                ac_on_line: 0,
                battery_present: 0,
                charging: 0,
                discharging: 0,
                spare1: [0; 3],
                tag: 0,
                max_capacity: 0,
                remaining_capacity: 0,
                rate: i32::MIN,
                estimated_time: 0,
                default_alert1: 0,
                default_alert2: 0,
            };
            let st = unsafe {
                f(
                    SYSTEM_BATTERY_STATE,
                    std::ptr::null(),
                    0,
                    (&mut sbs as *mut SystemBatteryState).cast::<c_void>(),
                    size_of::<SystemBatteryState>() as u32,
                )
            };
            if st == 0 {
                if ac_plugged.is_none() {
                    ac_plugged = Some(sbs.ac_on_line != 0);
                }
                let present = sbs.battery_present != 0;
                battery_present = Some(present);
                if present {
                    if battery_percent.is_none() && sbs.max_capacity > 0 {
                        let pct = ((sbs.remaining_capacity as f64 / sbs.max_capacity as f64) * 100.0)
                            .clamp(0.0, 100.0);
                        battery_percent = Some((pct * 10.0).round() / 10.0);
                    }
                    if sbs.rate != i32::MIN && sbs.rate.saturating_abs() <= 300_000 {
                        battery_watts =
                            Some(((sbs.rate as f64) / 1000.0 * 100.0).round() / 100.0);
                    }
                } else {
                    battery_percent = None;
                    battery_watts = None;
                }
            }
        }

        if ac_plugged.is_none() && battery_present.is_none() && battery_percent.is_none() {
            None
        } else {
            Some((ac_plugged, battery_present, battery_percent, battery_watts))
        }
    }

    pub(super) fn sample_battery_live_cached() -> Option<BatteryLiveSample> {
        static BAT_CACHE: Mutex<Option<(Instant, Option<BatteryLiveSample>)>> = Mutex::new(None);
        if let Ok(guard) = BAT_CACHE.lock() {
            if let Some((ts, ref cached)) = *guard {
                if ts.elapsed() < Duration::from_secs(5) {
                    return cached.clone();
                }
            }
        }
        let sample = battery::sample_battery_live();
        if let Ok(mut guard) = BAT_CACHE.lock() {
            *guard = Some((Instant::now(), sample.clone()));
        }
        sample
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kelvin_and_tenths_kelvin_normalization_bounds() {
        assert_eq!(kelvin_to_celsius(315.15), Some(42.0));
        assert_eq!(tenths_kelvin_to_celsius(3152.0), Some(42.1));
        assert_eq!(tenths_kelvin_to_celsius(3151.5), Some(42.0));

        // Reject out-of-range, bogus OEM, NaN, and Inf readings
        assert_eq!(kelvin_to_celsius(0.0), None);
        assert_eq!(kelvin_to_celsius(273.15), None); // 0°C
        assert_eq!(kelvin_to_celsius(450.0), None); // 176.85°C
        assert_eq!(kelvin_to_celsius(f64::NAN), None);
        assert_eq!(kelvin_to_celsius(f64::INFINITY), None);

        assert_eq!(tenths_kelvin_to_celsius(0.0), None);
        assert_eq!(tenths_kelvin_to_celsius(2732.0), None); // 0.05°C
        assert_eq!(tenths_kelvin_to_celsius(5000.0), None); // 226.85°C
        assert_eq!(tenths_kelvin_to_celsius(f64::NAN), None);
    }

    #[test]
    fn test_parse_nvidia_smi_csv_valid_and_partial() {
        assert_eq!(
            parse_nvidia_smi_csv("64, 88, 72.45\n"),
            Some((Some(64.0), Some(88.0), Some(72.45)))
        );
        assert_eq!(
            parse_nvidia_smi_csv("55, [N/A], [Not Supported]"),
            Some((Some(55.0), None, None))
        );
        assert_eq!(parse_nvidia_smi_csv(""), None);
        assert_eq!(parse_nvidia_smi_csv("garbage, line"), None);
        assert_eq!(parse_nvidia_smi_csv("[N/A], [N/A], [N/A]"), None);
    }

    #[test]
    fn test_classify_sysinfo_component_labels_macos_and_generic() {
        assert_eq!(
            classify_sysinfo_component_temp("PMU tdie1", 48.5),
            ClassifiedComponentTemp::Cpu(48.5)
        );
        assert_eq!(
            classify_sysinfo_component_temp("pACC MTR Temp Sensor0", 54.0),
            ClassifiedComponentTemp::Cpu(54.0)
        );
        assert_eq!(
            classify_sysinfo_component_temp("eACC MTR Temp Sensor0", 44.0),
            ClassifiedComponentTemp::Cpu(44.0)
        );
        assert_eq!(
            classify_sysinfo_component_temp("SOC MTR Temp Sensor0", 51.0),
            ClassifiedComponentTemp::Cpu(51.0)
        );
        assert_eq!(
            classify_sysinfo_component_temp("GPU MTR Temp Sensor0", 56.0),
            ClassifiedComponentTemp::Gpu(56.0)
        );
        assert_eq!(
            classify_sysinfo_component_temp("Package id 0", 62.0),
            ClassifiedComponentTemp::Cpu(62.0)
        );
        assert_eq!(
            classify_sysinfo_component_temp("Tctl/Tdie", 67.5),
            ClassifiedComponentTemp::Cpu(67.5)
        );
        assert_eq!(
            classify_sysinfo_component_temp("NAND CH0 temp", 38.0),
            ClassifiedComponentTemp::Ignore
        );
        assert_eq!(
            classify_sysinfo_component_temp("gas gauge battery", 31.0),
            ClassifiedComponentTemp::Ignore
        );
        assert_eq!(
            classify_sysinfo_component_temp("Package id 0", 0.0),
            ClassifiedComponentTemp::Ignore
        );
        assert_eq!(
            classify_sysinfo_component_temp("Package id 0", 150.0),
            ClassifiedComponentTemp::Ignore
        );
    }

    #[test]
    fn test_sensor_availability_flags_all_missing_vs_partial() {
        let none = compute_sensor_availability(None, None, None, None, None, "");
        assert_eq!(none, (false, false, false, "Unavailable".to_string()));

        let gpu_only =
            compute_sensor_availability(None, Some(61.0), None, Some(45.2), None, "");
        assert_eq!(
            gpu_only,
            (false, true, true, "NVML (GPU only)".to_string())
        );

        let lhm = compute_sensor_availability(
            Some(58.0),
            Some(52.0),
            Some(18.5),
            None,
            Some(-12.3),
            "LHM/OHM WMI",
        );
        assert_eq!(lhm, (true, true, true, "LHM/OHM WMI".to_string()));
    }

    #[test]
    fn test_compute_turbo_mhz_bounds() {
        assert_eq!(compute_turbo_mhz(2400, 180.6), Some(4334));
        assert_eq!(compute_turbo_mhz(0, 150.0), None);
        assert_eq!(compute_turbo_mhz(2400, f64::NAN), None);
        assert_eq!(compute_turbo_mhz(2400, 10.0), None); // 240 MHz < 400
        assert_eq!(compute_turbo_mhz(3000, 350.0), None); // 10500 MHz > 8000
    }

    #[test]
    fn test_normalize_power_meter_watts() {
        assert_eq!(normalize_power_meter_watts(15400.0), Some(15.4));
        assert_eq!(normalize_power_meter_watts(24.5), Some(24.5));
        assert_eq!(normalize_power_meter_watts(0.0), None);
        assert_eq!(normalize_power_meter_watts(f64::NAN), None);
    }

    #[test]
    fn test_live_telemetry_snapshot_serde_backward_compat() {
        // Legacy v2.2 JSON payload lacking the 4 new M2.1 sensor-availability fields
        let legacy_json = r#"{
            "cpuUsagePct": 42.5,
            "cpuClockMhz": 3200,
            "cpuTempC": 68.2,
            "cpuPowerW": 18.0,
            "gpuTempC": null,
            "gpuLoadPct": 12.0,
            "gpuPowerW": null,
            "fanRpm": 2400,
            "acPlugged": true,
            "batteryPercent": 96.0,
            "batteryWatts": 0.0,
            "sensorSource": "Windows PDH Turbo"
        }"#;
        let snap: LiveTelemetrySnapshot =
            serde_json::from_str(legacy_json).expect("Legacy JSON must deserialize cleanly");
        assert_eq!(snap.cpu_usage_pct, 42.5);
        assert_eq!(snap.cpu_clock_mhz, 3200);
        assert_eq!(snap.cpu_temp_c, Some(68.2));
        assert!(!snap.cpu_temp_available);
        assert!(!snap.gpu_temp_available);
        assert!(!snap.power_watts_available);
        assert_eq!(snap.temp_source, "");
    }

    #[test]
    fn test_thermal_safety_conservatism_when_sensor_unavailable() {
        let no_sensors = LiveTelemetrySnapshot::default();
        assert_eq!(
            TelemetryReader::is_thermal_safe(&no_sensors, 92.0, 92.0),
            ThermalSafetyCheck::SensorUnavailable
        );

        let gpu_only_safe = LiveTelemetrySnapshot {
            gpu_temp_c: Some(65.0),
            gpu_temp_available: true,
            ..Default::default()
        };
        // CPU-only check still reports SensorUnavailable when cpu_temp_c is None
        assert_eq!(
            TelemetryReader::is_thermal_safe(&gpu_only_safe, 92.0, f32::INFINITY),
            ThermalSafetyCheck::SensorUnavailable
        );
        // Combined or GPU-only check reports Safe when GPU temp is below cutoff
        assert_eq!(
            TelemetryReader::is_thermal_safe(&gpu_only_safe, 92.0, 92.0),
            ThermalSafetyCheck::Safe
        );

        let hot_cpu = LiveTelemetrySnapshot {
            cpu_temp_c: Some(92.5),
            cpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot_cpu, 92.0, 92.0),
            ThermalSafetyCheck::CutoffTriggered {
                sensor: "CPU",
                temp_c: 92.5
            }
        );

        let hot_gpu = LiveTelemetrySnapshot {
            cpu_temp_c: Some(74.0),
            gpu_temp_c: Some(92.0),
            cpu_temp_available: true,
            gpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot_gpu, 92.0, 92.0),
            ThermalSafetyCheck::CutoffTriggered {
                sensor: "GPU",
                temp_c: 92.0
            }
        );

        let nan_cpu = LiveTelemetrySnapshot {
            cpu_temp_c: Some(f32::NAN),
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&nan_cpu, 92.0, 92.0),
            ThermalSafetyCheck::SensorUnavailable
        );

        let inf_gpu = LiveTelemetrySnapshot {
            gpu_temp_c: Some(f32::INFINITY),
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&inf_gpu, 92.0, 92.0),
            ThermalSafetyCheck::SensorUnavailable
        );

        let hot_105 = LiveTelemetrySnapshot {
            cpu_temp_c: Some(105.0),
            cpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot_105, f32::NAN, f32::NAN),
            ThermalSafetyCheck::SensorUnavailable
        );
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot_105, f32::NAN, 92.0),
            ThermalSafetyCheck::SensorUnavailable
        );

        let at_92 = LiveTelemetrySnapshot {
            cpu_temp_c: Some(92.0),
            cpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&at_92, 92.0, 92.0),
            ThermalSafetyCheck::CutoffTriggered {
                sensor: "CPU",
                temp_c: 92.0
            }
        );
    }

    #[test]
    fn test_sample_throttled_returns_cached_within_interval() {
        let mut reader = TelemetryReader::default();
        let first = reader.sample_throttled(false, Duration::from_secs(10));
        let t0 = Instant::now();
        let second = reader.sample_throttled(false, Duration::from_secs(10));
        assert!(t0.elapsed() < Duration::from_millis(50));
        assert_eq!(first.sensor_source, second.sensor_source);
        assert_eq!(first.cpu_clock_mhz, second.cpu_clock_mhz);
        assert_eq!(first.temp_source, second.temp_source);

        // Switching from include_battery=false to include_battery=true forces a refresh
        let with_bat = reader.sample_throttled(true, Duration::from_secs(10));
        assert!(!with_bat.sensor_source.is_empty());
        assert!(!with_bat.temp_source.is_empty());
    }
}
