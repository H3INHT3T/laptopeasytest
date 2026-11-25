use crate::types::{ExportReportPayload, TestStatus};
use qrcodegen::{QrCode, QrCodeEcc};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::io::Write as _;

const PAGE_W: f32 = 595.0;
const PAGE_H: f32 = 842.0;
const MARGIN: f32 = 38.0;

// Strict White / Black / Cobalt Blue palette
const COL_BLACK: (f32, f32, f32) = (0.035, 0.035, 0.043);      // #09090B
const COL_BLUE: (f32, f32, f32) = (0.145, 0.388, 0.922);       // #2563EB
const COL_BLUE_DARK: (f32, f32, f32) = (0.114, 0.306, 0.847);  // #1D4ED8
const COL_INK_MUTED: (f32, f32, f32) = (0.35, 0.36, 0.40);
const COL_RULE: (f32, f32, f32) = (0.82, 0.83, 0.86);
const COL_PAPER: (f32, f32, f32) = (0.973, 0.980, 0.988);      // #F8FAFC
const COL_WHITE: (f32, f32, f32) = (1.0, 1.0, 1.0);

pub fn compute_certificate_id(payload: &ExportReportPayload, generated_at: &str) -> String {
    let mut h = Sha256::new();
    h.update(payload.shop_profile.shop_name.as_bytes());
    h.update(b"|");
    h.update(payload.shop_profile.technician_name.as_bytes());
    h.update(b"|");
    h.update(generated_at.as_bytes());
    h.update(b"|");
    h.update(payload.overall_verdict.as_bytes());
    if let Some(sp) = &payload.specs {
        h.update(b"|");
        h.update(sp.serial_number.as_bytes());
        h.update(b"|");
        h.update(sp.model.as_bytes());
    }
    for t in &payload.tests {
        h.update(b"|");
        h.update(t.id.as_bytes());
        h.update(format!("{:?}", t.status).as_bytes());
    }
    let digest = h.finalize();
    let hex: String = digest.iter().take(6).map(|b| format!("{:02X}", b)).collect();
    format!("LBQC-{}-{}-{}", &hex[0..4], &hex[4..8], &hex[8..12])
}

pub fn build_qr_payload(payload: &ExportReportPayload, cert_id: &str) -> String {
    let shop = if payload.shop_profile.shop_name.trim().is_empty() {
        "LaptopBenchQC"
    } else {
        payload.shop_profile.shop_name.trim()
    };
    let model = payload
        .specs
        .as_ref()
        .map(|s| format!("{} {}", s.manufacturer, s.model))
        .unwrap_or_else(|| "Laptop".into());
    let sn = payload
        .specs
        .as_ref()
        .map(|s| s.serial_number.as_str())
        .unwrap_or("N/A");
    let grade = payload
        .durability_grade
        .as_deref()
        .unwrap_or(if payload.overall_verdict == "FAILED" { "FAIL" } else { "A" });
    format!(
        "LBQC|Shop={}|Model={}|SN={}|Grade={}|Verdict={}|ID={}",
        shop.chars().take(28).collect::<String>(),
        model.chars().take(36).collect::<String>(),
        sn.chars().take(28).collect::<String>(),
        grade,
        payload.overall_verdict,
        cert_id
    )
}

pub fn render_qr_svg(data: &str) -> String {
    if let Ok(qr) = QrCode::encode_text(data, QrCodeEcc::Medium) {
        let sz = qr.size();
        let border = 2;
        let full = sz + border * 2;
        let mut rects = String::new();
        for y in 0..sz {
            for x in 0..sz {
                if qr.get_module(x, y) {
                    let _ = write!(rects, r#"<rect x="{}" y="{}" width="1" height="1"/>"#, x + border, y + border);
                }
            }
        }
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {full} {full}" shape-rendering="crispEdges" class="qr-svg"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#09090b">{rects}</g></svg>"##,
            full = full,
            rects = rects
        )
    } else {
        String::new()
    }
}

fn pdf_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let c = match ch {
            '°' => " deg ",
            '—' | '–' => "-",
            '•' => "*",
            '✓' | '✔' => "[OK]",
            '✗' | '✘' => "[X]",
            _ => "",
        };
        if !c.is_empty() {
            out.push_str(c);
            continue;
        }
        if (ch as u32) < 32 || (ch as u32) > 126 {
            out.push('?');
            continue;
        }
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out
}

fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for raw_line in text.lines() {
        let words: Vec<&str> = raw_line.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut cur = String::new();
        for w in words {
            if cur.is_empty() {
                cur.push_str(w);
            } else if cur.len() + 1 + w.len() <= max_chars {
                cur.push(' ');
                cur.push_str(w);
            } else {
                lines.push(cur);
                cur = w.to_string();
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

struct PageBuilder {
    pages: Vec<String>,
    cur: String,
    y: f32,
    cert_id: String,
}

impl PageBuilder {
    fn new(cert_id: String) -> Self {
        Self {
            pages: Vec::new(),
            cur: String::new(),
            y: PAGE_H - MARGIN,
            cert_id,
        }
    }

    fn finish_page(&mut self) {
        if !self.cur.is_empty() {
            let page_num = self.pages.len() + 1;
            let content_w = PAGE_W - MARGIN * 2.0;
            // Hairline footer rule
            self.line(MARGIN, 34.0, MARGIN + content_w, 34.0, 0.6, COL_RULE);
            let footer = format!(
                "LaptopBench QC v2.1  |  Created by Hein Htet Zaw (Telegram: @ich8g92)  |  Cert ID: {}  |  Page {}",
                self.cert_id, page_num
            );
            let _ = writeln!(
                self.cur,
                "0.35 0.36 0.40 rg BT /F3 7.5 Tf {:.2} 22 Td ({}) Tj ET",
                MARGIN,
                pdf_escape(&footer)
            );
            self.pages.push(std::mem::take(&mut self.cur));
        }
        self.y = PAGE_H - MARGIN;
    }

    fn ensure_space(&mut self, needed: f32) {
        if self.y - needed < 46.0 {
            self.finish_page();
        }
    }

    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, w: f32, rgb: (f32, f32, f32)) {
        let _ = writeln!(
            self.cur,
            "{:.2} w {:.3} {:.3} {:.3} RG {:.2} {:.2} m {:.2} {:.2} l S",
            w, rgb.0, rgb.1, rgb.2, x1, y1, x2, y2
        );
    }

    fn rect_fill(&mut self, x: f32, y_bottom: f32, w: f32, h: f32, rgb: (f32, f32, f32)) {
        let _ = writeln!(
            self.cur,
            "{:.3} {:.3} {:.3} rg {:.2} {:.2} {:.2} {:.2} re f",
            rgb.0, rgb.1, rgb.2, x, y_bottom, w, h
        );
    }

    fn rect_stroke(&mut self, x: f32, y_bottom: f32, w: f32, h: f32, lw: f32, rgb: (f32, f32, f32)) {
        let _ = writeln!(
            self.cur,
            "{:.2} w {:.3} {:.3} {:.3} RG {:.2} {:.2} {:.2} {:.2} re S",
            lw, rgb.0, rgb.1, rgb.2, x, y_bottom, w, h
        );
    }

    fn draw_qr(&mut self, x: f32, y_bottom: f32, size_pt: f32, data: &str) {
        if let Ok(qr) = QrCode::encode_text(data, QrCodeEcc::Medium) {
            let n = qr.size();
            let pad = 4.0;
            self.rect_fill(x, y_bottom, size_pt, size_pt, COL_WHITE);
            self.rect_stroke(x, y_bottom, size_pt, size_pt, 0.7, COL_BLACK);
            let cell = (size_pt - pad * 2.0) / (n as f32);
            let _ = writeln!(self.cur, "{:.3} {:.3} {:.3} rg", COL_BLACK.0, COL_BLACK.1, COL_BLACK.2);
            for row in 0..n {
                for col in 0..n {
                    if qr.get_module(col, row) {
                        let rx = x + pad + (col as f32) * cell;
                        let ry = y_bottom + size_pt - pad - ((row + 1) as f32) * cell;
                        let _ = writeln!(
                            self.cur,
                            "{:.2} {:.2} {:.2} {:.2} re f",
                            rx,
                            ry,
                            cell + 0.08,
                            cell + 0.08
                        );
                    }
                }
            }
        }
    }

    fn text(&mut self, font: &str, size: f32, x: f32, y: f32, rgb: (f32, f32, f32), s: &str) {
        let _ = writeln!(
            self.cur,
            "{:.3} {:.3} {:.3} rg BT /{} {:.1} Tf {:.2} {:.2} Td ({}) Tj ET",
            rgb.0,
            rgb.1,
            rgb.2,
            font,
            size,
            x,
            y,
            pdf_escape(s)
        );
    }

    fn build_pdf(mut self) -> Vec<u8> {
        self.finish_page();
        let page_count = self.pages.len().max(1);

        // Objects:
        // 1: Catalog
        // 2: Pages
        // 3: F1 Helvetica
        // 4: F2 Helvetica-Bold
        // 5: F3 Courier (monospace)
        // 6: F4 Courier-Bold
        // Pages start at obj 7
        let mut objects: Vec<Vec<u8>> = Vec::new();
        let mut kids_refs = String::new();
        for i in 0..page_count {
            let page_obj_id = 7 + i * 2;
            let _ = write!(kids_refs, "{} 0 R ", page_obj_id);
        }

        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(
            format!("<< /Type /Pages /Kids [ {}] /Count {} >>", kids_refs, page_count).into_bytes(),
        );
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>".to_vec());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>".to_vec());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>".to_vec());

        for (i, stream) in self.pages.iter().enumerate() {
            let content_obj_id = 7 + i * 2 + 1;
            let page_dict = format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.0} {:.0}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents {} 0 R >>",
                PAGE_W, PAGE_H, content_obj_id
            );
            objects.push(page_dict.into_bytes());

            let bytes = stream.as_bytes();
            let mut content_obj = Vec::with_capacity(bytes.len() + 64);
            let _ = write!(&mut content_obj, "<< /Length {} >>\nstream\n", bytes.len());
            content_obj.extend_from_slice(bytes);
            content_obj.extend_from_slice(b"\nendstream");
            objects.push(content_obj);
        }

        let mut pdf = Vec::with_capacity(20480);
        pdf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

        let mut offsets = vec![0usize; objects.len() + 1];
        for (idx, body) in objects.iter().enumerate() {
            let obj_num = idx + 1;
            offsets[obj_num] = pdf.len();
            let _ = write!(&mut pdf, "{} 0 obj\n", obj_num);
            pdf.extend_from_slice(body);
            pdf.extend_from_slice(b"\nendobj\n");
        }

        let xref_offset = pdf.len();
        let _ = writeln!(&mut pdf, "xref\n0 {}", objects.len() + 1);
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for &off in offsets.iter().skip(1) {
            let _ = writeln!(&mut pdf, "{:010} 00000 n ", off);
        }

        let _ = write!(
            &mut pdf,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref_offset
        );

        pdf
    }
}

