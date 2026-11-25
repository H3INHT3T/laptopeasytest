use crate::modules::pdf_gen::{compute_certificate_id, render_qc_certificate_pdf};
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

fn render_qc_html(payload: &ExportReportPayload, generated_at: &str) -> String {
    let cert_id = compute_certificate_id(payload, generated_at);
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
        .filter(|u| u.starts_with("data:image/"))
        .map(|u| format!(r#"<img src="{}" alt="Shop Logo" class="logo" />"#, u))
        .unwrap_or_default();

    let pass_c = payload.tests.iter().filter(|t| t.status == TestStatus::Pass).count();
    let warn_c = payload.tests.iter().filter(|t| t.status == TestStatus::Warn).count();
    let fail_c = payload.tests.iter().filter(|t| t.status == TestStatus::Fail).count();
    let skip_c = payload
        .tests
        .iter()
        .filter(|t| t.status == TestStatus::Skipped || t.status == TestStatus::NotApplicable)
        .count();

    let specs_html = if let Some(sp) = &payload.specs {
        let gpus = sp.gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" / ");
        let disks = sp
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB {})", d.model, d.size_gb, d.interface_type))
            .collect::<Vec<_>>()
            .join("; ");
        let ram_desc = if !sp.ram_modules.is_empty() {
            format!(
                "{:.1} GB {} ({}x DIMM)",
                sp.total_ram_gb,
                sp.ram_modules[0].memory_type,
                sp.ram_modules.len()
            )
        } else {
            format!("{:.1} GB RAM", sp.total_ram_gb)
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
          </div>
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
            let bad = b.status_label.contains("FAIL");
            let fill = if bad { "#09090b" } else { "#2563eb" };
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
        let note_html = if t.notes.trim().is_empty() {
            String::new()
        } else {
            format!(r#"<div class="note">Note: {}</div>"#, html_escape(t.notes.trim()))
        };
        rows_html.push_str(&format!(
            r#"<tr>
              <td><strong>{}</strong><div class="cat">{}</div></td>
              <td><span class="stamp {}">{}</span></td>
              <td>{}{}</td>
            </tr>"#,
            html_escape(&t.name),
            html_escape(&t.category),
            cls,
            lbl,
            html_escape(&t.summary),
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
  .spec-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); border: 1px solid #d4d4d8; }}
  .spec-grid > div {{ padding: 7px 10px; border-bottom: 1px solid #e4e4e7; border-right: 1px solid #e4e4e7; }}
  .spec-grid > div:nth-child(even) {{ border-right: none; }}
  .spec-grid span {{ display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: #71717a; font-family: ui-monospace, Consolas, monospace; }}
  .spec-grid strong {{ font-size: 12px; color: #09090b; }}
  .bars {{ border: 1px solid #d4d4d8; }}
  .bar-row {{ padding: 8px 12px; border-bottom: 1px solid #e4e4e7; }}
  .bar-row:last-child {{ border-bottom: none; }}
  .bar-top {{ display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11.5px; margin-bottom: 5px; }}
  .badge-inline {{ font-size: 10px; font-weight: 800; }}
  .track {{ height: 6px; background: #e4e4e7; }}
  .fill {{ height: 100%; }}
  .sign-box {{ border: 1px solid #d4d4d8; background: #f8fafc; padding: 12px 14px; font-size: 11.5px; }}
  .sig-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 26px; }}
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

    {specs_html}
    {bars_html}

    <section class="sec">
      <div class="sec-title">03 // PHYSICAL INSPECTION SIGN-OFF &amp; AUTHORIZATION</div>
      <div class="sign-box">
        <div class="mono"><strong>PHYSICAL PORTS (USB/HDMI/DC/JACK):</strong> {ports_ok} {ports_notes}</div>
        <div class="mono" style="margin-top:4px"><strong>STEREO SPEAKERS (L/R CLARITY):</strong> {spk_ok} {spk_notes}</div>
        <div style="margin-top:8px"><strong>Technician Notes:</strong> {notes_esc}</div>
        <div class="sig-grid mono">
          <div class="sig-line">Technician: {tech_esc} ({shop_esc})</div>
          <div class="sig-line">Customer / Buyer Acceptance &amp; Date</div>
        </div>
      </div>
    </section>
  </div>
  <footer class="mono">
    <span>LaptopBench QC v2.1 &bull; Created by Hein Htet Zaw (Telegram: @ich8g92)</span>
    <span>Tamper-Check ID: {cert_id}</span>
  </footer>
</div>

<div class="sheet page-break" style="border-top-color:#09090b">
  <div class="sheet-body">
    <div class="sec-title" style="font-size:12px">APPENDIX A // 13-STAGE TECHNICAL DIAGNOSTIC AUDIT LEDGER</div>
    <table>
      <thead><tr><th style="width:28%">Stage &amp; Module</th><th style="width:12%">Status</th><th>Measured Findings, Thresholds &amp; Notes</th></tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
  </div>
  <footer class="mono">
    <span>LaptopBench QC v2.1 &bull; Created by Hein Htet Zaw (Telegram: @ich8g92)</span>
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
        specs_html = specs_html,
        bars_html = bars_html,
        ports_ok = if payload.signoff.ports_checked { "[VERIFIED]" } else { "[NOT CONFIRMED]" },
        ports_notes = html_escape(&payload.signoff.ports_notes),
        spk_ok = if payload.signoff.speakers_checked { "[VERIFIED]" } else { "[NOT CONFIRMED]" },
        spk_notes = html_escape(&payload.signoff.speakers_notes),
        notes_esc = if payload.technician_notes.trim().is_empty() {
            "Unit inspected per 13-stage LaptopBench QC protocol.".to_string()
        } else {
            html_escape(payload.technician_notes.trim())
        },
        tech_esc = html_escape(tech),
        rows_html = rows_html,
    )
}

pub fn export_qc_report(
    app: &AppHandle,
    payload: &ExportReportPayload,
) -> Result<ExportedReportPaths, String> {
    let _ = save_shop_profile(app, &payload.shop_profile);

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
