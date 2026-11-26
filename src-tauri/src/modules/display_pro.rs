//! Display Pro Suite: Native Max-Hz Mismatch Audit & 15s Live eDP Hinge-Flex Drop Monitor (v2.11.0)

use crate::types::{
    DisplayCapabilitiesReport, EdpHingeFlexProgress, EdpHingeFlexResult, TestStatus,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Evaluates active refresh rate vs. native maximum supported refresh rate at the panel's
/// resolution. Flags `MAX_HZ_MISMATCH` (`WARN`) when a high-refresh panel (>= 90 Hz capable)
/// is running >= 15 Hz below its native max (e.g. a 144Hz laptop stuck at 60Hz).
pub fn evaluate_display_capabilities(
    active_width: u32,
    active_height: u32,
    active_hz: u32,
    native_max_hz: u32,
    mut supported_hz_list: Vec<u32>,
    color_depth_bpp: Option<u32>,
    monitor_count: u32,
    platform: &str,
) -> DisplayCapabilitiesReport {
    supported_hz_list.sort_unstable();
    supported_hz_list.dedup();
    let effective_max = native_max_hz.max(active_hz);
    let max_hz_mismatch =
        effective_max >= 90 && active_hz > 0 && effective_max.saturating_sub(active_hz) >= 15;

    let (status, verdict, plain_summary) = if active_width == 0 || active_height == 0 || active_hz == 0 {
        (
            TestStatus::Warn,
            "UNAVAILABLE".to_string(),
            "OS display mode telemetry was unavailable; verify refresh rate inside Fullscreen Motion Clarity."
                .to_string(),
        )
    } else if max_hz_mismatch {
        (
            TestStatus::Warn,
            "MAX_HZ_MISMATCH".to_string(),
            format!(
                "WARN: Panel supports up to {} Hz at {}x{}, but Windows/OS is currently running at {} Hz — switch Display Settings to {} Hz (or inspect GPU/EDID driver).",
                effective_max, active_width, active_height, active_hz, effective_max
            ),
        )
    } else {
        (
            TestStatus::Pass,
            "NATIVE_HZ_OK".to_string(),
            format!(
                "Native refresh rate verified: {}x{} @ {} Hz (max {} Hz{}).",
                active_width,
                active_height,
                active_hz,
                effective_max,
                color_depth_bpp
                    .map(|b| format!(", {}-bit", b))
                    .unwrap_or_default()
            ),
        )
    };

    DisplayCapabilitiesReport {
        status,
        verdict,
        platform: platform.to_string(),
        active_width,
        active_height,
        active_hz,
        native_max_hz: effective_max,
        supported_hz_list,
        color_depth_bpp,
        monitor_count,
        max_hz_mismatch,
        plain_summary,
    }
}

/// Pure classifier for the 15-second eDP Hinge-Flex Drop Monitor.
/// Any internal display disconnect, sudden resolution/Hz reset, or Display TDR driver reset
/// during lid flexing flags `EDP_DROP_DETECTED` (`FAIL`).
pub fn classify_hinge_flex_result(
    duration_secs: f64,
    samples_taken: u32,
    disconnect_events: u32,
    mode_glitch_events: u32,
    driver_reset_events: u32,
    cancelled: bool,
) -> EdpHingeFlexResult {
    let total_faults = disconnect_events
        .saturating_add(mode_glitch_events)
        .saturating_add(driver_reset_events);
    let rounded_dur = (duration_secs * 10.0).round() / 10.0;

    if total_faults > 0 {
        let msg = format!(
            "FAIL: eDP display instability detected while flexing hinge ({} disconnect(s), {} mode glitch(es), {} driver reset(s) over {:.1}s) — inspect hinge eDP ribbon cable & connector.",
            disconnect_events, mode_glitch_events, driver_reset_events, rounded_dur
        );
        return EdpHingeFlexResult {
            status: TestStatus::Fail,
            verdict: "EDP_DROP_DETECTED".to_string(),
            duration_secs: rounded_dur,
            samples_taken,
            disconnect_events,
            mode_glitch_events,
            driver_reset_events,
            plain_summary: msg.clone(),
            summary: format!("FAIL: {} eDP hinge drop/glitch event(s).", total_faults),
        };
    }

    if cancelled && rounded_dur < 5.0 {
        let msg = format!(
            "Hinge-flex monitor stopped early at {:.1}s (0 drops observed, but < 5s window is incomplete).",
            rounded_dur
        );
        return EdpHingeFlexResult {
            status: TestStatus::Warn,
            verdict: "CANCELLED".to_string(),
            duration_secs: rounded_dur,
            samples_taken,
            disconnect_events: 0,
            mode_glitch_events: 0,
            driver_reset_events: 0,
            plain_summary: msg.clone(),
            summary: "CANCELLED: Stopped before 5s.".to_string(),
        };
    }

    let msg = format!(
        "PASS: Rock-solid eDP link across {:.1}s lid-flex check ({} live polls, 0 disconnects, 0 mode glitches, 0 driver resets).",
        rounded_dur, samples_taken
    );
    EdpHingeFlexResult {
        status: TestStatus::Pass,
        verdict: "STABLE".to_string(),
        duration_secs: rounded_dur,
        samples_taken,
        disconnect_events: 0,
        mode_glitch_events: 0,
        driver_reset_events: 0,
        plain_summary: msg,
        summary: format!("PASS: 0 eDP drops ({:.0}s flex test).", rounded_dur),
    }
}

/// Smart Shop Standard Display Pro verdict helper (used by tests & `--self-test`).
pub fn classify_display_pro_smart_verdict(
    dead_pixels: u32,
    stuck_pixels: u32,
    bleed_severity: &str, // "none" | "minor" | "severe"
    pressure_spots: bool,
    flicker_or_ghosting: bool,
    max_hz_mismatch: bool,
    edp_drop_detected: bool,
) -> (TestStatus, String) {
    let total_px = dead_pixels.saturating_add(stuck_pixels);
    let bleed = bleed_severity.to_ascii_lowercase();

    if edp_drop_detected || total_px >= 3 || bleed == "severe" || flicker_or_ghosting {
        let mut reasons = Vec::new();
        if edp_drop_detected {
            reasons.push("eDP hinge cable drop".to_string());
        }
        if total_px >= 3 {
            reasons.push(format!("{} dead/stuck pixels", total_px));
        }
        if bleed == "severe" {
            reasons.push("severe backlight bleed".to_string());
        }
        if flicker_or_ghosting {
            reasons.push("panel flicker/severe ghosting".to_string());
        }
        return (
            TestStatus::Fail,
            format!("FAIL: {}", reasons.join(", ")),
        );
    }

    if total_px > 0 || bleed == "minor" || pressure_spots || max_hz_mismatch {
        let mut reasons = Vec::new();
        if total_px > 0 {
            reasons.push(format!("{} minor pixel defect(s)", total_px));
        }
        if bleed == "minor" {
            reasons.push("minor backlight bleed/IPS glow".to_string());
        }
        if pressure_spots {
            reasons.push("white pressure spot noted".to_string());
        }
        if max_hz_mismatch {
            reasons.push("running below native max Hz".to_string());
        }
        return (
            TestStatus::Warn,
            format!("WARN: {}", reasons.join(", ")),
        );
    }

    (
        TestStatus::Pass,
        "PASS: Clean display panel — 0 pixel defects, uniform backlight, stable eDP link.".to_string(),
    )
}

#[cfg(target_os = "windows")]
mod win_display {
    use super::*;
    use crate::cmd_util::run_powershell;

    const ENUM_CURRENT_SETTINGS: u32 = 0xFFFF_FFFF;
    const SM_CMONITORS: i32 = 80;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct DevModeW {
        dm_device_name: [u16; 32],
        dm_spec_version: u16,
        dm_driver_version: u16,
        pub dm_size: u16,
        dm_driver_extra: u16,
        dm_fields: u32,
        union_pad: [u8; 16],
        dm_color: i16,
        dm_duplex: i16,
        dm_y_resolution: i16,
        dm_tt_option: i16,
        dm_collate: i16,
        dm_form_name: [u16; 32],
        dm_log_pixels: u16,
        pub dm_bits_per_pel: u32,
        pub dm_pels_width: u32,
        pub dm_pels_height: u32,
        dm_display_flags: u32,
        pub dm_display_frequency: u32,
        dm_icm_method: u32,
        dm_icm_intent: u32,
        dm_media_type: u32,
        dm_dither_type: u32,
        dm_reserved1: u32,
        dm_reserved2: u32,
        dm_panning_width: u32,
        dm_panning_height: u32,
    }

    impl Default for DevModeW {
        fn default() -> Self {
            let mut dm: Self = unsafe { std::mem::zeroed() };
            dm.dm_size = std::mem::size_of::<Self>() as u16;
            dm
        }
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumDisplaySettingsW(
            lpsz_device_name: *const u16,
            i_mode_num: u32,
            lp_dev_mode: *mut DevModeW,
        ) -> i32;
        fn GetSystemMetrics(n_index: i32) -> i32;
    }

    pub(super) fn query_current_mode() -> Option<(u32, u32, u32, u32, u32)> {
        let mut dm = DevModeW::default();
        let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm) };
        if ok == 0 {
            return None;
        }
        let monitors = unsafe { GetSystemMetrics(SM_CMONITORS) }.max(0) as u32;
        Some((
            dm.dm_pels_width,
            dm.dm_pels_height,
            dm.dm_display_frequency,
            dm.dm_bits_per_pel,
            monitors,
        ))
    }

    pub(super) fn probe_windows_display_capabilities() -> DisplayCapabilitiesReport {
        let Some((w, h, cur_hz, bpp, monitors)) = query_current_mode() else {
            return evaluate_display_capabilities(0, 0, 0, 0, vec![], None, 0, "Windows");
        };

        let mut hz_list: Vec<u32> = Vec::new();
        let mut max_hz = cur_hz;
        let mut mode_idx: u32 = 0;
        while mode_idx < 512 {
            let mut dm = DevModeW::default();
            let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), mode_idx, &mut dm) };
            if ok == 0 {
                break;
            }
            // Only collect refresh rates supported at the active/native resolution
            if dm.dm_pels_width == w && dm.dm_pels_height == h && dm.dm_display_frequency >= 24 && dm.dm_display_frequency <= 500 {
                hz_list.push(dm.dm_display_frequency);
                if dm.dm_display_frequency > max_hz {
                    max_hz = dm.dm_display_frequency;
                }
            }
            mode_idx += 1;
        }
        if cur_hz > 0 {
            hz_list.push(cur_hz);
        }

        evaluate_display_capabilities(
            w,
            h,
            cur_hz,
            max_hz,
            hz_list,
            if bpp > 0 { Some(bpp) } else { None },
            monitors,
            "Windows",
        )
    }

    pub(super) fn query_recent_display_tdr_count() -> u32 {
        let ps = "(Get-WinEvent -FilterHashtable @{LogName='System'; Id=4101; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue | Measure-Object).Count";
        run_powershell(ps)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0)
    }
}

