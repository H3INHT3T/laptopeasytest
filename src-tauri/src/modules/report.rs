use crate::modules::pdf_gen::render_qc_certificate_pdf;
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
    let shop = if payload.shop_profile.shop_name.trim().is_empty() {
        "LaptopBench QC"
    } else {
        payload.shop_profile.shop_name.trim()
    };
    let tech = if payload.shop_profile.technician_name.trim().is_empty() {
        "Technician"
    } else {
        payload.shop_profile.technician_name.trim()
    };

    let verdict_color = match payload.overall_verdict.as_str() {
        "PASSED" => "#059669",
        "PASSED WITH WARNINGS" => "#d97706",
        "FAILED" => "#dc2626",
        _ => "#475569",
    };

    let logo_html = payload
        .shop_profile
        .logo_data_url
        .as_deref()
        .filter(|u| u.starts_with("data:image/"))
        .map(|u| format!(r#"<img src="{}" alt="Shop Logo" class="logo" />"#, u))
        .unwrap_or_default();

    let specs_html = if let Some(sp) = &payload.specs {
        let gpus = sp.gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" / ");
        let disks = sp
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB)", d.model, d.size_gb))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"
        <section class="card">
          <h2>Device Hardware Specifications</h2>
          <div class="spec-grid">
            <div><span>Model</span><strong>{} {}</strong></div>
            <div><span>Serial Number</span><strong>{}</strong></div>
            <div><span>Operating System</span><strong>{} ({})</strong></div>
            <div><span>BIOS / Firmware</span><strong>{}</strong></div>
            <div><span>Processor</span><strong>{} ({}C / {}T)</strong></div>
            <div><span>Memory (RAM)</span><strong>{:.1} GB</strong></div>
            <div><span>Graphics</span><strong>{}</strong></div>
            <div><span>Storage</span><strong>{}</strong></div>
          </div>
        </section>"#,
            html_escape(&sp.manufacturer),
            html_escape(&sp.model),
            html_escape(&sp.serial_number),
            html_escape(&sp.os_name),
            html_escape(&sp.architecture),
            html_escape(&sp.bios_version),
            html_escape(&sp.cpu_brand),
            sp.cpu_physical_cores,
            sp.cpu_logical_cores,
            sp.total_ram_gb,
            html_escape(if gpus.is_empty() { "Integrated" } else { &gpus }),
            html_escape(if disks.is_empty() { "Detected" } else { &disks }),
        )
    } else {
        String::new()
    };

    let mut rows_html = String::new();
    for t in &payload.tests {
        let (lbl, bg) = match t.status {
            TestStatus::Pass => ("PASS", "#059669"),
            TestStatus::Warn => ("WARN", "#d97706"),
            TestStatus::Fail => ("FAIL", "#dc2626"),
            TestStatus::NotApplicable => ("N/A", "#64748b"),
            TestStatus::Running => ("RUN", "#0284c7"),
            TestStatus::Pending => ("SKIP", "#64748b"),
        };
        let note_html = if t.notes.trim().is_empty() {
            String::new()
        } else {
            format!(r#"<div class="note">Note: {}</div>"#, html_escape(t.notes.trim()))
        };
        rows_html.push_str(&format!(
            r#"<tr>
              <td><strong>{}</strong><div class="cat">{}</div></td>
              <td><span class="pill" style="background:{}">{}</span></td>
              <td>{}{}</td>
            </tr>"#,
            html_escape(&t.name),
            html_escape(&t.category),
            bg,
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
<title>QC Certificate — {}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 28px; background: #f1f5f9; color: #0f172a; }}
  .sheet {{ max-width: 920px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 28px rgba(15,23,42,.1); }}
  header {{ background: #0f172a; color: #fff; padding: 24px 28px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }}
  .brand {{ display: flex; align-items: center; gap: 16px; }}
  .logo {{ max-height: 54px; max-width: 120px; object-fit: contain; border-radius: 6px; background: #fff; padding: 4px; }}
  header h1 {{ margin: 0; font-size: 22px; letter-spacing: -.01em; }}
  header p {{ margin: 4px 0 0; font-size: 12px; color: #94a3b8; }}
  .verdict {{ background: {verdict_color}; color: #fff; font-weight: 700; font-size: 14px; padding: 10px 18px; border-radius: 8px; letter-spacing: .04em; white-space: nowrap; }}
  main {{ padding: 24px 28px; }}
  .card {{ border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }}
  .card h2 {{ margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; }}
  .spec-grid {{ display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px 20px; }}
  .spec-grid span {{ display: block; font-size: 11px; color: #64748b; }}
  .spec-grid strong {{ font-size: 13px; color: #0f172a; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th {{ text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #475569; background: #f8fafc; padding: 10px 12px; border-bottom: 2px solid #e2e8f0; }}
  td {{ padding: 10px 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }}
  .cat {{ font-size: 11px; color: #64748b; }}
  .note {{ font-size: 11px; color: #475569; margin-top: 3px; font-style: italic; }}
  .pill {{ display: inline-block; color: #fff; font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }}
  .signoff {{ background: #f8fafc; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px; }}
  footer {{ padding: 14px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; }}
  @media print {{ body {{ background: #fff; padding: 0; }} .sheet {{ box-shadow: none; border-radius: 0; }} }}
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div class="brand">
      {logo_html}
      <div>
        <h1>{}</h1>
        <p>Laptop Hardware Diagnostics &amp; Quality Control Certificate</p>
        <p>Technician: <strong>{}</strong> &bull; Date: {} {}</p>
      </div>
    </div>
    <div class="verdict">{}</div>
  </header>
  <main>
    {specs_html}
    <section class="card">
      <h2>Diagnostic Module Results</h2>
      <table>
        <thead><tr><th style="width:26%">Test Module</th><th style="width:12%">Status</th><th>Summary &amp; Findings</th></tr></thead>
        <tbody>{rows_html}</tbody>
      </table>
    </section>
    <section class="card signoff">
      <div>
        <h2>Physical Ports &amp; Speakers Sign-Off</h2>
        <div><strong>Ports Checked:</strong> {} {}</div>
        <div><strong>Speakers Checked:</strong> {} {}</div>
      </div>
      <div>
        <h2>Technician Notes</h2>
        <div>{}</div>
      </div>
    </section>
  </main>
  <footer>
    <span>Generated offline by LaptopBench QC</span>
    <span>Verified by {} ({})</span>
  </footer>
</div>
</body>
</html>"#,
        html_escape(shop),
        html_escape(shop),
        html_escape(tech),
        html_escape(generated_at),
        if payload.customer_or_sku.trim().is_empty() {
            String::new()
        } else {
            format!("&bull; Ref/SKU: <strong>{}</strong>", html_escape(payload.customer_or_sku.trim()))
        },
        html_escape(&payload.overall_verdict),
        if payload.signoff.ports_checked { "YES" } else { "NO" },
        html_escape(&payload.signoff.ports_notes),
        if payload.signoff.speakers_checked { "YES" } else { "NO" },
        html_escape(&payload.signoff.speakers_notes),
        if payload.technician_notes.trim().is_empty() {
            "None".to_string()
        } else {
            html_escape(&payload.technician_notes)
        },
        html_escape(tech),
        html_escape(shop),
    )
}

pub fn export_qc_report(
    app: &AppHandle,
    payload: &ExportReportPayload,
) -> Result<ExportedReportPaths, String> {
    // Persist latest shop profile automatically
    let _ = save_shop_profile(app, &payload.shop_profile);

    let now = Local::now();
    let generated_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let stamp = now.format("%Y%m%d_%H%M%S").to_string();

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

    let stem = format!("QC_Report_{}_{}", serial, stamp);
    let pdf_path = report_folder.join(format!("{}.pdf", stem));
    let html_path = report_folder.join(format!("{}.html", stem));
    let json_path = report_folder.join(format!("{}.json", stem));

    // 1. Write Native PDF
    let pdf_bytes = render_qc_certificate_pdf(payload, &generated_at);
    fs::write(&pdf_path, pdf_bytes).map_err(|e| format!("Failed to write PDF: {}", e))?;

    // 2. Write Branded Self-Contained HTML
    let html_str = render_qc_html(payload, &generated_at);
    fs::write(&html_path, html_str).map_err(|e| format!("Failed to write HTML: {}", e))?;

    // 3. Write Machine-Readable JSON Archive
    let json_val = serde_json::json!({
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
