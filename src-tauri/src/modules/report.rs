use crate::modules::pdf_gen::{
    build_qr_payload, compute_certificate_id, render_qc_certificate_pdf, render_qr_svg,
};
use crate::types::{ExportReportPayload, ExportedReportPaths, ShopProfile, TestStatus};
use chrono::Local;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("shop_profile.json"))
}

pub fn load_shop_profile(app: &AppHandle) -> ShopProfile {
    if let Ok(path) = profile_path(app) {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(profile) = serde_json::from_str::<ShopProfile>(&text) {
                return profile;
            }
        }
    }
    ShopProfile::default()
}

pub fn save_shop_profile(app: &AppHandle, profile: &ShopProfile) -> Result<(), String> {
    let path = profile_path(app)?;
    let json = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn sanitize_filename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "UNKNOWN".to_string()
    } else {
        trimmed.chars().take(36).collect()
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn is_safe_raster_logo_data_url(url: &str) -> bool {
    let trimmed = url.trim();
    let Some((header, b64)) = trimmed.split_once(";base64,") else {
        return false;
    };
    let mime_ok = matches!(
        header.to_ascii_lowercase().as_str(),
        "data:image/png"
            | "data:image/jpeg"
            | "data:image/jpg"
            | "data:image/webp"
            | "data:image/gif"
    );
    if !mime_ok || b64.is_empty() {
        return false;
    }
    b64.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

fn parse_metric_u64(metrics: &[(String, String)], key: &str) -> Option<u64> {
    metrics
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| {
            let digits: String = v
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.is_empty() {
                None
            } else {
                digits.parse::<u64>().ok()
            }
        })
}

pub(crate) fn build_long_term_meaning(payload: &ExportReportPayload) -> (String, Vec<String>) {
    let stage_count = if payload.tests.is_empty() { 14 } else { payload.tests.len() };
    let fail_c = payload.tests.iter().filter(|t| t.status == TestStatus::Fail).count();
    let warn_c = payload.tests.iter().filter(|t| t.status == TestStatus::Warn).count();
    let skip_c = payload
        .tests
        .iter()
        .filter(|t| t.status == TestStatus::Skipped)
        .count();
    let na_c = payload
        .tests
        .iter()
        .filter(|t| t.status == TestStatus::NotApplicable)
        .count();

    let headline = payload
        .plain_verdict_summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if payload.overall_verdict == "FAILED" || fail_c > 0 {
                format!(
                    "{} diagnostic stage(s) flagged critical hardware or reliability faults. Repair or price-adjust affected subsystems before long-term deployment.",
                    fail_c.max(1)
                )
            } else if payload.overall_verdict == "INCOMPLETE" {
                format!(
                    "Inspection is incomplete ({} stage(s) evaluated). Complete or explicitly skip remaining stages for a full {}-stage certification.",
                    payload.tests.len(),
                    stage_count
                )
            } else if warn_c > 0 || skip_c > 0 {
                if na_c > 0 {
                    format!(
                        "Core hardware passed without critical failures; {} advisory warning(s) and {} skipped stage(s) ({} N/A stage(s)) are documented below for buyer transparency.",
                        warn_c, skip_c, na_c
                    )
                } else {
                    format!(
                        "Core hardware passed without critical failures; {} advisory warning(s) and {} skipped stage(s) are documented below for buyer transparency.",
                        warn_c, skip_c
                    )
                }
            } else if na_c > 0 {
                format!(
                    "All {} applicable diagnostic stages passed within factory-safe thermal, electrical, storage, and memory tolerances for reliable long-term use ({} N/A stage(s) noted).",
                    stage_count.saturating_sub(na_c),
                    na_c
                )
            } else {
                format!(
                    "All {} diagnostic stages passed within factory-safe thermal, electrical, storage, and memory tolerances for reliable long-term use.",
                    stage_count
                )
            }
        });

    let mut critical_bullets: Vec<String> = Vec::new();
    let mut standard_bullets: Vec<String> = Vec::new();
    let mut recommendation_bullets: Vec<String> = Vec::new();

    for t in &payload.tests {
        if t.status == TestStatus::Fail {
            critical_bullets.push(format!("CRITICAL FAIL ({}): {}", t.name, t.summary));
        } else if t.status == TestStatus::Warn {
            critical_bullets.push(format!("ADVISORY WARN ({}): {}", t.name, t.summary));
        }

        if t.id.eq_ignore_ascii_case("storage") || t.name.to_lowercase().contains("ssd smart") {
            let smart_health = parse_metric_u64(&t.metrics, "SMART Health");
            let wear_pct = parse_metric_u64(&t.metrics, "Wear (Log 0x02)");
            let spare_pct = parse_metric_u64(&t.metrics, "Spare");
            let media_errors = parse_metric_u64(&t.metrics, "Media Err");
            let unsafe_shutdowns = parse_metric_u64(&t.metrics, "Unsafe Off");
            let write_budget = t
                .metrics
                .iter()
                .find(|(k, _)| {
                    k.eq_ignore_ascii_case("Write Budget") || k.eq_ignore_ascii_case("Budget")
                })
                .map(|(_, v)| v.as_str());

            let has_smart_metrics = smart_health.is_some()
                || wear_pct.is_some()
                || spare_pct.is_some()
                || media_errors.is_some()
                || unsafe_shutdowns.is_some();

            let smart_degraded = wear_pct.map_or(false, |w| w >= 80)
                || spare_pct.map_or(false, |s| s <= 15)
                || media_errors.map_or(false, |m| m > 0)
                || unsafe_shutdowns.map_or(false, |u| u >= 50)
                || smart_health.map_or(false, |h| h <= 50)
                || t.summary.to_lowercase().contains("critical")
                || t.status == TestStatus::Fail
                || t.status == TestStatus::Warn;

            if has_smart_metrics && smart_degraded {
                let state_tag = match t.status {
                    TestStatus::Fail => "CRITICAL",
                    TestStatus::Warn => "WARNING",
                    TestStatus::Skipped => "STAGE SKIPPED / SMART FLAGGED",
                    _ => "DEGRADED",
                };
                let wear_str = wear_pct
                    .map(|v| format!("{}%", v))
                    .unwrap_or_else(|| "N/A".to_string());
                let spare_str = spare_pct
                    .map(|v| format!("{}%", v))
                    .unwrap_or_else(|| "N/A".to_string());
                let media_str = media_errors
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "0".to_string());
                let unsafe_str = unsafe_shutdowns
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "0".to_string());
                let guidance = if media_errors.unwrap_or(0) > 0
                    || spare_pct.map_or(false, |s| s <= 15)
                    || wear_pct.map_or(false, |w| w >= 100)
                {
                    "endurance or spare blocks are critically depleted; back up data and replace SSD"
                } else {
                    "elevated wear or power-loss shutdown history detected; monitor SMART Log 0x02 closely"
                };
                critical_bullets.push(format!(
                    "DriveDx NVMe SMART Log 0x02 ({}): Wear {}, available_spare {}, media_errors {}, unsafe_shutdowns {} — {}.",
                    state_tag, wear_str, spare_str, media_str, unsafe_str, guidance
                ));
            }

            if write_budget.is_some() || t.status == TestStatus::Skipped {
                let budget_note = write_budget
                    .map(|b| format!(" [Recorded: {}]", b))
                    .unwrap_or_default();
                standard_bullets.push(format!(
                    "SSD Write-Budget Protection: Direct-IO enforces <= 128 MB Quick / 256 MB Std / 512 MB max write budget with a 4x free-space guard (minimum 2048 MB free){}.",
                    budget_note
                ));
            }
        }
    }

    if let Some(bat) = &payload.battery_discharge {
        let mut line = format!(
            "Battery Discharge Normality ({}): {} [Idle {:.1}W / Load {:.1}W, Power CV {:.1}%, Sag {:.0}mV, SoC {:.1}% -> {:.1}%, Max 5s Drop {:.1}%, Wear {:.1}%, {} cycles]",
            bat.verdict,
            bat.plain_summary,
            bat.idle_avg_watts,
            bat.load_avg_watts,
            bat.power_cv_pct,
            bat.voltage_sag_mv,
            bat.soc_start_pct,
            bat.soc_end_pct,
            bat.max_step_drop_pct,
            bat.wear_pct,
            bat.cycle_count
        );
        if bat.verdict == "ABNORMAL" && !bat.reasons.is_empty() {
            let joined = bat.reasons.iter().take(2).cloned().collect::<Vec<_>>().join("; ");
            line.push_str(&format!(" — Reasons: {}", joined));
        }
        if matches!(
            bat.verdict.as_str(),
            "ABNORMAL" | "ABORTED_LOW_BATTERY" | "AC_CONNECTED" | "INSUFFICIENT_SAMPLES" | "CANCELLED"
        ) {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(chg) = &payload.battery_charge {
        let line = format!(
            "Active AC Charging IC Check ({}): {} [SoC {:.1}% -> {:.1}%, Avg {}W]",
            chg.verdict,
            chg.plain_summary,
            chg.start_charge_pct,
            chg.end_charge_pct,
            chg.avg_charge_watts
                .map(|w| format!("{:+.1}", w))
                .unwrap_or_else(|| "N/A".to_string())
        );
        if matches!(chg.verdict.as_str(), "CHARGING_IC_FAULT" | "SLOW_CHARGE" | "CONSERVATION_MODE") {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(sp) = &payload.specs {
        if let Some(w) = sp.ram_config_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            critical_bullets.push(format!("Memory Configuration Warning: {}", w.trim()));
        }
        if let Some(w) = sp.wifi_antenna_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            critical_bullets.push(format!("Wi-Fi Signal / Antenna Warning: {}", w.trim()));
        }
        for note in sp.reliability_notes.iter().take(3) {
            if !note.trim().is_empty() {
                standard_bullets.push(format!("Hardware Reliability Note: {}", note.trim()));
            }
        }
        if !sp.plain_summary.trim().is_empty() {
            recommendation_bullets.push(format!("System Identity Summary: {}", sp.plain_summary.trim()));
        }
    }

    if let Some(dp) = &payload.display_pro {
        let hinge_part = dp
            .hinge_flex
            .as_ref()
            .map(|h| format!(", eDP Hinge: {}", h.verdict))
            .unwrap_or_default();
        let px_total = dp.dead_pixels.saturating_add(dp.stuck_pixels);
        let line = format!(
            "Display Pro Audit: {} [Active {} Hz / Max {} Hz, Measured {} Hz, Jitter {:.1}ms, {} Drops, {} Pixel Defect(s), Bleed: {}{}]",
            dp.plain_summary,
            dp.active_hz,
            dp.native_max_hz,
            dp.measured_hz,
            dp.frame_jitter_ms,
            dp.dropped_frames,
            px_total,
            dp.bleed_severity,
            hinge_part
        );
        let has_issue = dp.max_hz_mismatch
            || px_total > 0
            || dp.bleed_severity != "none"
            || dp.pressure_spots
            || dp.flicker_or_ghosting
            || dp
                .hinge_flex
                .as_ref()
                .map(|h| h.verdict == "EDP_DROP_DETECTED")
                .unwrap_or(false);
        if has_issue {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(ts) = &payload.touchscreen {
        let line = format!(
            "Touchscreen Display ({}): {} [{}x{} grid {:.0}% covered, {}-pt max touch, RMS {:.1}px, {:.0}Hz]",
            ts.verdict,
            ts.plain_summary,
            ts.grid_cols,
            ts.grid_rows,
            ts.coverage_pct,
            ts.max_simultaneous_touches,
            ts.swipe_linearity_rms_px,
            ts.polling_hz
        );
        if matches!(ts.verdict.as_str(), "FAIL" | "WARN") {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(slp) = &payload.sleep_audit {
        let line = format!(
            "Sleep & Modern Standby Audit ({}): {} [Mode: {}, Wake-Armed: {}, Crashes: {}]",
            slp.verdict,
            slp.plain_summary,
            slp.sleep_mode,
            slp.wake_armed_devices.len(),
            slp.sleep_crash_count
        );
        if slp.verdict != "HEALTHY" {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(rem) = &payload.removable_drive_bench {
        let line = format!(
            "USB / SD-Card Real Speed Test ({}): {} [Read {:.1} MB/s / Write {:.1} MB/s]",
            rem.verdict, rem.plain_summary, rem.seq_read_mb_s, rem.seq_write_mb_s
        );
        if rem.status != TestStatus::Pass {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(net) = &payload.network_report {
        let line = format!(
            "Network & Wi-Fi Link ({}): {} [Interface: {}, DNS: {}, Loss: {:.0}%]",
            net.verdict,
            net.plain_summary,
            net.interface_name,
            if net.dns_resolve_ok { "OK" } else { "FAIL" },
            net.packet_loss_pct
        );
        if net.verdict != "HEALTHY" {
            critical_bullets.push(line);
        } else {
            standard_bullets.push(line);
        }
    }

    if let Some(ub) = &payload.user_benchmark {
        standard_bullets.push(format!(
            "UserBenchmark Standing ({}): Overall {} tier — Gaming {:.0}%, Desktop {:.0}%, Workstation {:.0}%. {}",
            ub.source_mode,
            ub.overall_vehicle_tier,
            ub.gaming_pct,
            ub.desktop_pct,
            ub.workstation_pct,
            ub.headline_summary
        ));
        for comp in [&ub.cpu, &ub.gpu, &ub.ssd, &ub.ram].into_iter().flatten() {
            if let Some(flag) = &comp.bottleneck_flag {
                if !flag.trim().is_empty() {
                    standard_bullets.push(format!(
                        "{} Bottleneck Advisory ({}): {}",
                        comp.component.to_uppercase(),
                        comp.standing_label,
                        flag.trim()
                    ));
                }
            }
        }
        for rec in ub.recommendations.iter().take(3) {
            let trimmed = rec.trim();
            if !trimmed.is_empty()
                && !critical_bullets.iter().any(|b| b.contains(trimmed))
                && !standard_bullets.iter().any(|b| b.contains(trimmed))
                && !recommendation_bullets.iter().any(|b| b.contains(trimmed))
            {
                recommendation_bullets.push(format!("Buyer Recommendation: {}", trimmed));
            }
        }
    }

    let mut bullets = critical_bullets;
    bullets.extend(standard_bullets);
    bullets.extend(recommendation_bullets);

    if bullets.is_empty() {
        bullets.push(format!(
            "No abnormal wear, thermal cutoff, or stability faults recorded across this {}-stage hardware inspection.",
            stage_count
        ));
    }

    (headline, bullets)
}

pub(crate) fn render_qc_html(payload: &ExportReportPayload, generated_at: &str) -> String {
    let cert_id = compute_certificate_id(payload, generated_at);
    let qr_svg = render_qr_svg(&build_qr_payload(payload, &cert_id));
    let stage_count = if payload.tests.is_empty() { 14 } else { payload.tests.len() };
    let shop = if payload.shop_profile.shop_name.trim().is_empty() {
        "LAPTOPBENCH QC LAB"
    } else {
        payload.shop_profile.shop_name.trim()
    };
    let tech = if payload.shop_profile.technician_name.trim().is_empty() {
        "Certified Technician"
    } else {
        payload.shop_profile.technician_name.trim()
    };

    let is_fail = payload.overall_verdict == "FAILED";
    let seal_bg = if is_fail { "#09090b" } else { "#2563eb" };
    let grade = payload
        .durability_grade
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if is_fail { "FAIL" } else if payload.overall_verdict == "PASSED" { "A" } else { "B" });

    let logo_html = payload
        .shop_profile
        .logo_data_url
        .as_deref()
        .map(str::trim)
        .filter(|u| is_safe_raster_logo_data_url(u))
        .map(|u| format!(r#"<img src="{}" alt="Shop Logo" class="logo" />"#, html_escape(u)))
        .unwrap_or_default();

    let pass_c = payload.tests.iter().filter(|t| t.status == TestStatus::Pass).count();
    let warn_c = payload.tests.iter().filter(|t| t.status == TestStatus::Warn).count();
    let fail_c = payload.tests.iter().filter(|t| t.status == TestStatus::Fail).count();
    let skip_c = payload
        .tests
        .iter()
        .filter(|t| t.status == TestStatus::Skipped || t.status == TestStatus::NotApplicable)
        .count();

    let (meaning_headline, meaning_bullets) = build_long_term_meaning(payload);
    let meaning_bullets_html = meaning_bullets
        .iter()
        .map(|b| format!("<li>{}</li>", html_escape(b)))
        .collect::<Vec<_>>()
        .join("");
    let long_term_html = format!(
        r#"<section class="sec">
          <div class="sec-title">00 // WHAT THIS MEANS FOR LONG-TERM USE</div>
          <div class="meaning-box">
            <div class="meaning-head">{}</div>
            <ul class="meaning-list">{}</ul>
          </div>
        </section>"#,
        html_escape(&meaning_headline),
        meaning_bullets_html
    );

    let specs_html = if let Some(sp) = &payload.specs {
        let gpus = sp.gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" / ");
        let disks = sp
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB {})", d.model, d.size_gb, d.interface_type))
            .collect::<Vec<_>>()
            .join("; ");
        let mut ram_desc = if !sp.ram_modules.is_empty() {
            format!(
                "{:.1} GB {} ({}x DIMM)",
                sp.total_ram_gb,
                sp.ram_modules[0].memory_type,
                sp.ram_modules.len()
            )
        } else {
            format!("{:.1} GB RAM", sp.total_ram_gb)
        };
        if let Some(ch) = sp.ram_channel_mode.as_deref().filter(|s| !s.trim().is_empty()) {
            ram_desc.push_str(&format!(" — {}", ch.trim()));
        }
        let wifi_desc = match (
            sp.wifi_ssid.as_deref(),
            sp.wifi_signal_pct,
            sp.wifi_rssi_dbm,
        ) {
            (Some(ssid), Some(pct), Some(rssi)) => {
                format!("{} ({}% / {} dBm)", ssid, pct, rssi)
            }
            (Some(ssid), Some(pct), None) => format!("{} ({}%)", ssid, pct),
            (None, Some(pct), Some(rssi)) => format!("Connected ({}% / {} dBm)", pct, rssi),
            (Some(ssid), None, None) => ssid.to_string(),
            _ => sp
                .wifi_radio_type
                .clone()
                .unwrap_or_else(|| "Not connected / N/A".to_string()),
        };
        let mut extra_notes = Vec::new();
        if let Some(w) = sp.ram_config_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            extra_notes.push(format!("RAM Config Advisory: {}", w.trim()));
        }
        if let Some(w) = sp.wifi_antenna_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            extra_notes.push(format!("Wi-Fi Signal Advisory: {}", w.trim()));
        }
        for n in &sp.reliability_notes {
            if !n.trim().is_empty() {
                extra_notes.push(n.trim().to_string());
            }
        }
        if !sp.plain_summary.trim().is_empty() {
            extra_notes.push(sp.plain_summary.trim().to_string());
        }
        if let Some(hf) = &payload.hardware_faults {
            if !hf.summary.trim().is_empty() {
                extra_notes.push(format!("Hardware Faults & EDID: {}", hf.summary.trim()));
            }
            if let Some(pan) = hf.panels.first() {
                if pan.replacement_suspected {
                    extra_notes.push(pan.disclosure_note.clone());
                }
            }
        }
        let extra_html = if extra_notes.is_empty() {
            String::new()
        } else {
            format!(
                r#"<div class="spec-note mono"><strong>Hardware Advisories:</strong> {}</div>"#,
                html_escape(&extra_notes.join(" • "))
            )
        };
        format!(
            r#"<section class="sec">
          <div class="sec-title">01 // VERIFIED DEVICE HARDWARE IDENTITY</div>
          <div class="spec-grid">
            <div><span>Model / Chassis</span><strong>{} {} ({})</strong></div>
            <div><span>Serial Number</span><strong class="mono">{}</strong></div>
            <div><span>Processor (CPU)</span><strong>{} ({}C / {}T)</strong></div>
            <div><span>BIOS / Firmware</span><strong class="mono">{}</strong></div>
            <div><span>System Memory</span><strong>{}</strong></div>
            <div><span>Operating System</span><strong>{} {} ({})</strong></div>
            <div><span>Graphics (GPU)</span><strong>{}</strong></div>
            <div><span>Storage Drives</span><strong>{}</strong></div>
            <div><span>Wi-Fi / Radio Signal</span><strong>{}</strong></div>
            <div><span>Gaming / dGPU Ready</span><strong>{}</strong></div>
          </div>
          {}
        </section>"#,
            html_escape(&sp.manufacturer),
            html_escape(&sp.model),
            html_escape(&sp.chassis_type),
            html_escape(&sp.serial_number),
            html_escape(&sp.cpu_brand),
            sp.cpu_physical_cores,
            sp.cpu_logical_cores,
            html_escape(&sp.bios_version),
            html_escape(&ram_desc),
            html_escape(&sp.os_name),
            html_escape(&sp.os_version),
            html_escape(&sp.architecture),
            html_escape(if gpus.is_empty() { "Integrated" } else { &gpus }),
            html_escape(if disks.is_empty() { "Detected" } else { &disks }),
            html_escape(&wifi_desc),
            if sp.is_gaming_capable { "Yes (Discrete / High-Perf GPU)" } else { "Standard / Integrated Class" },
            extra_html,
        )
    } else {
        String::new()
    };

    let bars_html = if payload.subsystem_scores.is_empty() {
        String::new()
    } else {
        let mut items = String::new();
        for b in &payload.subsystem_scores {
            let pct = b.score_pct.clamp(0.0, 100.0);
            let upper = b.status_label.to_uppercase();
            let is_fail =
                upper.contains("FAIL") || upper == "ABNORMAL" || upper == "POOR_LINK";
            let is_neutral_warn = !is_fail
                && (upper.contains("CANCELLED")
                    || upper.contains("INCOMPLETE")
                    || upper.contains("WARN")
                    || upper == "LOW"
                    || upper == "SKIPPED"
                    || upper == "NO_ACTIVE_LINK"
                    || upper == "DEGRADED"
                    || upper == "LOCAL_ONLY_NO_DNS"
                    || upper == "ABORTED_LOW_BATTERY"
                    || upper == "AC_CONNECTED"
                    || upper == "INSUFFICIENT_SAMPLES");
            let fill = if is_fail {
                "#09090b"
            } else if is_neutral_warn {
                "#3f3f46"
            } else {
                "#2563eb"
            };
            items.push_str(&format!(
                r#"<div class="bar-row">
                  <div class="bar-top">
                    <strong>{}</strong>
                    <span class="mono muted">{}</span>
                    <span class="mono badge-inline" style="color:{}">{}</span>
                  </div>
                  <div class="track"><div class="fill" style="width:{:.0}%;background:{}"></div></div>
                </div>"#,
                html_escape(&b.label),
                html_escape(&b.metric_text),
                fill,
                html_escape(&b.status_label),
                pct.max(3.0),
                fill
            ));
        }
        format!(
            r#"<section class="sec">
          <div class="sec-title">02 // SUBSYSTEM HEALTH &amp; PERFORMANCE CALIBRATION</div>
          <div class="bars">{}</div>
        </section>"#,
            items
        )
    };

    let ub_html = if let Some(ub) = &payload.user_benchmark {
        let mut comp_cards = String::new();
        for comp in [&ub.cpu, &ub.gpu, &ub.ssd, &ub.ram].into_iter().flatten() {
            let flag_html = comp
                .bottleneck_flag
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|f| format!(r#"<div class="ub-flag mono">Bottleneck: {}</div>"#, html_escape(f)))
                .unwrap_or_default();
            comp_cards.push_str(&format!(
                r#"<div class="ub-card">
                  <div class="ub-card-head">
                    <strong class="mono">{} — {}</strong>
                    <span class="stamp {}">{}</span>
                  </div>
                  <div class="ub-model">{}</div>
                  <div class="ub-nums mono">Effective {:.1}% vs Class {:.1}% &bull; Standing {:.0}% ({})</div>
                  <div class="ub-summary">{}</div>
                  {}
                </div>"#,
                html_escape(&comp.component.to_uppercase()),
                html_escape(&comp.vehicle_tier),
                if comp.standing_label == "Underperforming" { "st-fail" } else if comp.standing_label == "Below Expectations" { "st-warn" } else { "st-pass" },
                html_escape(&comp.standing_label),
                html_escape(&comp.detected_model),
                comp.effective_speed_pct,
                comp.expected_class_pct,
                comp.relative_standing_pct,
                html_escape(&comp.standing_label),
                html_escape(&comp.plain_summary),
                flag_html
            ));
        }
        let recs_html = if ub.recommendations.is_empty() {
            String::new()
        } else {
            let items = ub
                .recommendations
                .iter()
                .map(|r| format!("<li>{}</li>", html_escape(r)))
                .collect::<Vec<_>>()
                .join("");
            format!(r#"<ul class="meaning-list" style="margin-top:8px">{}</ul>"#, items)
        };
        format!(
            r#"<section class="sec">
          <div class="sec-title">03 // USERBENCHMARK COMPARISON &amp; VEHICLE TIER STANDINGS</div>
          <div class="ub-shell">
            <div class="ub-top">
              <div>
                <span class="stamp st-pass">OVERALL TIER: {}</span>
                <span class="mono muted" style="margin-left:8px;font-size:10px">SOURCE: {}</span>
              </div>
              <div class="mono" style="font-size:11px">
                Gaming <strong>{:.1}%</strong> &bull; Desktop <strong>{:.1}%</strong> &bull; Workstation <strong>{:.1}%</strong>
              </div>
            </div>
            <div class="ub-headline">{}</div>
            <div class="ub-grid">{}</div>
            {}
          </div>
        </section>"#,
            html_escape(&ub.overall_vehicle_tier),
            html_escape(&ub.source_mode),
            ub.gaming_pct,
            ub.desktop_pct,
            ub.workstation_pct,
            html_escape(&ub.headline_summary),
            comp_cards,
            recs_html
        )
    } else {
        String::new()
    };

    let reliability_html = if payload.battery_discharge.is_some()
        || payload.touchscreen.is_some()
        || payload.network_report.is_some()
    {
        let mut cards = String::new();
        if let Some(bat) = &payload.battery_discharge {
            let cls = if bat.verdict == "ABNORMAL" {
                "st-fail"
            } else if bat.verdict == "NORMAL" {
                "st-pass"
            } else {
                "st-warn"
            };
            let reasons_html = if bat.reasons.is_empty() {
                String::new()
            } else {
                format!(
                    r#"<div class="rel-sub mono">Reasons: {}</div>"#,
                    html_escape(&bat.reasons.join("; "))
                )
            };
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">BATTERY DISCHARGE NORMALITY</strong>
                    <span class="stamp {}">{}</span>
                  </div>
                  <div class="rel-metrics mono">
                    Idle {:.1}W / Load {:.1}W &bull; Power CV {:.1}% &bull; Sag {:.0}mV &bull;
                    SoC {:.1}% &rarr; {:.1}% (Max 5s Drop {:.1}%) &bull; BMS Drift {:.2}x &bull;
                    Wear {:.1}% ({} cycles)
                  </div>
                  <div class="ub-summary">{}</div>
                  {}
                </div>"#,
                cls,
                html_escape(&bat.verdict),
                bat.idle_avg_watts,
                bat.load_avg_watts,
                bat.power_cv_pct,
                bat.voltage_sag_mv,
                bat.soc_start_pct,
                bat.soc_end_pct,
                bat.max_step_drop_pct,
                bat.bms_drift_ratio,
                bat.wear_pct,
                bat.cycle_count,
                html_escape(&bat.plain_summary),
                reasons_html
            ));
        }
        if let Some(dp) = &payload.display_pro {
            let px_total = dp.dead_pixels.saturating_add(dp.stuck_pixels);
            let hinge_drop = dp
                .hinge_flex
                .as_ref()
                .map(|h| h.verdict == "EDP_DROP_DETECTED")
                .unwrap_or(false);
            let cls = if hinge_drop || px_total >= 3 || dp.bleed_severity == "severe" || dp.flicker_or_ghosting {
                "st-fail"
            } else if dp.max_hz_mismatch || px_total > 0 || dp.bleed_severity == "minor" || dp.pressure_spots {
                "st-warn"
            } else {
                "st-pass"
            };
            let badge_txt = if cls == "st-fail" {
                "DEFECT"
            } else if cls == "st-warn" {
                "ADVISORY"
            } else {
                "VERIFIED"
            };
            let hinge_txt = dp
                .hinge_flex
                .as_ref()
                .map(|h| h.verdict.as_str())
                .unwrap_or("Not Run");
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">DISPLAY PRO &amp; eDP HINGE-FLEX</strong>
                    <span class="badge {cls}">{badge}</span>
                  </div>
                  <div class="rel-metrics mono">
                    <span>Active / Max: <strong>{ahz} / {mhz} Hz</strong></span>
                    <span>Measured: <strong>{meas} Hz</strong></span>
                    <span>Jitter: <strong>{jit:.1} ms ({drops} drops)</strong></span>
                    <span>Pixels: <strong>{px} defect(s)</strong></span>
                    <span>Bleed: <strong>{bleed}</strong></span>
                    <span>eDP Hinge: <strong>{hinge}</strong></span>
                  </div>
                  <p class="rel-summary">{summary}</p>
                </div>"#,
                cls = cls,
                badge = badge_txt,
                ahz = dp.active_hz,
                mhz = dp.native_max_hz,
                meas = dp.measured_hz,
                jit = dp.frame_jitter_ms,
                drops = dp.dropped_frames,
                px = px_total,
                bleed = html_escape(&dp.bleed_severity),
                hinge = html_escape(hinge_txt),
                summary = html_escape(&dp.plain_summary),
            ));
        }

        if let Some(ts) = &payload.touchscreen {
            let cls = match ts.verdict.as_str() {
                "PASS" => "st-pass",
                "FAIL" => "st-fail",
                "SKIPPED" => "st-skip",
                _ => "st-warn",
            };
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">TOUCHSCREEN DISPLAY DIGITIZER</strong>
                    <span class="stamp {}">{}</span>
                  </div>
                  <div class="rel-metrics mono">
                    Capable: {} (Reported {} pts) &bull; {}x{} Grid: {}/{} ({:.1}%) &bull;
                    Multi-Touch: {} pts &bull; Linearity RMS: {:.2}px &bull; Polling: {:.0} Hz
                  </div>
                  <div class="ub-summary">{}</div>
                </div>"#,
                cls,
                html_escape(&ts.verdict),
                if ts.touch_capable { "Yes" } else { "No" },
                ts.max_touch_points_reported,
                ts.grid_cols,
                ts.grid_rows,
                ts.covered_cells,
                ts.total_cells,
                ts.coverage_pct,
                ts.max_simultaneous_touches,
                ts.swipe_linearity_rms_px,
                ts.polling_hz,
                html_escape(&ts.plain_summary)
            ));
        }
        if let Some(slp) = &payload.sleep_audit {
            let cls = match slp.verdict.as_str() {
                "HEALTHY" => "st-pass",
                "SLEEP_FAULT" => "st-fail",
                _ => "st-warn",
            };
            let drain_txt = slp
                .max_drain_pct_per_hr
                .or(slp.avg_drain_pct_per_hr)
                .map(|d| format!("{:.1}%/hr", d))
                .unwrap_or_else(|| "N/A".into());
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">SLEEP &amp; MODERN STANDBY AUDIT</strong>
                    <span class="badge {cls}">{verdict}</span>
                  </div>
                  <div class="rel-metrics mono">
                    <span>Mode: <strong>{mode}</strong></span>
                    <span>Max Drain: <strong>{drain}</strong></span>
                    <span>Wake-Armed: <strong>{wakes}</strong></span>
                    <span>Sleep Crashes: <strong>{crashes}</strong></span>
                  </div>
                  <p class="rel-summary">{summary}</p>
                </div>"#,
                cls = cls,
                verdict = html_escape(&slp.verdict),
                mode = html_escape(&slp.sleep_mode),
                drain = drain_txt,
                wakes = slp.wake_armed_devices.len(),
                crashes = slp.sleep_crash_count,
                summary = html_escape(&slp.plain_summary),
            ));
        }

        if let Some(rem) = &payload.removable_drive_bench {
            let cls = if rem.status == TestStatus::Pass { "st-pass" } else { "st-warn" };
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">USB / SD-CARD REAL SPEED TEST</strong>
                    <span class="badge {cls}">{verdict}</span>
                  </div>
                  <div class="rel-metrics mono">
                    <span>Drive: <strong>{lbl} ({mnt})</strong></span>
                    <span>Seq Read: <strong>{rd:.1} MB/s</strong></span>
                    <span>Seq Write: <strong>{wr:.1} MB/s</strong></span>
                  </div>
                  <p class="rel-summary">{summary}</p>
                </div>"#,
                cls = cls,
                verdict = html_escape(&rem.verdict),
                lbl = html_escape(&rem.label),
                mnt = html_escape(&rem.mount_path),
                rd = rem.seq_read_mb_s,
                wr = rem.seq_write_mb_s,
                summary = html_escape(&rem.plain_summary),
            ));
        }

        if let Some(net) = &payload.network_report {
            let cls = match net.verdict.as_str() {
                "HEALTHY" => "st-pass",
                "POOR_LINK" => "st-fail",
                _ => "st-warn",
            };
            let link_s = net
                .link_speed_mbps
                .map(|m| format!("{:.0} Mbps", m))
                .unwrap_or_else(|| "N/A".into());
            let wifi_s = match (net.wifi_ssid.as_deref(), net.wifi_signal_pct, net.rssi_dbm) {
                (Some(ssid), Some(pct), Some(rssi)) => format!("{} ({}% / {} dBm)", ssid, pct, rssi),
                (Some(ssid), Some(pct), None) => format!("{} ({}%)", ssid, pct),
                _ => "Wired / N/A".into(),
            };
            let ping_s = net
                .gateway_ping_ms
                .map(|p| format!("{:.1} ms", p))
                .unwrap_or_else(|| "N/A".into());
            cards.push_str(&format!(
                r#"<div class="rel-card">
                  <div class="ub-card-head">
                    <strong class="mono">NETWORK &amp; WI-FI DIAGNOSTICS</strong>
                    <span class="stamp {}">{}</span>
                  </div>
                  <div class="rel-metrics mono">
                    Interface: {} &bull; Link: {} &bull; Wi-Fi: {} &bull;
                    Gateway Ping: {} &bull; Loss: {:.0}% &bull; DNS: {}
                  </div>
                  <div class="ub-summary">{}</div>
                </div>"#,
                cls,
                html_escape(&net.verdict),
                html_escape(&net.interface_name),
                html_escape(&link_s),
                html_escape(&wifi_s),
                html_escape(&ping_s),
                net.packet_loss_pct,
                if net.dns_resolve_ok { "OK" } else { "FAIL" },
                html_escape(&net.plain_summary)
            ));
        }
        format!(
            r#"<section class="sec">
          <div class="sec-title">04 // BATTERY DISCHARGE NORMALITY, TOUCHSCREEN &amp; NETWORK RELIABILITY</div>
          <div class="rel-stack">{}</div>
        </section>"#,
            cards
        )
    } else {
        String::new()
    };

    let mut rows_html = String::new();
    for t in &payload.tests {
        let (lbl, cls) = match t.status {
            TestStatus::Pass => ("PASS", "st-pass"),
            TestStatus::Warn => ("WARN", "st-warn"),
            TestStatus::Fail => ("FAIL", "st-fail"),
            TestStatus::Skipped => ("SKIP", "st-skip"),
            TestStatus::NotApplicable => ("N/A", "st-na"),
            TestStatus::Running => ("RUN", "st-pass"),
            TestStatus::Pending => ("WAIT", "st-na"),
        };
        let metrics_html = if t.metrics.is_empty() {
            String::new()
        } else {
            let chips = t
                .metrics
                .iter()
                .map(|(k, v)| {
                    format!(
                        r#"<span class="m-chip"><em>{}</em> {}</span>"#,
                        html_escape(k),
                        html_escape(v)
                    )
                })
                .collect::<Vec<_>>()
                .join("");
            format!(r#"<div class="m-row mono">{}</div>"#, chips)
        };
        let note_html = if t.notes.trim().is_empty() {
            String::new()
        } else {
            format!(r#"<div class="note">Note: {}</div>"#, html_escape(t.notes.trim()))
        };
        rows_html.push_str(&format!(
            r#"<tr>
              <td><strong>{}</strong><div class="cat">{}</div></td>
              <td><span class="stamp {}">{}</span></td>
              <td>{}{}{}</td>
            </tr>"#,
            html_escape(&t.name),
            html_escape(&t.category),
            cls,
            lbl,
            html_escape(&t.summary),
            metrics_html,
            note_html
        ));
    }

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Hardware Calibration Certificate — {shop_esc}</title>
<style>
  @page {{ size: A4; margin: 12mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px; background: #f4f4f5; color: #09090b; -webkit-font-smoothing: antialiased; }}
  .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }}
  .muted {{ color: #52525b; }}
  .sheet {{ max-width: 880px; margin: 0 auto 24px; background: #fff; border: 1px solid #d4d4d8; border-top: 4px solid #2563eb; }}
  .sheet-body {{ padding: 24px 28px; }}
  .masthead {{ display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; padding-bottom: 16px; border-bottom: 1.5px solid #09090b; }}
  .brand {{ display: flex; align-items: center; gap: 14px; }}
  .logo {{ max-height: 48px; max-width: 110px; object-fit: contain; border: 1px solid #d4d4d8; padding: 3px; }}
  .eyebrow {{ font-size: 10px; font-weight: 800; letter-spacing: .14em; color: #1d4ed8; text-transform: uppercase; }}
  .masthead h1 {{ margin: 3px 0 4px; font-size: 22px; font-weight: 900; letter-spacing: -.02em; }}
  .meta {{ font-size: 11px; color: #52525b; }}
  .seal {{ background: {seal_bg}; color: #fff; padding: 10px 16px; min-width: 175px; text-align: left; }}
  .seal .s-top {{ font-size: 9px; letter-spacing: .14em; opacity: .85; text-transform: uppercase; font-weight: 700; }}
  .seal .s-verdict {{ font-size: 15px; font-weight: 900; margin: 2px 0; }}
  .seal .s-grade {{ font-size: 11px; color: #dbeafe; font-weight: 700; }}
  .kpis {{ display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #d4d4d8; border-top: none; background: #f8fafc; margin-bottom: 18px; }}
  .kpi {{ padding: 10px 14px; border-right: 1px solid #d4d4d8; }}
  .kpi:last-child {{ border-right: none; }}
  .kpi span {{ display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: .1em; color: #52525b; font-weight: 700; }}
  .kpi strong {{ font-size: 18px; font-weight: 900; }}
  .sec {{ margin-bottom: 18px; }}
  .sec-title {{ font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; font-weight: 800; letter-spacing: .12em; padding-bottom: 5px; border-bottom: 1px solid #09090b; margin-bottom: 10px; }}
  .meaning-box {{ border: 1px solid #d4d4d8; border-left: 3px solid #2563eb; background: #f8fafc; padding: 11px 14px; }}
  .meaning-head {{ font-size: 12.5px; font-weight: 700; color: #09090b; margin-bottom: 6px; }}
  .meaning-list {{ margin: 0; padding-left: 18px; font-size: 11.5px; color: #52525b; line-height: 1.45; }}
  .meaning-list li {{ margin-bottom: 3px; }}
  .spec-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); border: 1px solid #d4d4d8; }}
  .spec-grid > div {{ padding: 7px 10px; border-bottom: 1px solid #e4e4e7; border-right: 1px solid #e4e4e7; }}
  .spec-grid > div:nth-child(even) {{ border-right: none; }}
  .spec-grid span {{ display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: #71717a; font-family: ui-monospace, Consolas, monospace; }}
  .spec-grid strong {{ font-size: 12px; color: #09090b; }}
  .spec-note {{ border: 1px solid #d4d4d8; border-top: none; background: #f8fafc; padding: 7px 10px; font-size: 10.5px; color: #52525b; }}
  .bars {{ border: 1px solid #d4d4d8; }}
  .bar-row {{ padding: 8px 12px; border-bottom: 1px solid #e4e4e7; }}
  .bar-row:last-child {{ border-bottom: none; }}
  .bar-top {{ display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11.5px; margin-bottom: 5px; }}
  .badge-inline {{ font-size: 10px; font-weight: 800; }}
  .track {{ height: 6px; background: #e4e4e7; }}
  .fill {{ height: 100%; }}
  .ub-shell {{ border: 1px solid #d4d4d8; background: #f8fafc; padding: 12px; }}
  .ub-top {{ display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }}
  .ub-headline {{ font-size: 12px; color: #09090b; font-weight: 600; margin-bottom: 10px; }}
  .ub-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }}
  .ub-card {{ border: 1px solid #d4d4d8; background: #fff; padding: 9px 10px; }}
  .ub-card-head {{ display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 4px; }}
  .ub-model {{ font-size: 11.5px; font-weight: 700; color: #09090b; margin-bottom: 2px; }}
  .ub-nums {{ font-size: 10px; color: #1d4ed8; margin-bottom: 4px; }}
  .ub-summary {{ font-size: 11px; color: #52525b; line-height: 1.4; }}
  .ub-flag {{ margin-top: 4px; font-size: 10px; font-weight: 700; color: #09090b; border-left: 2px solid #09090b; padding-left: 6px; }}
  .rel-stack {{ display: grid; grid-template-columns: 1fr; gap: 8px; }}
  .rel-card {{ border: 1px solid #d4d4d8; background: #f8fafc; padding: 10px 12px; }}
  .rel-metrics {{ font-size: 10.5px; color: #1d4ed8; margin: 4px 0; }}
  .rel-sub {{ font-size: 10px; color: #09090b; margin-top: 4px; }}
  .sign-box {{ border: 1px solid #d4d4d8; background: #f8fafc; padding: 12px 14px; font-size: 11.5px; display: flex; justify-content: space-between; align-items: stretch; gap: 18px; }}
  .sign-left {{ flex: 1; display: flex; flex-direction: column; justify-content: space-between; }}
  .qr-wrap {{ width: 102px; shrink: 0; text-align: center; }}
  .qr-svg {{ width: 96px; height: 96px; border: 1px solid #09090b; display: block; margin: 0 auto; }}
  .qr-cap {{ font-size: 8px; letter-spacing: .08em; color: #52525b; margin-top: 4px; font-weight: 700; }}
  .m-row {{ display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }}
  .m-chip {{ font-size: 10px; border: 1px solid #d4d4d8; background: #fff; padding: 1px 6px; }}
  .m-chip em {{ font-style: normal; color: #1d4ed8; font-weight: 700; margin-right: 3px; }}
  .sig-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 22px; }}
  .sig-line {{ border-top: 1px solid #09090b; padding-top: 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid #d4d4d8; }}
  th {{ text-align: left; font-family: ui-monospace, Consolas, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #fff; background: #09090b; padding: 8px 10px; }}
  td {{ padding: 8px 10px; border-bottom: 1px solid #e4e4e7; vertical-align: top; }}
  tbody tr:nth-child(even) {{ background: #f8fafc; }}
  .cat {{ font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: #71717a; font-family: ui-monospace, Consolas, monospace; margin-top: 2px; }}
  .note {{ font-size: 11px; color: #52525b; margin-top: 3px; font-style: italic; }}
  .stamp {{ display: inline-block; font-family: ui-monospace, Consolas, monospace; font-size: 10px; font-weight: 800; padding: 2px 7px; border: 1px solid; letter-spacing: .08em; }}
  .st-pass {{ background: #2563eb; color: #fff; border-color: #2563eb; }}
  .st-warn {{ background: #fff; color: #1d4ed8; border-color: #2563eb; }}
  .st-fail {{ background: #09090b; color: #fff; border-color: #09090b; }}
  .st-skip {{ background: #fff; color: #52525b; border-color: #a1a1aa; border-style: dashed; }}
  .st-na {{ background: #f4f4f5; color: #71717a; border-color: #d4d4d8; }}
  footer {{ padding: 10px 28px; background: #f8fafc; border-top: 1px solid #d4d4d8; font-size: 10px; color: #52525b; display: flex; justify-content: space-between; }}
  .page-break {{ page-break-before: always; }}
  @media print {{ body {{ background: #fff; padding: 0; }} .sheet {{ border: none; max-width: 100%; margin: 0; }} }}
</style>
</head>
<body>
<div class="sheet">
  <div class="sheet-body">
    <div class="masthead">
      <div class="brand">
        {logo_html}
        <div>
          <div class="eyebrow mono">Official Hardware Calibration &amp; Quality Control Certificate</div>
          <h1>{shop_esc}</h1>
          <div class="meta mono">ISSUED: {gen_esc} &bull; CERT ID: <strong>{cert_id}</strong> {sku_html}</div>
        </div>
      </div>
      <div class="seal mono">
        <div class="s-top">Certified Verdict</div>
        <div class="s-verdict">{verdict_esc}</div>
        <div class="s-grade">DURABILITY GRADE: {grade_esc}</div>
      </div>
    </div>

    <div class="kpis mono">
      <div class="kpi"><span>Passed</span><strong style="color:#2563eb">{pass_c:02}</strong></div>
      <div class="kpi"><span>Warnings</span><strong>{warn_c:02}</strong></div>
      <div class="kpi"><span>Failures</span><strong>{fail_c:02}</strong></div>
      <div class="kpi"><span>Skipped / N/A</span><strong class="muted">{skip_c:02}</strong></div>
    </div>

    {long_term_html}
    {specs_html}
    {bars_html}
    {ub_html}
    {reliability_html}
    {cosmetic_html}

    <section class="sec">
      <div class="sec-title">05 // PHYSICAL SIGN-OFF, OFFLINE QR VERIFICATION &amp; AUTHORIZATION</div>
      <div class="sign-box">
        <div class="sign-left">
          <div>
            <div class="mono"><strong>PHYSICAL PORTS (USB/HDMI/DC/JACK):</strong> {ports_ok} {ports_notes}</div>
            <div class="mono" style="margin-top:4px"><strong>STEREO SPEAKERS (L/R CLARITY):</strong> {spk_ok} {spk_notes}</div>
            <div style="margin-top:8px"><strong>Technician Notes:</strong> {notes_esc}</div>
          </div>
          <div class="sig-grid mono">
            <div class="sig-line">Technician: {tech_esc} ({shop_esc})</div>
            <div class="sig-line">Customer / Buyer Acceptance &amp; Date</div>
          </div>
        </div>
        <div class="qr-wrap mono">
          {qr_svg}
          <div class="qr-cap">OFFLINE QR SEAL</div>
        </div>
      </div>
    </section>
  </div>
  <footer class="mono">
    <span>LaptopBench QC v3.0.0 &bull; Created by Hein Htet Zaw • Telegram: @ich8g92</span>
    <span>Tamper-Check ID: {cert_id}</span>
  </footer>
</div>

<div class="sheet page-break" style="border-top-color:#09090b">
  <div class="sheet-body">
    <div class="sec-title" style="font-size:12px">APPENDIX A // {stage_count}-STAGE TECHNICAL DIAGNOSTIC AUDIT LEDGER</div>
    <table>
      <thead><tr><th style="width:28%">Stage &amp; Module</th><th style="width:12%">Status</th><th>Measured Findings, Thresholds &amp; Notes</th></tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
  </div>
  <footer class="mono">
    <span>LaptopBench QC v3.0.0 &bull; Created by Hein Htet Zaw • Telegram: @ich8g92</span>
    <span>Cert ID: {cert_id}</span>
  </footer>
</div>
</body>
</html>"#,
        shop_esc = html_escape(shop),
        gen_esc = html_escape(generated_at),
        cert_id = cert_id,
        sku_html = if payload.customer_or_sku.trim().is_empty() {
            String::new()
        } else {
            format!("&bull; REF/SKU: <strong>{}</strong>", html_escape(payload.customer_or_sku.trim()))
        },
        seal_bg = seal_bg,
        verdict_esc = html_escape(&payload.overall_verdict),
        grade_esc = html_escape(grade),
        pass_c = pass_c,
        warn_c = warn_c,
        fail_c = fail_c,
        skip_c = skip_c,
        logo_html = logo_html,
        long_term_html = long_term_html,
        specs_html = specs_html,
        bars_html = bars_html,
        ub_html = ub_html,
        reliability_html = reliability_html,
        cosmetic_html = if let Some(cos) = &payload.cosmetic {
            let mut pills = Vec::new();
            for (lbl, ok) in [
                ("Chassis / Lid", cos.chassis_ok),
                ("Screen Coating", cos.screen_coating_ok),
                ("Hinges", cos.hinges_ok),
                ("Palmrest / Keys", cos.palmrest_ok),
                ("Screws / Seals", cos.screws_seals_ok),
                ("OEM Charger", cos.oem_charger_included),
            ] {
                let st = if ok { "OK" } else { "NOTE" };
                let bg = if ok { "#eff6ff;border-color:#2563eb;color:#1d4ed8" } else { "#f4f4f5;border-color:#09090b;color:#09090b" };
                pills.push(format!(
                    "<span class='mono' style='display:inline-block;padding:3px 7px;margin:2px 4px 2px 0;font-size:10px;font-weight:700;border:1px solid;background:{}'>{}: {}</span>",
                    bg, lbl, st
                ));
            }
            let photos_html = if cos.photos.is_empty() {
                String::new()
            } else {
                let imgs: String = cos
                    .photos
                    .iter()
                    .take(4)
                    .map(|p| {
                        format!(
                            "<div style='border:1px solid #d4d4d8;padding:4px;background:#fff'><img src='{}' alt='{}' style='width:100%;height:110px;object-fit:cover;display:block'/><div class='mono' style='font-size:9px;color:#52525b;margin-top:3px'>{}</div></div>",
                            html_escape(&p.data_url),
                            html_escape(&p.label),
                            html_escape(&p.label)
                        )
                    })
                    .collect();
                format!(
                    "<div style='display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px'>{}</div>",
                    imgs
                )
            };
            let notes_line = if cos.notes.trim().is_empty() {
                String::new()
            } else {
                format!(
                    "<div style='font-size:11px;color:#3f3f46;margin-top:6px'><strong>Cosmetic Notes:</strong> {}</div>",
                    html_escape(cos.notes.trim())
                )
            };
            format!(
                "<section class='sec'><div class='sec-title'>PHYSICAL &amp; COSMETIC INSPECTION — GRADE {}</div><div style='border:1px solid #d4d4d8;background:#f8fafc;padding:10px 12px'><div>{}</div>{}{}</div></section>",
                html_escape(&cos.grade.to_uppercase()),
                pills.join(""),
                notes_line,
                photos_html
            )
        } else {
            String::new()
        },
        ports_ok = if payload.signoff.ports_checked { "[VERIFIED]" } else { "[NOT CONFIRMED]" },
        ports_notes = html_escape(&payload.signoff.ports_notes),
        spk_ok = if payload.signoff.speakers_checked { "[VERIFIED]" } else { "[NOT CONFIRMED]" },
        spk_notes = html_escape(&payload.signoff.speakers_notes),
        notes_esc = if payload.technician_notes.trim().is_empty() {
            format!("Unit inspected per {}-stage LaptopBench QC v3.0.0 protocol.", stage_count)
        } else {
            html_escape(payload.technician_notes.trim())
        },
        tech_esc = html_escape(tech),
        qr_svg = qr_svg,
        stage_count = stage_count,
        rows_html = rows_html,
    )
}

pub fn export_qc_report_files(payload: &ExportReportPayload) -> Result<ExportedReportPaths, String> {
    let now = Local::now();
    let generated_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let stamp = now.format("%Y%m%d_%H%M%S").to_string();
    let cert_id = compute_certificate_id(payload, &generated_at);

    let serial = payload
        .specs
        .as_ref()
        .map(|s| sanitize_filename(&s.serial_number))
        .unwrap_or_else(|| "LAPTOP".to_string());

    let base_dir = payload
        .output_dir
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            payload
                .shop_profile
                .default_output_dir
                .as_deref()
                .filter(|p| !p.trim().is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_else(|| std::env::temp_dir())
                .join("LaptopBenchQC")
                .join("Reports")
        });

    let report_folder = base_dir.join(format!("QC_{}_{}", serial, stamp));
    fs::create_dir_all(&report_folder)
        .map_err(|e| format!("Failed to create report directory: {}", e))?;

    let stem = format!("QC_Certificate_{}_{}", serial, stamp);
    let pdf_path = report_folder.join(format!("{}.pdf", stem));
    let html_path = report_folder.join(format!("{}.html", stem));
    let json_path = report_folder.join(format!("{}.json", stem));

    let pdf_bytes = render_qc_certificate_pdf(payload, &generated_at);
    fs::write(&pdf_path, pdf_bytes).map_err(|e| format!("Failed to write PDF: {}", e))?;

    let html_str = render_qc_html(payload, &generated_at);
    fs::write(&html_path, html_str).map_err(|e| format!("Failed to write HTML: {}", e))?;

    let json_val = serde_json::json!({
        "certificateId": cert_id,
        "generatedAt": generated_at,
        "version": "3.0.0",
        "report": payload
    });
    let json_str = serde_json::to_string_pretty(&json_val).map_err(|e| e.to_string())?;
    fs::write(&json_path, json_str).map_err(|e| format!("Failed to write JSON: {}", e))?;

    Ok(ExportedReportPaths {
        directory: report_folder.to_string_lossy().to_string(),
        pdf_path: pdf_path.to_string_lossy().to_string(),
        html_path: html_path.to_string_lossy().to_string(),
        json_path: json_path.to_string_lossy().to_string(),
        generated_at,
    })
}

pub fn export_qc_report(
    app: &AppHandle,
    payload: &ExportReportPayload,
) -> Result<ExportedReportPaths, String> {
    let _ = save_shop_profile(app, &payload.shop_profile);
    let paths = export_qc_report_files(payload)?;
    let cert_id = compute_certificate_id(payload, &paths.generated_at);
    crate::modules::qc_archive::record_exported_qc(app, payload, &paths, &cert_id);
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        BatteryDischargeResult, NetworkDiagnosticsReport, PortsSpeakerSignoff, ReportTestEntry,
        ShopProfile, SubsystemScoreBar, SystemSpecs, TouchscreenTestResult,
        UserBenchmarkComparison, UserBenchmarkComponentRating,
    };

    struct TempDirGuard(PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_v230_payload(output_dir: Option<String>, battery_verdict: &str) -> ExportReportPayload {
        ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss Lab QC".into(),
                technician_name: "Hein Htet Zaw".into(),
                logo_data_url: None,
                default_output_dir: None,
            },
            customer_or_sku: "SKU-V230-01".into(),
            technician_notes: String::new(),
            overall_verdict: if battery_verdict == "ABNORMAL" {
                "PASSED WITH WARNINGS".into()
            } else {
                "PASSED".into()
            },
            durability_grade: Some("A".into()),
            plain_verdict_summary: Some("Verified across all 14 stages for long-term reliability.".into()),
            subsystem_scores: vec![
                SubsystemScoreBar {
                    label: "Battery Health & Discharge".into(),
                    score_pct: if battery_verdict == "ABNORMAL" { 45.0 } else { 91.0 },
                    metric_text: format!("91.0% capacity • Discharge {}", battery_verdict),
                    status_label: battery_verdict.into(),
                },
                SubsystemScoreBar {
                    label: "SSD Direct-IO".into(),
                    score_pct: 96.0,
                    metric_text: "R 3500 / W 3000 MB/s • Budget 256 MB".into(),
                    status_label: "NORMAL".into(),
                },
            ],
            specs: Some(SystemSpecs {
                manufacturer: "Lenovo".into(),
                model: "ThinkPad X1".into(),
                chassis_type: "Notebook".into(),
                serial_number: "SN-998877".into(),
                cpu_brand: "Intel Core i7-1365U".into(),
                cpu_physical_cores: 10,
                cpu_logical_cores: 12,
                bios_version: "N3AET81W".into(),
                total_ram_gb: 16.0,
                os_name: "Windows 11 Pro".into(),
                os_version: "24H2".into(),
                architecture: "x86_64".into(),
                ram_channel_mode: Some("Dual Channel".into()),
                ram_config_warning: Some("Soldered LPDDR5 — not upgradable.".into()),
                wifi_ssid: Some("QC-Lab-5G".into()),
                wifi_signal_pct: Some(92),
                wifi_rssi_dbm: Some(-51),
                reliability_notes: vec!["NVMe spare 100%, 0 unsafe shutdowns.".into()],
                plain_summary: "Business ultrabook in clean condition.".into(),
                ..Default::default()
            }),
            user_benchmark: Some(UserBenchmarkComparison {
                gaming_pct: 48.0,
                desktop_pct: 94.0,
                workstation_pct: 79.0,
                overall_vehicle_tier: "Aircraft Carrier".into(),
                headline_summary: "Strong office and workstation performance.".into(),
                source_mode: "offline_calibrated".into(),
                recommendations: vec!["Ideal for productivity and travel.".into()],
                cpu: Some(UserBenchmarkComponentRating {
                    component: "cpu".into(),
                    detected_model: "Intel Core i7-1365U".into(),
                    effective_speed_pct: 94.0,
                    expected_class_pct: 90.0,
                    relative_standing_pct: 104.4,
                    vehicle_tier: "Nuclear Submarine".into(),
                    standing_label: "As Expected".into(),
                    plain_summary: "Healthy single and multi-core throughput.".into(),
                    source_mode: "offline_calibrated".into(),
                    sub_metrics: vec![],
                    bottleneck_flag: None,
                }),
                ..Default::default()
            }),
            battery_discharge: Some(BatteryDischargeResult {
                status: if battery_verdict == "ABNORMAL" {
                    TestStatus::Warn
                } else {
                    TestStatus::Pass
                },
                verdict: battery_verdict.into(),
                plain_summary: if battery_verdict == "ABNORMAL" {
                    "High power variance and SoC step drop detected.".into()
                } else {
                    "Smooth discharge curve with low sag.".into()
                },
                reasons: if battery_verdict == "ABNORMAL" {
                    vec!["SoC cliff >= 3%/5s".into()]
                } else {
                    vec![]
                },
                idle_avg_watts: 6.2,
                load_avg_watts: 25.0,
                power_cv_pct: if battery_verdict == "ABNORMAL" { 42.0 } else { 8.0 },
                voltage_sag_mv: 220.0,
                soc_start_pct: 84.0,
                soc_end_pct: 82.5,
                max_step_drop_pct: if battery_verdict == "ABNORMAL" { 4.0 } else { 0.8 },
                wear_pct: 9.0,
                cycle_count: 35,
                bms_drift_ratio: 1.02,
                duration_secs: 55.0,
                samples: vec![],
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
                swipe_linearity_rms_px: 1.2,
                max_linearity_error_px: Some(2.8),
                polling_hz: 120.0,
                tap_latency_ms: Some(8.0),
                status: TestStatus::Pass,
                verdict: "PASS".into(),
                plain_summary: "All 160 cells and 10-point multi-touch verified.".into(),
            }),
            network_report: Some(NetworkDiagnosticsReport {
                status: TestStatus::Pass,
                interface_name: "Intel Wi-Fi 6E AX211".into(),
                link_speed_mbps: Some(1200.0),
                wifi_ssid: Some("QC-Lab-5G".into()),
                wifi_signal_pct: Some(92),
                rssi_dbm: Some(-51),
                gateway_ping_ms: Some(2.4),
                dns_resolve_ok: true,
                packet_loss_pct: 0.0,
                verdict: "HEALTHY".into(),
                plain_summary: "Low-latency Wi-Fi 6E link with zero packet loss.".into(),
                ..Default::default()
            }),
            cpu_stress: None,
            battery_charge: None,
            cosmetic: None,
            hardware_faults: None,
            display_pro: None,
            sleep_audit: None,
            removable_drive_bench: None,
            tests: (1..=14)
                .map(|i| ReportTestEntry {
                    id: format!("stage_{}", i),
                    name: format!("{:02}. Stage {}", i, i),
                    category: "Diagnostic".into(),
                    status: TestStatus::Pass,
                    summary: format!("Stage {} verified within safe bounds.", i),
                    metrics: vec![("Check".into(), "OK".into())],
                    notes: String::new(),
                })
                .collect(),
            signoff: PortsSpeakerSignoff {
                ports_checked: true,
                ports_notes: "USB-C / HDMI OK".into(),
                speakers_checked: true,
                speakers_notes: "Stereo L/R OK".into(),
            },
            output_dir,
        }
    }

    #[test]
    fn test_render_qc_html_v230_palette_attribution_and_sections() {
        let payload = sample_v230_payload(None, "ABNORMAL");
        let html = render_qc_html(&payload, "2026-11-26 10:00:00");

        assert!(html.contains("LaptopBench QC v3.0.0"));
        assert!(html.contains("Created by Hein Htet Zaw"));
        assert!(html.contains("@ich8g92"));
        assert!(html.contains("14-STAGE TECHNICAL DIAGNOSTIC AUDIT LEDGER"));
        assert!(html.contains("WHAT THIS MEANS FOR LONG-TERM USE"));
        assert!(html.contains("USERBENCHMARK COMPARISON"));
        assert!(html.contains("BATTERY DISCHARGE NORMALITY"));
        assert!(html.contains("ABNORMAL"));
        assert!(html.contains("TOUCHSCREEN DISPLAY DIGITIZER"));
        assert!(html.contains("NETWORK &amp; WI-FI DIAGNOSTICS"));
        assert!(html.contains("Dual Channel"));
        assert!(html.contains("Soldered LPDDR5"));

        // Must NOT contain stale v2.1 / 13-stage or any rainbow colors
        assert!(!html.contains("v2.1."));
        assert!(!html.to_lowercase().contains("13-stage"));
        let lower = html.to_lowercase();
        for forbidden in [
            "#dc2626", "#16a34a", "#eab308", "#f59e0b", "emerald", "amber", "rose",
        ] {
            assert!(!lower.contains(forbidden), "forbidden color token {} found", forbidden);
        }
    }

    #[test]
    fn test_export_qc_report_files_writes_pdf_html_json_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!(
            "laptopbench_report_test_{}",
            std::process::id()
        ));
        let _guard = TempDirGuard(dir.clone());
        let payload = sample_v230_payload(Some(dir.to_string_lossy().to_string()), "NORMAL");

        let paths = export_qc_report_files(&payload).expect("export should succeed");
        let pdf_bytes = fs::read(&paths.pdf_path).expect("PDF exists");
        let html_text = fs::read_to_string(&paths.html_path).expect("HTML exists");
        let json_text = fs::read_to_string(&paths.json_path).expect("JSON exists");

        assert!(pdf_bytes.starts_with(b"%PDF-1.4"));
        assert!(pdf_bytes.ends_with(b"%%EOF\n"));
        assert!(html_text.contains("LaptopBench QC v3.0.0"));
        let parsed: serde_json::Value = serde_json::from_str(&json_text).expect("valid JSON");
        assert_eq!(parsed["version"], "3.0.0");
        assert_eq!(parsed["report"]["userBenchmark"]["overallVehicleTier"], "Aircraft Carrier");
        assert_eq!(parsed["report"]["batteryDischarge"]["verdict"], "NORMAL");
        assert_eq!(parsed["report"]["touchscreen"]["coveredCells"], 160);
        assert_eq!(parsed["report"]["networkReport"]["verdict"], "HEALTHY");
    }

    #[test]
    fn test_skipped_storage_with_critical_smart_log_0x02_propagates_to_meaning_and_html() {
        let mut payload = sample_v230_payload(None, "NORMAL");
        payload.overall_verdict = "PASSED WITH WARNINGS".into();
        payload.tests = vec![ReportTestEntry {
            id: "storage".into(),
            name: "05. SSD SMART & Speed".into(),
            category: "Storage".into(),
            status: TestStatus::Skipped,
            summary: "CRITICAL NVMe WEAR: 104% used, 8% spare, 12 media errors. — Stage skipped (low-space/write-budget guard or manual skip)".into(),
            metrics: vec![
                ("SMART Health".into(), "0%".into()),
                ("Wear (Log 0x02)".into(), "104%".into()),
                ("Spare".into(), "8%".into()),
                ("Media Err".into(), "12".into()),
                ("Unsafe Off".into(), "84".into()),
                ("Write Budget".into(), "128/256/512 MB Safe Guard (4x free space)".into()),
            ],
            notes: String::new(),
        }];

        let (_headline, bullets) = build_long_term_meaning(&payload);
        let joined = bullets.join("\n");
        assert!(joined.contains("Log 0x02"), "Expected Log 0x02 in meaning bullets: {}", joined);
        assert!(joined.contains("available_spare 8%"), "Expected available_spare in meaning bullets: {}", joined);
        assert!(joined.contains("media_errors 12"), "Expected media_errors in meaning bullets: {}", joined);
        assert!(joined.contains("unsafe_shutdowns 84"), "Expected unsafe_shutdowns in meaning bullets: {}", joined);
        assert!(joined.contains("128 MB Quick / 256 MB Std / 512 MB max write budget"), "Expected write budget protection in meaning bullets: {}", joined);

        let html = render_qc_html(&payload, "2026-11-26 10:00:00");
        assert!(html.contains("available_spare 8%"));
        assert!(html.contains("unsafe_shutdowns 84"));
        assert!(html.contains("Write-Budget Protection"));
        assert!(!html.contains("v2.1."));
        assert!(!html.to_lowercase().contains("13-stage"));
        let lower = html.to_lowercase();
        for forbidden in [
            "#dc2626", "#16a34a", "#eab308", "#f59e0b", "emerald", "amber", "rose",
        ] {
            assert!(!lower.contains(forbidden), "forbidden color token {} found", forbidden);
        }
    }

    #[test]
    fn test_not_applicable_hardware_stages_keep_passed_verdict_and_summary() {
        let mut payload = sample_v230_payload(None, "NORMAL");
        payload.plain_verdict_summary = None;
        payload.overall_verdict = "PASSED".into();
        if let Some(last) = payload.tests.last_mut() {
            last.id = "gpu".into();
            last.name = "13. GPU & Power".into();
            last.status = TestStatus::NotApplicable;
            last.summary = "Marked N/A (Office iGPU)".into();
        }

        let (headline, _bullets) = build_long_term_meaning(&payload);
        assert_eq!(payload.overall_verdict, "PASSED");
        assert!(
            headline.contains("13 applicable diagnostic stages passed") && headline.contains("1 N/A stage(s) noted"),
            "Unexpected headline for N/A hardware stage: {}",
            headline
        );
        assert!(!headline.contains("warning"), "N/A stage must not produce warning headline: {}", headline);
        assert!(!headline.contains("skipped"), "N/A stage must not be counted as skipped: {}", headline);

        let html = render_qc_html(&payload, "2026-11-26 10:00:00");
        assert!(html.contains("PASSED"));
        assert!(html.contains("1 N/A stage(s) noted"));
    }

    #[test]
    fn test_render_qc_html_rejects_xss_logo_data_url() {
        for bad_url in [
            r#"data:image/png;base64,AAA" onerror="alert('XSS')""#,
            "data:image/svg+xml,<svg onload=alert(1)>",
            "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+",
            "data:image/png;base64,AAA<script>alert(1)</script>",
            "javascript:alert(1)",
        ] {
            let mut payload = sample_v230_payload(None, "NORMAL");
            payload.shop_profile.logo_data_url = Some(bad_url.to_string());
            let html = render_qc_html(&payload, "2026-11-26 10:00:00");
            assert!(
                !html.contains(r#"class="logo""#),
                "Unsafe logo_data_url '{}' should have been rejected from <img>",
                bad_url
            );
            assert!(
                !html.contains("onerror="),
                "Unescaped onerror attribute injected for '{}'",
                bad_url
            );
            assert!(
                !html.contains("<svg onload"),
                "SVG XSS payload injected for '{}'",
                bad_url
            );
        }

        let mut valid_payload = sample_v230_payload(None, "NORMAL");
        valid_payload.shop_profile.logo_data_url = Some("data:image/png;base64,iVBORw0KGgo=".into());
        let valid_html = render_qc_html(&valid_payload, "2026-11-26 10:00:00");
        assert!(
            valid_html.contains(r#"<img src="data:image/png;base64,iVBORw0KGgo=" alt="Shop Logo" class="logo" />"#),
            "Valid raster PNG data URL must render safely"
        );
    }

    #[test]
    fn test_render_qc_html_subsystem_bars_fail_and_cancelled_are_non_blue() {
        let mut payload = sample_v230_payload(None, "NORMAL");
        payload.overall_verdict = "FAILED".into();
        payload.subsystem_scores = vec![
            SubsystemScoreBar {
                label: "SSD Direct-IO".into(),
                score_pct: 15.0,
                metric_text: "R 6100 / W 3200 MB/s • 0 err • Thermal Cutoff".into(),
                status_label: "FAIL".into(),
            },
            SubsystemScoreBar {
                label: "RAM Stability (TM5)".into(),
                score_pct: 55.0,
                metric_text: "2.5 GB verified • 0 bit errors".into(),
                status_label: "CANCELLED".into(),
            },
            SubsystemScoreBar {
                label: "GPU / VRAM / Power".into(),
                score_pct: 60.0,
                metric_text: "80.0 FPS • Power Cancelled".into(),
                status_label: "WARN".into(),
            },
        ];

        let html = render_qc_html(&payload, "2026-11-26 10:00:00");
        let sec02_start = html
            .find("02 // SUBSYSTEM HEALTH &amp; PERFORMANCE CALIBRATION")
            .expect("Section 02 present");
        let sec03_start = html
            .find("03 // USERBENCHMARK COMPARISON")
            .expect("Section 03 present");
        let sec02 = &html[sec02_start..sec03_start];

        assert!(sec02.contains("background:#09090b"), "FAIL bar must use #09090b fill: {}", sec02);
        assert!(sec02.contains("background:#3f3f46"), "CANCELLED/WARN bar must use #3f3f46 fill: {}", sec02);
        assert!(!sec02.contains("#2563eb"), "FAIL/CANCELLED/WARN Section 02 must not render #2563eb blue: {}", sec02);
    }

    #[test]
    fn test_render_qc_html_section02_network_and_battery_discharge_non_blue() {
        let mut poor_payload = sample_v230_payload(None, "NORMAL");
        poor_payload.overall_verdict = "FAILED".into();
        poor_payload.subsystem_scores = vec![SubsystemScoreBar {
            label: "Network & Wi-Fi Link".into(),
            score_pct: 45.0,
            metric_text: "Wi-Fi • 54 Mbps • 142.0ms".into(),
            status_label: "POOR_LINK".into(),
        }];
        let poor_html = render_qc_html(&poor_payload, "2026-11-26 10:00:00");
        let s02 = poor_html
            .find("02 // SUBSYSTEM HEALTH &amp; PERFORMANCE CALIBRATION")
            .expect("Section 02 present");
        let s03 = poor_html
            .find("03 // USERBENCHMARK COMPARISON")
            .expect("Section 03 present");
        let poor_sec02 = &poor_html[s02..s03];
        assert!(
            poor_sec02.contains("background:#09090b") && poor_sec02.contains("POOR_LINK"),
            "POOR_LINK bar must use #09090b fill: {}",
            poor_sec02
        );
        assert!(
            !poor_sec02.contains("#2563eb"),
            "POOR_LINK Section 02 must not render #2563eb blue: {}",
            poor_sec02
        );

        for warn_label in [
            "NO_ACTIVE_LINK",
            "DEGRADED",
            "LOCAL_ONLY_NO_DNS",
            "ABORTED_LOW_BATTERY",
            "AC_CONNECTED",
            "INSUFFICIENT_SAMPLES",
        ] {
            let mut payload = sample_v230_payload(None, "NORMAL");
            payload.overall_verdict = "PASSED WITH WARNINGS".into();
            payload.subsystem_scores = vec![SubsystemScoreBar {
                label: if warn_label == "NO_ACTIVE_LINK"
                    || warn_label == "DEGRADED"
                    || warn_label == "LOCAL_ONLY_NO_DNS"
                {
                    "Network & Wi-Fi Link".into()
                } else {
                    "Battery Health & Discharge".into()
                },
                score_pct: 65.0,
                metric_text: format!("Diagnostic status {}", warn_label),
                status_label: warn_label.into(),
            }];
            let html = render_qc_html(&payload, "2026-11-26 10:00:00");
            let sec02_start = html
                .find("02 // SUBSYSTEM HEALTH &amp; PERFORMANCE CALIBRATION")
                .expect("Section 02 present");
            let sec03_start = html
                .find("03 // USERBENCHMARK COMPARISON")
                .expect("Section 03 present");
            let sec02 = &html[sec02_start..sec03_start];
            assert!(
                sec02.contains("background:#3f3f46") && sec02.contains(warn_label),
                "{} bar must use #3f3f46 fill: {}",
                warn_label,
                sec02
            );
            assert!(
                !sec02.contains("#2563eb"),
                "{} Section 02 must not render #2563eb blue: {}",
                warn_label,
                sec02
            );
        }
    }
}