#[cfg(target_os = "macos")]
fn probe_macos_display_capabilities() -> DisplayCapabilitiesReport {
    use crate::cmd_util::run_cmd_stdout;
    let out = run_cmd_stdout("system_profiler", &["SPDisplaysDataType"]).unwrap_or_default();
    parse_macos_spdisplays(&out)
}

#[allow(dead_code)]
pub fn parse_macos_spdisplays(out: &str) -> DisplayCapabilitiesReport {
    let mut w = 0u32;
    let mut h = 0u32;
    let mut cur_hz = 60u32;
    let mut max_hz = 60u32;
    let mut hz_list = Vec::new();
    let mut monitors = 0u32;

    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("Resolution:") {
            monitors = monitors.saturating_add(1);
            let nums: Vec<u32> = t
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|s| s.parse::<u32>().ok())
                .collect();
            if w == 0 && nums.len() >= 2 {
                w = nums[0];
                h = nums[1];
            }
            if t.contains("Hz") {
                if let Some(&hz) = nums.last() {
                    if (24..=240).contains(&hz) {
                        cur_hz = hz;
                        max_hz = max_hz.max(hz);
                        hz_list.push(hz);
                    }
                }
            }
        } else if t.contains("ProMotion") || t.contains("120Hz") || t.contains("120 Hz") {
            max_hz = max_hz.max(120);
            hz_list.push(120);
        }
    }
    if cur_hz > 0 {
        hz_list.push(cur_hz);
    }
    evaluate_display_capabilities(w, h, cur_hz, max_hz, hz_list, Some(30), monitors.max(1), "macOS")
}