fn status_stamp(st: &TestStatus) -> (&'static str, (f32, f32, f32), (f32, f32, f32), bool) {
    // (label, fill_rgb, text_rgb, stroke_only)
    match st {
        TestStatus::Pass => ("PASS", COL_BLUE, COL_WHITE, false),
        TestStatus::Warn => ("WARN", COL_WHITE, COL_BLUE_DARK, true),
        TestStatus::Fail => ("FAIL", COL_BLACK, COL_WHITE, false),
        TestStatus::Skipped => ("SKIP", COL_WHITE, COL_INK_MUTED, true),
        TestStatus::NotApplicable => ("N/A", COL_PAPER, COL_INK_MUTED, true),
        TestStatus::Running => ("RUN", COL_BLUE, COL_WHITE, false),
        TestStatus::Pending => ("WAIT", COL_PAPER, COL_INK_MUTED, true),
    }
}

/// Swiss Lab Calibration Certificate (2-Tier Executive Sheet + Technical Audit Ledger)
/// Strictly White, Black & Cobalt Blue.
pub fn render_qc_certificate_pdf(payload: &ExportReportPayload, generated_at: &str) -> Vec<u8> {
    let cert_id = compute_certificate_id(payload, generated_at);
    let mut pb = PageBuilder::new(cert_id.clone());
    let content_w = PAGE_W - MARGIN * 2.0;

    let shop_title = if payload.shop_profile.shop_name.trim().is_empty() {
        "LAPTOPBENCH QC LAB"
    } else {
        payload.shop_profile.shop_name.trim()
    };
    let tech = if payload.shop_profile.technician_name.trim().is_empty() {
        "Certified Technician"
    } else {
        payload.shop_profile.technician_name.trim()
    };

    // ==================== PAGE 1: EXECUTIVE CERTIFICATION SHEET ====================
    // Bold 3.5pt Cobalt Blue Architectural Top Rule
    pb.rect_fill(MARGIN, PAGE_H - MARGIN - 4.0, content_w, 4.0, COL_BLUE);

    // Masthead Block
    let mast_top = PAGE_H - MARGIN - 16.0;
    pb.text("F4", 8.0, MARGIN, mast_top, COL_BLUE_DARK, "OFFICIAL HARDWARE CALIBRATION & QUALITY CONTROL CERTIFICATE");
    pb.text("F2", 20.0, MARGIN, mast_top - 22.0, COL_BLACK, shop_title);
    let ref_str = if payload.customer_or_sku.trim().is_empty() {
        format!("ISSUED: {}   |   CERT ID: {}", generated_at, cert_id)
    } else {
        format!(
            "ISSUED: {}   |   SKU/REF: {}   |   CERT ID: {}",
            generated_at,
            payload.customer_or_sku.trim(),
            cert_id
        )
    };
    pb.text("F3", 8.0, MARGIN, mast_top - 36.0, COL_INK_MUTED, &ref_str);

    // Right-aligned Durability Grade & Verdict Seal Box
    let seal_w = 132.0;
    let seal_h = 52.0;
    let seal_x = MARGIN + content_w - seal_w;
    let seal_y = mast_top - 42.0;
    let is_fail = payload.overall_verdict == "FAILED";
    let grade_str = payload
        .durability_grade
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if is_fail { "FAIL" } else if payload.overall_verdict == "PASSED" { "A" } else { "B" });

    pb.rect_fill(seal_x, seal_y, seal_w, seal_h, if is_fail { COL_BLACK } else { COL_BLUE });
    pb.text("F4", 7.5, seal_x + 10.0, seal_y + 39.0, COL_WHITE, "CERTIFIED VERDICT");
    pb.text("F2", 12.0, seal_x + 10.0, seal_y + 23.0, COL_WHITE, &payload.overall_verdict);
    pb.text(
        "F4",
        9.0,
        seal_x + 10.0,
        seal_y + 9.0,
        (0.86, 0.92, 1.0),
        &format!("DURABILITY GRADE: {}", grade_str),
    );

    pb.line(MARGIN, seal_y - 10.0, MARGIN + content_w, seal_y - 10.0, 1.0, COL_BLACK);
    pb.y = seal_y - 24.0;

    // 1. Executive Pass/Warn/Fail Telemetry Counter Row
    let pass_c = payload.tests.iter().filter(|t| t.status == TestStatus::Pass).count();
    let warn_c = payload.tests.iter().filter(|t| t.status == TestStatus::Warn).count();
    let fail_c = payload.tests.iter().filter(|t| t.status == TestStatus::Fail).count();
    let skip_c = payload.tests.iter().filter(|t| t.status == TestStatus::Skipped || t.status == TestStatus::NotApplicable).count();

    let stat_h = 38.0;
    let stat_y = pb.y - stat_h;
    pb.rect_fill(MARGIN, stat_y, content_w, stat_h, COL_PAPER);
    pb.rect_stroke(MARGIN, stat_y, content_w, stat_h, 0.6, COL_RULE);
    let col_w = content_w / 4.0;
    let stats = [
        ("MODULES PASSED", format!("{:02}", pass_c), COL_BLUE_DARK),
        ("WARNINGS", format!("{:02}", warn_c), COL_BLACK),
        ("CRITICAL FAILURES", format!("{:02}", fail_c), COL_BLACK),
        ("SKIPPED / N/A", format!("{:02}", skip_c), COL_INK_MUTED),
    ];
    for (i, (lbl, val, col)) in stats.iter().enumerate() {
        let cx = MARGIN + (i as f32) * col_w;
        if i > 0 {
            pb.line(cx, stat_y, cx, stat_y + stat_h, 0.6, COL_RULE);
        }
        pb.text("F4", 7.0, cx + 10.0, stat_y + 26.0, COL_INK_MUTED, lbl);
        pb.text("F4", 15.0, cx + 10.0, stat_y + 8.0, *col, val);
    }
    pb.y = stat_y - 18.0;

    // 2. Verified Hardware Identity Grid
    pb.text("F4", 9.0, MARGIN, pb.y, COL_BLACK, "01 // VERIFIED DEVICE HARDWARE IDENTITY");
    pb.line(MARGIN, pb.y - 4.0, MARGIN + content_w, pb.y - 4.0, 0.8, COL_BLACK);
    pb.y -= 10.0;

    if let Some(specs) = &payload.specs {
        let gpu_list: String = specs.gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" / ");
        let disk_list: String = specs
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB {})", d.model, d.size_gb, d.interface_type))
            .collect::<Vec<_>>()
            .join("; ");
        let ram_detail = if !specs.ram_modules.is_empty() {
            let speed = specs.ram_modules[0]
                .speed_mhz
                .map(|m| format!(" @ {} MHz", m))
                .unwrap_or_default();
            format!(
                "{:.1} GB {} ({}x DIMM{})",
                specs.total_ram_gb,
                specs.ram_modules[0].memory_type,
                specs.ram_modules.len(),
                speed
            )
        } else {
            format!("{:.1} GB RAM", specs.total_ram_gb)
        };

        let rows = [
            ("MODEL / CHASSIS", format!("{} {} ({})", specs.manufacturer, specs.model, specs.chassis_type)),
            ("SERIAL / UUID", format!("S/N: {}   |   BIOS: {}", specs.serial_number, specs.bios_version)),
            ("PROCESSOR (CPU)", format!("{} ({}C / {}T, Base {} MHz)", specs.cpu_brand, specs.cpu_physical_cores, specs.cpu_logical_cores, specs.cpu_base_mhz)),
            ("SYSTEM MEMORY", ram_detail),
            ("GRAPHICS (GPU)", if gpu_list.is_empty() { "Integrated Graphics".into() } else { gpu_list }),
            ("STORAGE DRIVES", if disk_list.is_empty() { "Detected".into() } else { disk_list }),
            ("OPERATING SYSTEM", format!("{} {} ({})", specs.os_name, specs.os_version, specs.architecture)),
        ];

        for (idx, (k, v)) in rows.iter().enumerate() {
            let row_h = 18.0;
            let ry = pb.y - row_h;
            if idx % 2 == 0 {
                pb.rect_fill(MARGIN, ry, content_w, row_h, COL_PAPER);
            }
            pb.rect_stroke(MARGIN, ry, content_w, row_h, 0.5, COL_RULE);
            pb.text("F4", 7.5, MARGIN + 8.0, ry + 6.0, COL_INK_MUTED, k);
            let trunc: String = v.chars().take(74).collect();
            pb.text("F1", 8.5, MARGIN + 118.0, ry + 6.0, COL_BLACK, &trunc);
            pb.y = ry;
        }
        pb.y -= 18.0;
    } else {
        pb.text("F1", 8.5, MARGIN, pb.y - 12.0, COL_INK_MUTED, "Hardware specification summary unavailable.");
        pb.y -= 24.0;
    }

    // 3. Visual Subsystem Health & Performance Calibration Bars
    pb.text("F4", 9.0, MARGIN, pb.y, COL_BLACK, "02 // SUBSYSTEM HEALTH & PERFORMANCE CALIBRATION");
    pb.line(MARGIN, pb.y - 4.0, MARGIN + content_w, pb.y - 4.0, 0.8, COL_BLACK);
    pb.y -= 12.0;

    if payload.subsystem_scores.is_empty() {
        pb.text("F1", 8.5, MARGIN, pb.y - 8.0, COL_INK_MUTED, "See Page 2 for full 13-stage module audit results.");
        pb.y -= 22.0;
    } else {
        for bar in &payload.subsystem_scores {
            let bh = 28.0;
            let by = pb.y - bh;
            pb.rect_stroke(MARGIN, by, content_w, bh, 0.5, COL_RULE);
            pb.text("F2", 8.5, MARGIN + 8.0, by + 16.5, COL_BLACK, &bar.label);
            let mtrunc: String = bar.metric_text.chars().take(52).collect();
            pb.text("F3", 7.5, MARGIN + 138.0, by + 16.5, COL_INK_MUTED, &mtrunc);
            let is_bad = bar.status_label.contains("FAIL");
            pb.text(
                "F4",
                7.5,
                MARGIN + content_w - 62.0,
                by + 16.5,
                if is_bad { COL_BLACK } else { COL_BLUE_DARK },
                &bar.status_label,
            );

            // Track + Fill Bar
            let track_x = MARGIN + 8.0;
            let track_w = content_w - 16.0;
            let pct = (bar.score_pct.clamp(0.0, 100.0) / 100.0) as f32;
            pb.rect_fill(track_x, by + 5.5, track_w, 5.5, (0.91, 0.92, 0.94));
            pb.rect_fill(track_x, by + 5.5, (track_w * pct).max(4.0), 5.5, if is_bad { COL_BLACK } else { COL_BLUE });
            pb.y = by - 4.0;
        }
        pb.y -= 10.0;
    }

    // 4. Physical Inspection Sign-Off, Offline Verification QR & Dual Signature Block (Page 1 Bottom)
    pb.ensure_space(136.0);
    pb.text("F4", 9.0, MARGIN, pb.y, COL_BLACK, "03 // PHYSICAL SIGN-OFF, OFFLINE QR SEAL & AUTHORIZATION");
    pb.line(MARGIN, pb.y - 4.0, MARGIN + content_w, pb.y - 4.0, 0.8, COL_BLACK);
    pb.y -= 10.0;

    let box_h = 110.0;
    let box_y = pb.y - box_h;
    pb.rect_fill(MARGIN, box_y, content_w, box_h, COL_PAPER);
    pb.rect_stroke(MARGIN, box_y, content_w, box_h, 0.7, COL_RULE);

    // Offline Vector QR Code anchored cleanly on the right inside the Sign-Off Box
    let qr_sz = 84.0;
    let qr_x = MARGIN + content_w - qr_sz - 10.0;
    let qr_y = box_y + 18.0;
    let qr_payload = build_qr_payload(payload, &cert_id);
    pb.draw_qr(qr_x, qr_y, qr_sz, &qr_payload);
    pb.text("F4", 6.5, qr_x + 4.0, box_y + 7.5, COL_INK_MUTED, "SCAN OFFLINE VERIFY");

    let text_area_w = content_w - qr_sz - 28.0;
    let ports_s = format!(
        "PORTS (USB/HDMI/DC): {} {}",
        if payload.signoff.ports_checked { "[VERIFIED]" } else { "[UNCONFIRMED]" },
        payload.signoff.ports_notes.trim()
    );
    let spk_s = format!(
        "SPEAKERS (L/R):      {} {}",
        if payload.signoff.speakers_checked { "[VERIFIED]" } else { "[UNCONFIRMED]" },
        payload.signoff.speakers_notes.trim()
    );
    let notes_s = format!(
        "NOTES: {}",
        if payload.technician_notes.trim().is_empty() {
            "Unit inspected per 13-stage LaptopBench QC protocol."
        } else {
            payload.technician_notes.trim()
        }
    );

    pb.text("F3", 7.8, MARGIN + 10.0, pb.y - 16.0, COL_BLACK, &ports_s.chars().take(66).collect::<String>());
    pb.text("F3", 7.8, MARGIN + 10.0, pb.y - 29.0, COL_BLACK, &spk_s.chars().take(66).collect::<String>());
    pb.text("F1", 8.0, MARGIN + 10.0, pb.y - 44.0, COL_INK_MUTED, &notes_s.chars().take(74).collect::<String>());

    // Dual Signature Lines inside the left text area
    let sig_y = box_y + 24.0;
    let half = (text_area_w - 18.0) / 2.0;
    pb.line(MARGIN + 10.0, sig_y, MARGIN + 10.0 + half, sig_y, 0.7, COL_BLACK);
    pb.text(
        "F4",
        7.0,
        MARGIN + 10.0,
        sig_y - 11.0,
        COL_BLACK,
        &format!("TECH: {} ({})", tech, shop_title).chars().take(34).collect::<String>(),
    );

    let right_x = MARGIN + 22.0 + half;
    pb.line(right_x, sig_y, right_x + half, sig_y, 0.7, COL_BLACK);
    pb.text("F4", 7.0, right_x, sig_y - 11.0, COL_INK_MUTED, "BUYER ACCEPTANCE & DATE");

    // ==================== PAGE 2+: FULL 13-STEP TECHNICAL AUDIT LEDGER ====================
    pb.finish_page();

    pb.rect_fill(MARGIN, PAGE_H - MARGIN - 3.0, content_w, 3.0, COL_BLACK);
    pb.text("F4", 10.0, MARGIN, PAGE_H - MARGIN - 18.0, COL_BLACK, "APPENDIX A // 13-STAGE DIAGNOSTIC AUDIT LEDGER");
    pb.text(
        "F3",
        8.0,
        MARGIN,
        PAGE_H - MARGIN - 30.0,
        COL_INK_MUTED,
        &format!("CERT ID: {}   |   SHOP: {}   |   DATE: {}", cert_id, shop_title, generated_at),
    );
    pb.y = PAGE_H - MARGIN - 44.0;

    // Table Header
    pb.rect_fill(MARGIN, pb.y - 18.0, content_w, 18.0, COL_BLACK);
    pb.text("F4", 8.0, MARGIN + 8.0, pb.y - 12.0, COL_WHITE, "STAGE / MODULE");
    pb.text("F4", 8.0, MARGIN + 158.0, pb.y - 12.0, COL_WHITE, "STATUS");
    pb.text("F4", 8.0, MARGIN + 214.0, pb.y - 12.0, COL_WHITE, "MEASURED FINDINGS, THRESHOLDS & NOTES");
    pb.y -= 18.0;

    for (idx, t) in payload.tests.iter().enumerate() {
        let mut detail_text = t.summary.clone();
        if !t.metrics.is_empty() {
            let m_joined = t
                .metrics
                .iter()
                .map(|(k, v)| format!("{}: {}", k, v))
                .collect::<Vec<_>>()
                .join(" | ");
            detail_text.push_str(&format!(" [{}]", m_joined));
        }
        if !t.notes.trim().is_empty() {
            detail_text.push_str(&format!(" (Note: {})", t.notes.trim()));
        }

        let wrapped = wrap_text(&detail_text, 56);
        let row_h = (wrapped.len() as f32 * 11.2 + 12.0).max(24.0);
        pb.ensure_space(row_h + 6.0);

        let row_y = pb.y - row_h;
        if idx % 2 == 1 {
            pb.rect_fill(MARGIN, row_y, content_w, row_h, COL_PAPER);
        }
        pb.rect_stroke(MARGIN, row_y, content_w, row_h, 0.5, COL_RULE);

        pb.text("F2", 8.2, MARGIN + 8.0, pb.y - 13.0, COL_BLACK, &t.name);
        pb.text("F3", 6.8, MARGIN + 8.0, pb.y - 22.0, COL_INK_MUTED, &t.category.to_uppercase());

        let (label, fill_rgb, text_rgb, stroke_only) = status_stamp(&t.status);
        pb.rect_fill(MARGIN + 156.0, pb.y - 17.0, 46.0, 13.0, fill_rgb);
        if stroke_only {
            pb.rect_stroke(MARGIN + 156.0, pb.y - 17.0, 46.0, 13.0, 0.7, text_rgb);
        }
        pb.text("F4", 7.5, MARGIN + 166.0, pb.y - 13.0, text_rgb, label);

        let mut ty = pb.y - 12.5;
        for line in &wrapped {
            pb.text("F1", 8.0, MARGIN + 214.0, ty, COL_BLACK, line);
            ty -= 11.2;
        }
        pb.y = row_y;
    }

    pb.build_pdf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PortsSpeakerSignoff, ReportTestEntry, ShopProfile};

    #[test]
    fn test_pdf_generator_produces_valid_pdf_header_and_eof() {
        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Apex Laptop Shop".into(),
                technician_name: "Alex".into(),
                logo_data_url: None,
                default_output_dir: None,
            },
            customer_or_sku: "INV-1042".into(),
            technician_notes: "Clean grade A unit.".into(),
            overall_verdict: "PASSED".into(),
            durability_grade: Some("A+".into()),
            subsystem_scores: vec![],
            specs: None,
            tests: vec![ReportTestEntry {
                id: "ram".into(),
                name: "10. RAM Stress Test".into(),
                category: "Deep Stress".into(),
                status: TestStatus::Pass,
                summary: "0 memory errors across 4096 MB.".into(),
                metrics: vec![],
                notes: String::new(),
            }],
            signoff: PortsSpeakerSignoff {
                ports_checked: true,
                ports_notes: "All USB-C & HDMI OK".into(),
                speakers_checked: true,
                speakers_notes: "L/R clear".into(),
            },
            output_dir: None,
        };
        let bytes = render_qc_certificate_pdf(&payload, "2026-11-25 22:00:00");
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
    }
}