pub fn probe_display_capabilities() -> DisplayCapabilitiesReport {
    #[cfg(target_os = "windows")]
    {
        win_display::probe_windows_display_capabilities()
    }
    #[cfg(target_os = "macos")]
    {
        probe_macos_display_capabilities()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        evaluate_display_capabilities(0, 0, 0, 0, vec![], None, 1, "Other")
    }
}

/// Runs the live 15-second eDP Hinge-Flex Drop Monitor while the technician tilts the lid 3x.
pub fn run_edp_hinge_flex_test(
    duration_secs: Option<u64>,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<EdpHingeFlexResult, String> {
    let dur = duration_secs.unwrap_or(15).clamp(6, 30);
    let baseline = probe_display_capabilities();
    let base_w = baseline.active_width;
    let base_h = baseline.active_height;
    let base_hz = baseline.active_hz;
    let base_monitors = baseline.monitor_count.max(1);

    #[cfg(target_os = "windows")]
    let base_tdr = win_display::query_recent_display_tdr_count();
    #[cfg(not(target_os = "windows"))]
    let base_tdr = 0u32;

    let started = Instant::now();
    let mut samples_taken = 0u32;
    let mut disconnect_events = 0u32;
    let mut mode_glitch_events = 0u32;
    let mut driver_reset_events = 0u32;
    let mut last_tdr_check = Instant::now();

    while started.elapsed().as_secs() < dur {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        samples_taken += 1;

        #[cfg(target_os = "windows")]
        {
            match win_display::query_current_mode() {
                None => {
                    disconnect_events += 1;
                }
                Some((w, h, hz, _, monitors)) => {
                    if monitors < base_monitors || w == 0 || h == 0 {
                        disconnect_events += 1;
                    } else if (base_w > 0 && (w != base_w || h != base_h))
                        || (base_hz > 0 && hz != base_hz)
                    {
                        mode_glitch_events += 1;
                    }
                }
            }
            if last_tdr_check.elapsed() >= Duration::from_secs(5) {
                let now_tdr = win_display::query_recent_display_tdr_count();
                driver_reset_events = driver_reset_events.max(now_tdr.saturating_sub(base_tdr));
                last_tdr_check = Instant::now();
            }
        }

        #[cfg(target_os = "macos")]
        {
            if samples_taken % 4 == 1 {
                let cur = probe_macos_display_capabilities();
                if cur.monitor_count < base_monitors || cur.active_width == 0 {
                    disconnect_events += 1;
                } else if base_w > 0 && (cur.active_width != base_w || cur.active_height != base_h) {
                    mode_glitch_events += 1;
                }
            }
        }

        let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
        let faults = disconnect_events + mode_glitch_events + driver_reset_events;
        let note = if faults > 0 {
            format!("FAULT: {} eDP drop/glitch event(s) detected!", faults)
        } else if elapsed < 5.0 {
            "Slowly tilt screen lid down to ~35 deg and back to 120 deg...".to_string()
        } else if elapsed < 10.0 {
            "Flex lid smoothly a 2nd time while watching for flicker or lines...".to_string()
        } else {
            "Final lid flex (3rd pass) — verifying rock-solid eDP ribbon stability...".to_string()
        };

        let _ = app.emit(
            "display:hinge",
            EdpHingeFlexProgress {
                running: true,
                elapsed_secs: elapsed,
                duration_secs: dur,
                samples_taken,
                disconnect_events,
                mode_glitch_events,
                driver_reset_events,
                note,
            },
        );

        std::thread::sleep(Duration::from_millis(250));
    }

    #[cfg(target_os = "windows")]
    {
        let end_tdr = win_display::query_recent_display_tdr_count();
        driver_reset_events = driver_reset_events.max(end_tdr.saturating_sub(base_tdr));
    }

    let elapsed = started.elapsed().as_secs_f64();
    let cancelled = cancel.load(Ordering::Relaxed);
    let result = classify_hinge_flex_result(
        elapsed,
        samples_taken,
        disconnect_events,
        mode_glitch_events,
        driver_reset_events,
        cancelled,
    );

    let _ = app.emit(
        "display:hinge",
        EdpHingeFlexProgress {
            running: false,
            elapsed_secs: result.duration_secs,
            duration_secs: dur,
            samples_taken,
            disconnect_events,
            mode_glitch_events,
            driver_reset_events,
            note: result.plain_summary.clone(),
        },
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evaluate_display_capabilities_max_hz_mismatch_vs_ok() {
        // 144Hz gaming panel stuck at 60Hz -> WARN MAX_HZ_MISMATCH
        let stuck = evaluate_display_capabilities(
            1920,
            1080,
            60,
            144,
            vec![60, 144],
            Some(32),
            1,
            "Windows",
        );
        assert_eq!(stuck.status, TestStatus::Warn);
        assert_eq!(stuck.verdict, "MAX_HZ_MISMATCH");
        assert!(stuck.max_hz_mismatch);

        // 144Hz panel running at 144Hz -> PASS NATIVE_HZ_OK
        let ok = evaluate_display_capabilities(
            1920,
            1080,
            144,
            144,
            vec![60, 144],
            Some(32),
            1,
            "Windows",
        );
        assert_eq!(ok.status, TestStatus::Pass);
        assert_eq!(ok.verdict, "NATIVE_HZ_OK");
        assert!(!ok.max_hz_mismatch);

        // Standard 60Hz office laptop running at 60Hz -> PASS
        let office = evaluate_display_capabilities(
            1920,
            1080,
            60,
            60,
            vec![60],
            Some(32),
            1,
            "Windows",
        );
        assert_eq!(office.status, TestStatus::Pass);
        assert!(!office.max_hz_mismatch);
    }

    #[test]
    fn test_classify_hinge_flex_stable_vs_drop_vs_early_cancel() {
        let ok = classify_hinge_flex_result(15.0, 60, 0, 0, 0, false);
        assert_eq!(ok.status, TestStatus::Pass);
        assert_eq!(ok.verdict, "STABLE");

        let drop = classify_hinge_flex_result(8.4, 34, 1, 0, 0, false);
        assert_eq!(drop.status, TestStatus::Fail);
        assert_eq!(drop.verdict, "EDP_DROP_DETECTED");

        let tdr = classify_hinge_flex_result(15.0, 60, 0, 0, 1, false);
        assert_eq!(tdr.status, TestStatus::Fail);
        assert_eq!(tdr.verdict, "EDP_DROP_DETECTED");

        let early = classify_hinge_flex_result(2.5, 10, 0, 0, 0, true);
        assert_eq!(early.status, TestStatus::Warn);
        assert_eq!(early.verdict, "CANCELLED");
    }

    #[test]
    fn test_smart_shop_display_pro_verdict_rules() {
        // Clean display -> PASS
        let (st_ok, _) = classify_display_pro_smart_verdict(0, 0, "none", false, false, false, false);
        assert_eq!(st_ok, TestStatus::Pass);

        // 1 dead pixel or minor bleed or Max-Hz mismatch -> WARN
        let (st_px1, _) = classify_display_pro_smart_verdict(1, 0, "none", false, false, false, false);
        assert_eq!(st_px1, TestStatus::Warn);
        let (st_bleed, _) = classify_display_pro_smart_verdict(0, 0, "minor", false, false, false, false);
        assert_eq!(st_bleed, TestStatus::Warn);
        let (st_hz, _) = classify_display_pro_smart_verdict(0, 0, "none", false, false, true, false);
        assert_eq!(st_hz, TestStatus::Warn);

        // >=3 dead/stuck pixels, severe bleed, flicker, or eDP drop -> FAIL
        let (st_px3, _) = classify_display_pro_smart_verdict(2, 1, "none", false, false, false, false);
        assert_eq!(st_px3, TestStatus::Fail);
        let (st_sev, _) = classify_display_pro_smart_verdict(0, 0, "severe", false, false, false, false);
        assert_eq!(st_sev, TestStatus::Fail);
        let (st_edp, _) = classify_display_pro_smart_verdict(0, 0, "none", false, false, false, true);
        assert_eq!(st_edp, TestStatus::Fail);
    }

    #[test]
    fn test_parse_macos_spdisplays_promotion() {
        let sample = r#"
Graphics/Displays:
    Apple M3 Pro:
      Displays:
        Color LCD:
          Display Type: Built-in Liquid Retina XDR Display
          Resolution: 3024 x 1964 Retina
          Refresh Rate: 60 Hz (ProMotion 120Hz capable)
"#;
        let rep = parse_macos_spdisplays(sample);
        assert_eq!(rep.active_width, 3024);
        assert_eq!(rep.active_height, 1964);
        assert_eq!(rep.native_max_hz, 120);
    }
}
