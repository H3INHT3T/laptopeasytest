use crate::modules::report::build_long_term_meaning;
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
const COL_ZINC_DARK: (f32, f32, f32) = (0.247, 0.247, 0.275);  // #3F3F46
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
    let clean_shop = sanitize_single_line(&payload.shop_profile.shop_name);
    let shop = if clean_shop.is_empty() {
        "LaptopBenchQC".to_string()
    } else {
        clean_shop
    };
    let model = payload
        .specs
        .as_ref()
        .map(|s| sanitize_single_line(&format!("{} {}", s.manufacturer, s.model)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Laptop".into());
    let sn = payload
        .specs
        .as_ref()
        .map(|s| sanitize_single_line(&s.serial_number))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "N/A".into());
    let grade = payload
        .durability_grade
        .as_deref()
        .map(sanitize_single_line)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if payload.overall_verdict == "FAILED" {
                "FAIL".into()
            } else {
                "A".into()
            }
        });
    format!(
        "LBQC|Shop={}|Model={}|SN={}|Grade={}|Verdict={}|ID={}",
        shop.chars().take(28).collect::<String>(),
        model.chars().take(36).collect::<String>(),
        sn.chars().take(28).collect::<String>(),
        grade,
        sanitize_single_line(&payload.overall_verdict),
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

fn sanitize_single_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true;
    for ch in s.chars() {
        if ch == '\r' || ch == '\n' || ch == '\t' || ch.is_control() || ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn expand_pdf_unicode_preserving_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let mapped = match ch {
            '°' => " deg ",
            '—' | '–' => "-",
            '•' => "*",
            '✓' | '✔' => "[OK]",
            '✗' | '✘' => "[X]",
            '’' | '‘' => "'",
            '“' | '”' => "\"",
            '…' => "...",
            '≥' => ">=",
            '≤' => "<=",
            '×' => "x",
            '±' => "+/-",
            '→' => "->",
            '™' => "(TM)",
            '®' => "(R)",
            '©' => "(C)",
            _ => "",
        };
        if !mapped.is_empty() {
            out.push_str(mapped);
        } else if ch == '\n' {
            out.push('\n');
        } else if ch == '\r' {
            // Normalized with '\n' in CRLF or ignored
        } else if ch == '\t' {
            out.push(' ');
        } else if (ch as u32) < 32 || (ch as u32) > 126 {
            out.push('?');
        } else {
            out.push(ch);
        }
    }
    out
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
            '’' | '‘' => "'",
            '“' | '”' => "\"",
            '…' => "...",
            '≥' => ">=",
            '≤' => "<=",
            '×' => "x",
            '±' => "+/-",
            '→' => "->",
            '™' => "(TM)",
            '®' => "(R)",
            '©' => "(C)",
            _ => "",
        };
        if !c.is_empty() {
            out.push_str(c);
            continue;
        }
        if ch == '\r' || ch == '\n' || ch == '\t' {
            out.push(' ');
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
    let max_chars = max_chars.max(4);
    let normalized = expand_pdf_unicode_preserving_newlines(&text.replace("\r\n", "\n").replace('\r', "\n"));
    let mut lines = Vec::new();
    for raw_line in normalized.lines() {
        let words: Vec<&str> = raw_line.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut cur = String::new();
        for w in words {
            let w_len = w.chars().count();
            if w_len > max_chars {
                if !cur.is_empty() {
                    lines.push(std::mem::take(&mut cur));
                }
                let chars: Vec<char> = w.chars().collect();
                for chunk in chars.chunks(max_chars) {
                    let s: String = chunk.iter().collect();
                    if chunk.len() == max_chars {
                        lines.push(s);
                    } else {
                        cur = s;
                    }
                }
                continue;
            }
            if cur.is_empty() {
                cur.push_str(w);
            } else if cur.chars().count() + 1 + w_len <= max_chars {
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
                "LaptopBench QC v2.7.0  |  Created by Hein Htet Zaw • Telegram: @ich8g92  |  Cert ID: {}  |  Page {}",
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

fn estimate_helvetica_bold_width(s: &str, font_size: f32) -> f32 {
    let units: f32 = s
        .chars()
        .map(|ch| match ch {
            'W' => 944.0,
            'M' => 833.0,
            'G' | 'O' | 'Q' => 778.0,
            'A' | 'B' | 'C' | 'D' | 'H' | 'K' | 'N' | 'R' | 'U' => 722.0,
            'E' | 'P' | 'S' | 'V' | 'X' | 'Y' => 667.0,
            'F' | 'L' | 'T' | 'Z' => 611.0,
            'J' => 556.0,
            'I' => 278.0,
            'm' | 'w' => 889.0,
            'a' | 'b' | 'd' | 'e' | 'g' | 'h' | 'k' | 'n' | 'o' | 'p' | 'q' | 'u' | 'v' | 'x' | 'y' => 556.0,
            'c' | 's' | 'z' => 500.0,
            'r' => 389.0,
            'f' | 't' => 333.0,
            'i' | 'j' | 'l' => 278.0,
            '0'..='9' => 556.0,
            ' ' | '.' | ',' | ':' | ';' | '!' | '|' => 278.0,
            '-' | '/' => 333.0,
            _ => 600.0,
        })
        .sum();
    (units / 1000.0) * font_size
}

const SEAL_W: f32 = 164.0;

fn fit_seal_verdict_font_size(verdict: &str, seal_w: f32) -> f32 {
    let max_w = (seal_w - 20.0).max(40.0);
    let mut font_size = if verdict.chars().count() > 14 { 9.0 } else { 11.0 };
    while font_size > 6.5 && estimate_helvetica_bold_width(verdict, font_size) > max_w {
        font_size -= 0.5;
    }
    font_size
}

fn draw_section_header(pb: &mut PageBuilder, content_w: f32, title: &str) {
    pb.ensure_space(56.0);
    pb.text("F4", 9.0, MARGIN, pb.y, COL_BLACK, title);
    pb.line(MARGIN, pb.y - 4.0, MARGIN + content_w, pb.y - 4.0, 0.8, COL_BLACK);
    pb.y -= 12.0;
}

fn draw_audit_table_header(pb: &mut PageBuilder, content_w: f32) {
    pb.rect_fill(MARGIN, pb.y - 18.0, content_w, 18.0, COL_BLACK);
    pb.text("F4", 8.0, MARGIN + 8.0, pb.y - 12.0, COL_WHITE, "STAGE / MODULE");
    pb.text("F4", 8.0, MARGIN + 158.0, pb.y - 12.0, COL_WHITE, "STATUS");
    pb.text("F4", 8.0, MARGIN + 214.0, pb.y - 12.0, COL_WHITE, "MEASURED FINDINGS, THRESHOLDS & NOTES");
    pb.y -= 18.0;
}

/// Swiss Lab Calibration Certificate (Executive Sheet + Technical Audit Ledger)
/// Strictly White, Black & Cobalt Blue.
pub fn render_qc_certificate_pdf(payload: &ExportReportPayload, generated_at: &str) -> Vec<u8> {
    let cert_id = compute_certificate_id(payload, generated_at);
    let mut pb = PageBuilder::new(cert_id.clone());
    let content_w = PAGE_W - MARGIN * 2.0;
    let stage_count = if payload.tests.is_empty() { 14 } else { payload.tests.len() };

    let shop_clean = sanitize_single_line(&payload.shop_profile.shop_name);
    let shop_title = if shop_clean.is_empty() {
        "LAPTOPBENCH QC LAB".to_string()
    } else {
        shop_clean
    };
    let tech_clean = sanitize_single_line(&payload.shop_profile.technician_name);
    let tech = if tech_clean.is_empty() {
        "Certified Technician".to_string()
    } else {
        tech_clean
    };

    // ==================== PAGE 1: EXECUTIVE CERTIFICATION SHEET ====================
    // Bold 4pt Cobalt Blue Architectural Top Rule
    pb.rect_fill(MARGIN, PAGE_H - MARGIN - 4.0, content_w, 4.0, COL_BLUE);

    let mast_top = PAGE_H - MARGIN - 16.0;

    // Right-aligned Durability Grade & Verdict Seal Box
    let seal_w = SEAL_W;
    let seal_h = 52.0;
    let seal_x = MARGIN + content_w - seal_w;
    let seal_y = mast_top - 42.0;
    let max_shop_w = seal_x - MARGIN - 14.0;

    let mut shop_display: String = shop_title.chars().take(34).collect();
    let mut shop_font = 20.0_f32;
    for candidate in [20.0_f32, 17.5, 15.5, 14.0, 12.5] {
        shop_font = candidate;
        if estimate_helvetica_bold_width(&shop_display, shop_font) <= max_shop_w {
            break;
        }
    }
    if estimate_helvetica_bold_width(&shop_display, shop_font) > max_shop_w {
        while shop_display.chars().count() > 4
            && estimate_helvetica_bold_width(&format!("{}...", shop_display), shop_font) > max_shop_w
        {
            shop_display.pop();
        }
        shop_display.push_str("...");
    }

    // Masthead Block
    pb.text("F4", 8.0, MARGIN, mast_top, COL_BLUE_DARK, "OFFICIAL HARDWARE CALIBRATION & QUALITY CONTROL CERTIFICATE");
    pb.text("F2", shop_font, MARGIN, mast_top - 22.0, COL_BLACK, &shop_display);
    let max_ref_chars = ((max_shop_w / (7.5 * 0.6)) as usize).max(40);
    let sku_clean = sanitize_single_line(&payload.customer_or_sku);
    let ref_str = if sku_clean.is_empty() {
        format!("ISSUED: {} | CERT ID: {}", generated_at, cert_id)
    } else {
        format!(
            "ISSUED: {} | SKU: {} | CERT ID: {}",
            generated_at,
            sku_clean.chars().take(18).collect::<String>(),
            cert_id
        )
    };
    let ref_display: String = ref_str.chars().take(max_ref_chars).collect();
    pb.text("F3", 7.5, MARGIN, mast_top - 36.0, COL_INK_MUTED, &ref_display);

    let is_fail = payload.overall_verdict == "FAILED";
    let grade_str: String = payload
        .durability_grade
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if is_fail { "FAIL" } else if payload.overall_verdict == "PASSED" { "A" } else { "B" })
        .chars()
        .take(8)
        .collect();

    let raw_verdict = payload.overall_verdict.trim();
    let verdict_base = if raw_verdict.is_empty() { "PENDING" } else { raw_verdict };
    let verdict_font = fit_seal_verdict_font_size(verdict_base, seal_w);
    let max_verdict_w = seal_w - 20.0;
    let verdict_lines = if estimate_helvetica_bold_width(verdict_base, verdict_font) <= max_verdict_w {
        vec![verdict_base.to_string()]
    } else {
        let mut wrapped = wrap_text(verdict_base, 22);
        wrapped.truncate(2);
        wrapped
    };

    pb.rect_fill(seal_x, seal_y, seal_w, seal_h, if is_fail { COL_BLACK } else { COL_BLUE });
    pb.text("F4", 7.5, seal_x + 10.0, seal_y + 39.0, COL_WHITE, "CERTIFIED VERDICT");
    if verdict_lines.len() == 1 {
        pb.text("F2", verdict_font, seal_x + 10.0, seal_y + 23.0, COL_WHITE, &verdict_lines[0]);
    } else {
        pb.text("F2", 7.2, seal_x + 10.0, seal_y + 27.5, COL_WHITE, &verdict_lines[0]);
        pb.text("F2", 7.2, seal_x + 10.0, seal_y + 18.5, COL_WHITE, &verdict_lines[1]);
    }
    pb.text(
        "F4",
        9.0,
        seal_x + 10.0,
        seal_y + 8.5,
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
    pb.ensure_space(stat_h + 18.0);
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
    pb.y = stat_y - 16.0;

    // 1b. Plain-Language Executive Summary ("What This Means for Long-Term Use")
    let (meaning_headline, meaning_bullets) = build_long_term_meaning(payload);
    draw_section_header(&mut pb, content_w, "00 // WHAT THIS MEANS FOR LONG-TERM USE");
    let head_lines = wrap_text(&meaning_headline, 86);
    let head_h = (head_lines.len() as f32) * 11.0 + 10.0;
    pb.ensure_space(head_h + 6.0);
    let head_y = pb.y - head_h;
    pb.rect_fill(MARGIN, head_y, content_w, head_h, COL_PAPER);
    pb.rect_stroke(MARGIN, head_y, content_w, head_h, 0.5, COL_RULE);
    pb.rect_fill(MARGIN, head_y, 3.0, head_h, COL_BLUE);
    let mut hy = pb.y - 12.0;
    for line in &head_lines {
        pb.text("F2", 8.5, MARGIN + 10.0, hy, COL_BLACK, line);
        hy -= 11.0;
    }
    pb.y = head_y - 4.0;
    for bullet in &meaning_bullets {
        let blines = wrap_text(&format!("* {}", bullet), 90);
        let bh = (blines.len() as f32) * 10.5 + 4.0;
        pb.ensure_space(bh + 2.0);
        let mut by = pb.y - 9.0;
        for line in &blines {
            pb.text("F1", 7.8, MARGIN + 10.0, by, COL_INK_MUTED, line);
            by -= 10.5;
        }
        pb.y -= bh;
    }
    pb.y -= 8.0;

    // 2. Verified Hardware Identity Grid
    draw_section_header(&mut pb, content_w, "01 // VERIFIED DEVICE HARDWARE IDENTITY");

    if let Some(specs) = &payload.specs {
        let gpu_list: String = specs.gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" / ");
        let disk_list: String = specs
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB {})", d.model, d.size_gb, d.interface_type))
            .collect::<Vec<_>>()
            .join("; ");
        let mut ram_detail = if !specs.ram_modules.is_empty() {
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
        if let Some(ch) = specs.ram_channel_mode.as_deref().filter(|s| !s.trim().is_empty()) {
            ram_detail.push_str(&format!(" — {}", ch.trim()));
        }
        let wifi_detail = match (
            specs.wifi_ssid.as_deref(),
            specs.wifi_signal_pct,
            specs.wifi_rssi_dbm,
        ) {
            (Some(ssid), Some(pct), Some(rssi)) => format!("{} ({}% / {} dBm)", ssid, pct, rssi),
            (Some(ssid), Some(pct), None) => format!("{} ({}%)", ssid, pct),
            (None, Some(pct), Some(rssi)) => format!("Connected ({}% / {} dBm)", pct, rssi),
            (Some(ssid), None, None) => ssid.to_string(),
            _ => specs
                .wifi_radio_type
                .clone()
                .unwrap_or_else(|| "N/A".to_string()),
        };

        let mut rows = vec![
            ("MODEL / CHASSIS", format!("{} {} ({})", specs.manufacturer, specs.model, specs.chassis_type)),
            ("SERIAL / BIOS", format!("S/N: {}   |   BIOS: {}", specs.serial_number, specs.bios_version)),
            ("PROCESSOR (CPU)", format!("{} ({}C / {}T, Base {} MHz)", specs.cpu_brand, specs.cpu_physical_cores, specs.cpu_logical_cores, specs.cpu_base_mhz)),
            ("SYSTEM MEMORY", ram_detail),
            ("GRAPHICS (GPU)", if gpu_list.is_empty() { "Integrated Graphics".into() } else { gpu_list }),
            ("STORAGE DRIVES", if disk_list.is_empty() { "Detected".into() } else { disk_list }),
            ("WI-FI / SIGNAL", wifi_detail),
            ("OPERATING SYSTEM", format!("{} {} ({})", specs.os_name, specs.os_version, specs.architecture)),
        ];
        if let Some(w) = specs.ram_config_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            rows.push(("RAM ADVISORY", w.trim().to_string()));
        }
        if let Some(w) = specs.wifi_antenna_warning.as_deref().filter(|s| !s.trim().is_empty()) {
            rows.push(("WI-FI ADVISORY", w.trim().to_string()));
        }
        if !specs.reliability_notes.is_empty() {
            rows.push(("RELIABILITY NOTES", specs.reliability_notes.join(" | ")));
        }

        for (idx, (k, v)) in rows.iter().enumerate() {
            let wrapped = wrap_text(v, 70);
            let row_h = (wrapped.len() as f32 * 10.5 + 7.5).max(18.0);
            pb.ensure_space(row_h + 4.0);
            let ry = pb.y - row_h;
            if idx % 2 == 0 {
                pb.rect_fill(MARGIN, ry, content_w, row_h, COL_PAPER);
            }
            pb.rect_stroke(MARGIN, ry, content_w, row_h, 0.5, COL_RULE);
            pb.text("F4", 7.3, MARGIN + 8.0, pb.y - 12.0, COL_INK_MUTED, k);
            let mut ty = pb.y - 12.0;
            for line in &wrapped {
                pb.text("F1", 8.2, MARGIN + 118.0, ty, COL_BLACK, line);
                ty -= 10.5;
            }
            pb.y = ry;
        }
        pb.y -= 14.0;
    } else {
        pb.ensure_space(24.0);
        pb.text("F1", 8.5, MARGIN, pb.y - 10.0, COL_INK_MUTED, "Hardware specification summary unavailable.");
        pb.y -= 22.0;
    }

    // 3. Visual Subsystem Health & Performance Calibration Bars
    draw_section_header(&mut pb, content_w, "02 // SUBSYSTEM HEALTH & PERFORMANCE CALIBRATION");

    if payload.subsystem_scores.is_empty() {
        pb.ensure_space(22.0);
        pb.text(
            "F1",
            8.5,
            MARGIN,
            pb.y - 8.0,
            COL_INK_MUTED,
            &format!("See Page 2+ for full {}-stage module audit results.", stage_count),
        );
        pb.y -= 22.0;
    } else {
        for bar in &payload.subsystem_scores {
            let bh = 28.0;
            pb.ensure_space(bh + 6.0);
            let by = pb.y - bh;
            pb.rect_stroke(MARGIN, by, content_w, bh, 0.5, COL_RULE);
            pb.text("F2", 8.5, MARGIN + 8.0, by + 16.5, COL_BLACK, &bar.label.chars().take(26).collect::<String>());
            let mtrunc: String = bar.metric_text.chars().take(40).collect();
            pb.text("F3", 7.3, MARGIN + 138.0, by + 16.5, COL_INK_MUTED, &mtrunc);
            let upper = bar.status_label.to_uppercase();
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
            let label_col = if is_fail {
                COL_BLACK
            } else if is_neutral_warn {
                COL_ZINC_DARK
            } else {
                COL_BLUE_DARK
            };
            let bar_col = if is_fail {
                COL_BLACK
            } else if is_neutral_warn {
                COL_ZINC_DARK
            } else {
                COL_BLUE
            };
            pb.text(
                "F4",
                7.0,
                MARGIN + content_w - 114.0,
                by + 16.5,
                label_col,
                &bar.status_label.chars().take(24).collect::<String>(),
            );

            // Track + Fill Bar
            let track_x = MARGIN + 8.0;
            let track_w = content_w - 16.0;
            let pct = (bar.score_pct.clamp(0.0, 100.0) / 100.0) as f32;
            pb.rect_fill(track_x, by + 5.5, track_w, 5.5, (0.91, 0.92, 0.94));
            pb.rect_fill(track_x, by + 5.5, (track_w * pct).max(4.0), 5.5, bar_col);
            pb.y = by - 4.0;
        }
        pb.y -= 10.0;
    }

    // 4. UserBenchmark Comparison & Vehicle Tiers
    if let Some(ub) = &payload.user_benchmark {
        draw_section_header(&mut pb, content_w, "03 // USERBENCHMARK COMPARISON & VEHICLE TIER STANDINGS");
        let head_lines = wrap_text(&ub.headline_summary, 84);
        let box_h = 26.0 + (head_lines.len() as f32) * 10.5;
        pb.ensure_space(box_h + 6.0);
        let box_y = pb.y - box_h;
        pb.rect_fill(MARGIN, box_y, content_w, box_h, COL_PAPER);
        pb.rect_stroke(MARGIN, box_y, content_w, box_h, 0.6, COL_RULE);
        pb.rect_fill(MARGIN + 8.0, pb.y - 18.0, 148.0, 13.0, COL_BLUE);
        pb.text(
            "F4",
            7.5,
            MARGIN + 12.0,
            pb.y - 14.0,
            COL_WHITE,
            &format!("TIER: {}", ub.overall_vehicle_tier.chars().take(20).collect::<String>()),
        );
        pb.text(
            "F3",
            7.8,
            MARGIN + 164.0,
            pb.y - 14.0,
            COL_BLACK,
            &format!(
                "Gaming {:.0}% | Desktop {:.0}% | WS {:.0}% | {}",
                ub.gaming_pct, ub.desktop_pct, ub.workstation_pct, ub.source_mode
            ),
        );
        let mut ty = pb.y - 30.0;
        for line in &head_lines {
            pb.text("F1", 8.0, MARGIN + 8.0, ty, COL_INK_MUTED, line);
            ty -= 10.5;
        }
        pb.y = box_y - 4.0;

        for comp in [&ub.cpu, &ub.gpu, &ub.ssd, &ub.ram].into_iter().flatten() {
            let mut summary_s = format!(
                "{} ({}) — Eff {:.1}% vs Class {:.1}% | Standing {:.0}% ({}) — {}",
                comp.detected_model,
                comp.vehicle_tier,
                comp.effective_speed_pct,
                comp.expected_class_pct,
                comp.relative_standing_pct,
                comp.standing_label,
                comp.plain_summary
            );
            if let Some(flag) = comp.bottleneck_flag.as_deref().filter(|s| !s.trim().is_empty()) {
                summary_s.push_str(&format!(" [Bottleneck: {}]", flag.trim()));
            }
            let wrapped = wrap_text(&summary_s, 72);
            let rh = (wrapped.len() as f32 * 10.5 + 8.0).max(20.0);
            pb.ensure_space(rh + 3.0);
            let ry = pb.y - rh;
            pb.rect_stroke(MARGIN, ry, content_w, rh, 0.5, COL_RULE);
            pb.text("F4", 7.8, MARGIN + 8.0, pb.y - 12.0, COL_BLUE_DARK, &comp.component.to_uppercase());
            let mut cty = pb.y - 12.0;
            for line in &wrapped {
                pb.text("F1", 7.8, MARGIN + 64.0, cty, COL_BLACK, line);
                cty -= 10.5;
            }
            pb.y = ry;
        }
        for rec in ub.recommendations.iter().take(3) {
            let rlines = wrap_text(&format!("* Recommendation: {}", rec), 88);
            let rh = (rlines.len() as f32) * 10.2 + 3.0;
            pb.ensure_space(rh + 2.0);
            let mut rty = pb.y - 9.0;
            for line in &rlines {
                pb.text("F1", 7.6, MARGIN + 8.0, rty, COL_INK_MUTED, line);
                rty -= 10.2;
            }
            pb.y -= rh;
        }
        pb.y -= 10.0;
    }

    // 5. Battery Discharge Normality, Touchscreen & Network Reliability
    if payload.battery_discharge.is_some()
        || payload.touchscreen.is_some()
        || payload.network_report.is_some()
    {
        draw_section_header(
            &mut pb,
            content_w,
            "04 // BATTERY DISCHARGE NORMALITY, TOUCHSCREEN & NETWORK RELIABILITY",
        );

        if let Some(bat) = &payload.battery_discharge {
            let metrics_line = format!(
                "Idle {:.1}W / Load {:.1}W | Power CV {:.1}% | Sag {:.0}mV | SoC {:.1}% -> {:.1}% (Max 5s Drop {:.1}%) | BMS {:.2}x | Wear {:.1}% ({} cyc)",
                bat.idle_avg_watts,
                bat.load_avg_watts,
                bat.power_cv_pct,
                bat.voltage_sag_mv,
                bat.soc_start_pct,
                bat.soc_end_pct,
                bat.max_step_drop_pct,
                bat.bms_drift_ratio,
                bat.wear_pct,
                bat.cycle_count
            );
            let mut text_block = format!("{} — {}", metrics_line, bat.plain_summary);
            if !bat.reasons.is_empty() {
                text_block.push_str(&format!(" [Reasons: {}]", bat.reasons.join("; ")));
            }
            let wrapped = wrap_text(&text_block, 84);
            let ch = 22.0 + (wrapped.len() as f32) * 10.5;
            pb.ensure_space(ch + 4.0);
            let cy = pb.y - ch;
            pb.rect_fill(MARGIN, cy, content_w, ch, COL_PAPER);
            pb.rect_stroke(MARGIN, cy, content_w, ch, 0.5, COL_RULE);
            pb.text("F4", 8.0, MARGIN + 8.0, pb.y - 13.0, COL_BLACK, "BATTERY DISCHARGE NORMALITY");
            let is_abn = bat.verdict == "ABNORMAL";
            let is_norm = bat.verdict == "NORMAL";
            let (bfill, btxt, stroke_only) = if is_abn {
                (COL_BLACK, COL_WHITE, false)
            } else if is_norm {
                (COL_BLUE, COL_WHITE, false)
            } else {
                (COL_WHITE, COL_BLUE_DARK, true)
            };
            pb.rect_fill(MARGIN + content_w - 118.0, pb.y - 16.0, 110.0, 12.0, bfill);
            if stroke_only {
                pb.rect_stroke(MARGIN + content_w - 118.0, pb.y - 16.0, 110.0, 12.0, 0.7, btxt);
            }
            let verdict_display = sanitize_single_line(&bat.verdict);
            let badge_font = if verdict_display.chars().count() > 22 { 6.2 } else { 7.0 };
            pb.text(
                "F4",
                badge_font,
                MARGIN + content_w - 114.0,
                pb.y - 12.5,
                btxt,
                &verdict_display,
            );
            let mut bty = pb.y - 26.0;
            for line in &wrapped {
                pb.text("F1", 7.8, MARGIN + 8.0, bty, COL_INK_MUTED, line);
                bty -= 10.5;
            }
            pb.y = cy - 4.0;
        }

        if let Some(ts) = &payload.touchscreen {
            let text_block = format!(
                "Capable: {} ({} pts) | {}x{} Grid: {}/{} ({:.1}%) | Multi-Touch: {} pts | RMS: {:.2}px | {:.0}Hz — {}",
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
                ts.plain_summary
            );
            let wrapped = wrap_text(&text_block, 84);
            let ch = 22.0 + (wrapped.len() as f32) * 10.5;
            pb.ensure_space(ch + 4.0);
            let cy = pb.y - ch;
            pb.rect_fill(MARGIN, cy, content_w, ch, COL_PAPER);
            pb.rect_stroke(MARGIN, cy, content_w, ch, 0.5, COL_RULE);
            pb.text("F4", 8.0, MARGIN + 8.0, pb.y - 13.0, COL_BLACK, "TOUCHSCREEN DISPLAY DIGITIZER");
            let is_fail_ts = ts.verdict == "FAIL";
            let is_pass_ts = ts.verdict == "PASS";
            let (tfill, ttxt, tstroke) = if is_fail_ts {
                (COL_BLACK, COL_WHITE, false)
            } else if is_pass_ts {
                (COL_BLUE, COL_WHITE, false)
            } else {
                (COL_WHITE, COL_INK_MUTED, true)
            };
            pb.rect_fill(MARGIN + content_w - 76.0, pb.y - 16.0, 68.0, 12.0, tfill);
            if tstroke {
                pb.rect_stroke(MARGIN + content_w - 76.0, pb.y - 16.0, 68.0, 12.0, 0.7, ttxt);
            }
            pb.text("F4", 7.2, MARGIN + content_w - 66.0, pb.y - 12.5, ttxt, &ts.verdict);
            let mut tty = pb.y - 26.0;
            for line in &wrapped {
                pb.text("F1", 7.8, MARGIN + 8.0, tty, COL_INK_MUTED, line);
                tty -= 10.5;
            }
            pb.y = cy - 4.0;
        }

        if let Some(net) = &payload.network_report {
            let link_s = net
                .link_speed_mbps
                .map(|m| format!("{:.0} Mbps", m))
                .unwrap_or_else(|| "N/A".into());
            let ping_s = net
                .gateway_ping_ms
                .map(|p| format!("{:.1} ms", p))
                .unwrap_or_else(|| "N/A".into());
            let wifi_s = match (
                net.wifi_ssid.as_deref().filter(|s| !s.trim().is_empty()),
                net.wifi_signal_pct,
                net.rssi_dbm,
            ) {
                (Some(ssid), Some(pct), Some(rssi)) => format!("{} ({}% / {} dBm)", ssid, pct, rssi),
                (Some(ssid), Some(pct), None) => format!("{} ({}% / N/A dBm)", ssid, pct),
                (Some(ssid), None, Some(rssi)) => format!("{} (N/A / {} dBm)", ssid, rssi),
                (Some(ssid), None, None) => format!("{} (Signal N/A)", ssid),
                (None, Some(pct), Some(rssi)) => format!("Connected ({}% / {} dBm)", pct, rssi),
                (None, Some(pct), None) => format!("Connected ({}%)", pct),
                (None, None, Some(rssi)) => format!("Connected ({} dBm)", rssi),
                (None, None, None) => "Wired / N/A".into(),
            };
            let text_block = format!(
                "Interface: {} | Link: {} | Wi-Fi: {} | Ping: {} | Loss: {:.0}% | DNS: {} — {}",
                net.interface_name,
                link_s,
                wifi_s,
                ping_s,
                net.packet_loss_pct,
                if net.dns_resolve_ok { "OK" } else { "FAIL" },
                net.plain_summary
            );
            let wrapped = wrap_text(&text_block, 84);
            let ch = 22.0 + (wrapped.len() as f32) * 10.5;
            pb.ensure_space(ch + 4.0);
            let cy = pb.y - ch;
            pb.rect_fill(MARGIN, cy, content_w, ch, COL_PAPER);
            pb.rect_stroke(MARGIN, cy, content_w, ch, 0.5, COL_RULE);
            pb.text("F4", 8.0, MARGIN + 8.0, pb.y - 13.0, COL_BLACK, "NETWORK & WI-FI DIAGNOSTICS");
            let (nfill, ntxt, nstroke) = if net.verdict == "POOR_LINK" {
                (COL_BLACK, COL_WHITE, false)
            } else if net.verdict == "HEALTHY" {
                (COL_BLUE, COL_WHITE, false)
            } else {
                (COL_WHITE, COL_BLUE_DARK, true)
            };
            pb.rect_fill(MARGIN + content_w - 108.0, pb.y - 16.0, 100.0, 12.0, nfill);
            if nstroke {
                pb.rect_stroke(MARGIN + content_w - 108.0, pb.y - 16.0, 100.0, 12.0, 0.7, ntxt);
            }
            pb.text(
                "F4",
                7.0,
                MARGIN + content_w - 102.0,
                pb.y - 12.5,
                ntxt,
                &net.verdict.chars().take(16).collect::<String>(),
            );
            let mut nty = pb.y - 26.0;
            for line in &wrapped {
                pb.text("F1", 7.8, MARGIN + 8.0, nty, COL_INK_MUTED, line);
                nty -= 10.5;
            }
            pb.y = cy - 4.0;
        }

        pb.y -= 8.0;
    }

    // 6. Physical Inspection Sign-Off, Offline Verification QR & Dual Signature Block
    let ports_s = sanitize_single_line(&format!(
        "PORTS (USB/HDMI/DC): {} {}",
        if payload.signoff.ports_checked { "[VERIFIED]" } else { "[UNCONFIRMED]" },
        payload.signoff.ports_notes.trim()
    ));
    let spk_s = sanitize_single_line(&format!(
        "SPEAKERS (L/R):      {} {}",
        if payload.signoff.speakers_checked { "[VERIFIED]" } else { "[UNCONFIRMED]" },
        payload.signoff.speakers_notes.trim()
    ));
    let default_notes = format!("Unit inspected per {}-stage LaptopBench QC v2.7.0 protocol.", stage_count);
    let notes_s = format!(
        "NOTES: {}",
        if payload.technician_notes.trim().is_empty() {
            default_notes.as_str()
        } else {
            payload.technician_notes.trim()
        }
    );
    let notes_lines = wrap_text(&notes_s, 72);
    // Optional Physical & Cosmetic Condition Strip
    if let Some(cos) = &payload.cosmetic {
        pb.ensure_space(56.0);
        let cos_h = 44.0;
        let cos_y = pb.y - cos_h;
        pb.rect_fill(MARGIN, cos_y, content_w, cos_h, COL_PAPER);
        pb.rect_stroke(MARGIN, cos_y, content_w, cos_h, 0.7, COL_RULE);
        pb.text(
            "F4",
            8.2,
            MARGIN + 10.0,
            pb.y - 13.0,
            COL_BLUE,
            &format!(
                "PHYSICAL & COSMETIC GRADE: {}   |   PHOTOS ATTACHED: {}",
                cos.grade.to_uppercase(),
                cos.photos.len()
            ),
        );
        let checks = format!(
            "Chassis:{} | Screen:{} | Hinges:{} | Palmrest:{} | Seals:{} | OEM Charger:{}",
            if cos.chassis_ok { "OK" } else { "WEAR" },
            if cos.screen_coating_ok { "OK" } else { "WEAR" },
            if cos.hinges_ok { "OK" } else { "LOOSE" },
            if cos.palmrest_ok { "OK" } else { "WEAR" },
            if cos.screws_seals_ok { "OK" } else { "OPENED" },
            if cos.oem_charger_included { "YES" } else { "NO" }
        );
        pb.text("F3", 7.3, MARGIN + 10.0, pb.y - 25.5, COL_BLACK, &checks);
        let cnote = if cos.notes.trim().is_empty() {
            "Condition documented in HTML archive with attached condition photos.".to_string()
        } else {
            format!("Notes: {}", cos.notes.trim())
        };
        pb.text(
            "F1",
            7.4,
            MARGIN + 10.0,
            pb.y - 36.5,
            COL_INK_MUTED,
            &cnote.chars().take(96).collect::<String>(),
        );
        pb.y = cos_y - 10.0;
    }

    let box_h = (82.0 + (notes_lines.len() as f32) * 10.5).max(110.0);

    pb.ensure_space(box_h + 26.0);
    pb.text("F4", 9.0, MARGIN, pb.y, COL_BLACK, "05 // PHYSICAL SIGN-OFF, OFFLINE QR SEAL & AUTHORIZATION");
    pb.line(MARGIN, pb.y - 4.0, MARGIN + content_w, pb.y - 4.0, 0.8, COL_BLACK);
    pb.y -= 10.0;

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

    pb.text("F3", 7.8, MARGIN + 10.0, pb.y - 16.0, COL_BLACK, &ports_s.chars().take(66).collect::<String>());
    pb.text("F3", 7.8, MARGIN + 10.0, pb.y - 29.0, COL_BLACK, &spk_s.chars().take(66).collect::<String>());
    let mut ny = pb.y - 44.0;
    for line in &notes_lines {
        pb.text("F1", 8.0, MARGIN + 10.0, ny, COL_INK_MUTED, line);
        ny -= 10.5;
    }

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

    // ==================== APPENDIX A: FULL STAGE TECHNICAL AUDIT LEDGER ====================
    pb.finish_page();

    pb.rect_fill(MARGIN, PAGE_H - MARGIN - 3.0, content_w, 3.0, COL_BLACK);
    pb.text(
        "F4",
        10.0,
        MARGIN,
        PAGE_H - MARGIN - 18.0,
        COL_BLACK,
        &format!("APPENDIX A // {}-STAGE DIAGNOSTIC AUDIT LEDGER", stage_count),
    );
    pb.text(
        "F3",
        8.0,
        MARGIN,
        PAGE_H - MARGIN - 30.0,
        COL_INK_MUTED,
        &format!("CERT ID: {}   |   SHOP: {}   |   DATE: {}", cert_id, shop_title.chars().take(28).collect::<String>(), generated_at),
    );
    pb.y = PAGE_H - MARGIN - 44.0;

    draw_audit_table_header(&mut pb, content_w);

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
        let prev_y = pb.y;
        pb.ensure_space(row_h + 6.0);
        if pb.y > prev_y {
            draw_audit_table_header(&mut pb, content_w);
        }

        let row_y = pb.y - row_h;
        if idx % 2 == 1 {
            pb.rect_fill(MARGIN, row_y, content_w, row_h, COL_PAPER);
        }
        pb.rect_stroke(MARGIN, row_y, content_w, row_h, 0.5, COL_RULE);

        pb.text("F2", 8.2, MARGIN + 8.0, pb.y - 13.0, COL_BLACK, &t.name.chars().take(26).collect::<String>());
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
    use crate::types::{
        BatteryDischargeResult, NetworkDiagnosticsReport, PortsSpeakerSignoff, ReportTestEntry,
        ShopProfile, SubsystemScoreBar, SystemSpecs, TouchscreenTestResult,
        UserBenchmarkComparison, UserBenchmarkComponentRating,
    };

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
                name: "11. RAM Stress Test".into(),
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
            ..Default::default()
        };
        let bytes = render_qc_certificate_pdf(&payload, "2026-11-25 22:00:00");
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("LaptopBench QC v2.7.0"));
        assert!(text.contains("Created by Hein Htet Zaw"));
        assert!(text.contains("@ich8g92"));
        assert!(!text.contains("v2.1"));
        assert!(!text.contains("13-STAGE"));
    }

    #[test]
    fn test_pdf_escape_and_wrap_text_long_unspaced_tokens() {
        let escaped = pdf_escape("It’s “good”… ≥90% ≤95°C 16×10 ±2 → Pass™®");
        assert!(!escaped.contains('?'), "unexpected '?' in {}", escaped);
        assert!(escaped.contains("It's \"good\"... >=90% <=95 deg C 16x10 +/-2 -> Pass(TM)(R)"));

        let long_token = "SUPERLONGMODELIDENTIFIERWITHOUTANYSPACES1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let wrapped = wrap_text(long_token, 20);
        assert!(wrapped.len() >= 4);
        for line in &wrapped {
            assert!(line.chars().count() <= 20, "line overflowed: {}", line);
        }
        assert_eq!(wrapped.concat(), long_token);
    }

    #[test]
    fn test_pdf_v230_multipage_pagination_and_sections() {
        let bars = (1..=8)
            .map(|i| SubsystemScoreBar {
                label: format!("Subsystem {}", i),
                score_pct: if i == 1 { 45.0 } else { 92.0 },
                metric_text: format!("Metric {} • calibrated", i),
                status_label: if i == 1 { "ABNORMAL".into() } else { "PASS".into() },
            })
            .collect();
        let tests = (1..=14)
            .map(|i| ReportTestEntry {
                id: format!("s{}", i),
                name: format!("{:02}. Stage {}", i, i),
                category: "Diagnostic".into(),
                status: TestStatus::Pass,
                summary: format!(
                    "Stage {} verified cleanly with UNSPACEDTOKEN_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.",
                    i
                ),
                metrics: vec![("SafeBudget".into(), "256 MB".into())],
                notes: "No throttling".into(),
            })
            .collect();

        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Precision Lab".into(),
                technician_name: "Hein Htet Zaw".into(),
                logo_data_url: None,
                default_output_dir: None,
            },
            customer_or_sku: "PRO-14".into(),
            technician_notes: String::new(),
            overall_verdict: "PASSED WITH WARNINGS".into(),
            durability_grade: Some("B".into()),
            subsystem_scores: bars,
            specs: Some(SystemSpecs {
                manufacturer: "ASUS".into(),
                model: "ROG Zephyrus G14".into(),
                chassis_type: "Notebook".into(),
                serial_number: "SN-G14-2026".into(),
                cpu_brand: "AMD Ryzen 9 8945HS".into(),
                cpu_physical_cores: 8,
                cpu_logical_cores: 16,
                ram_channel_mode: Some("Dual Channel".into()),
                ram_config_warning: Some("16 GB soldered + 16 GB SO-DIMM".into()),
                wifi_ssid: Some("Lab5G".into()),
                wifi_signal_pct: Some(88),
                wifi_rssi_dbm: Some(-54),
                reliability_notes: vec!["Zero WHEA errors in 30d".into()],
                ..Default::default()
            }),
            tests,
            signoff: PortsSpeakerSignoff {
                ports_checked: true,
                ports_notes: "All ports OK".into(),
                speakers_checked: true,
                speakers_notes: "L/R OK".into(),
            },
            plain_verdict_summary: Some("Strong gaming and creator unit with battery advisory.".into()),
            user_benchmark: Some(UserBenchmarkComparison {
                gaming_pct: 102.0,
                desktop_pct: 99.0,
                workstation_pct: 96.0,
                overall_vehicle_tier: "UFO".into(),
                headline_summary: "Flagship mobile performance.".into(),
                source_mode: "offline_calibrated".into(),
                recommendations: vec!["Replace battery before heavy travel use.".into()],
                cpu: Some(UserBenchmarkComponentRating {
                    component: "cpu".into(),
                    detected_model: "Ryzen 9 8945HS".into(),
                    effective_speed_pct: 103.0,
                    expected_class_pct: 98.0,
                    relative_standing_pct: 105.1,
                    vehicle_tier: "UFO".into(),
                    standing_label: "Above Expectations".into(),
                    plain_summary: "Top-tier CPU score.".into(),
                    source_mode: "offline_calibrated".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            battery_discharge: Some(BatteryDischargeResult {
                status: TestStatus::Warn,
                verdict: "ABNORMAL".into(),
                plain_summary: "Unstable wattage and voltage sag detected.".into(),
                reasons: vec!["Power CV > 35%".into()],
                idle_avg_watts: 8.5,
                load_avg_watts: 31.2,
                power_cv_pct: 38.4,
                voltage_sag_mv: 640.0,
                soc_start_pct: 75.0,
                soc_end_pct: 71.0,
                max_step_drop_pct: 3.5,
                wear_pct: 29.0,
                cycle_count: 410,
                bms_drift_ratio: 1.4,
                duration_secs: 55.0,
                ..Default::default()
            }),
            touchscreen: Some(TouchscreenTestResult {
                touch_capable: false,
                status: TestStatus::Skipped,
                verdict: "SKIPPED".into(),
                plain_summary: "Non-touch matte panel skipped cleanly.".into(),
                ..Default::default()
            }),
            network_report: Some(NetworkDiagnosticsReport {
                status: TestStatus::Pass,
                interface_name: "Wi-Fi 6E".into(),
                link_speed_mbps: Some(1200.0),
                wifi_ssid: Some("Lab5G".into()),
                wifi_signal_pct: Some(88),
                rssi_dbm: Some(-54),
                gateway_ping_ms: Some(1.9),
                dns_resolve_ok: true,
                packet_loss_pct: 0.0,
                verdict: "HEALTHY".into(),
                plain_summary: "Healthy wireless link.".into(),
            }),
            cpu_stress: None,
            cosmetic: None,
            output_dir: None,
        };

        let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("WHAT THIS MEANS FOR LONG-TERM USE"));
        assert!(text.contains("USERBENCHMARK COMPARISON"));
        assert!(text.contains("BATTERY DISCHARGE NORMALITY"));
        assert!(text.contains("TOUCHSCREEN DISPLAY DIGITIZER"));
        assert!(text.contains("NETWORK & WI-FI DIAGNOSTICS"));
        assert!(text.contains("14-STAGE DIAGNOSTIC AUDIT LEDGER"));
        assert!(text.contains("ABNORMAL"));
        assert!(text.contains("Page 3"));
        assert!(!text.contains("v2.1"));
        assert!(!text.contains("13-STAGE"));
    }

    #[test]
    fn test_pdf_seal_box_verdict_and_shop_title_fit() {
        let verdict = "PASSED WITH WARNINGS";
        let font_sz = fit_seal_verdict_font_size(verdict, SEAL_W);
        let text_w = estimate_helvetica_bold_width(verdict, font_sz);
        assert!(
            text_w < SEAL_W - 16.0,
            "verdict '{}' width {:.2} pt at {:.1} pt must fit inside seal_w - 16 = {:.2} pt",
            verdict,
            text_w,
            font_sz,
            SEAL_W - 16.0
        );

        let content_w = PAGE_W - MARGIN * 2.0;
        let seal_x = MARGIN + content_w - SEAL_W;
        let right_edge = MARGIN + content_w; // 557.0
        assert!((right_edge - 557.0).abs() < 0.01);
        assert!(
            (seal_x + 10.0) + text_w < right_edge,
            "seal text right edge {:.2} must stay strictly left of {:.2}",
            seal_x + 10.0 + text_w,
            right_edge
        );

        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW".into(),
                technician_name: "Technician".into(),
                logo_data_url: None,
                default_output_dir: None,
            },
            customer_or_sku: "REF-LONG-SKU-12345678".into(),
            overall_verdict: verdict.into(),
            durability_grade: Some("B".into()),
            ..Default::default()
        };
        let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
        let text = String::from_utf8_lossy(&bytes);
        let expected_cmd = format!(
            "BT /F2 {:.1} Tf {:.2} 769.00 Td ({}) Tj ET",
            font_sz,
            seal_x + 10.0,
            verdict
        );
        assert!(
            text.contains(&expected_cmd),
            "expected seal verdict operator '{}'",
            expected_cmd
        );
        // Ensure wide shop title adapted down and did not stay at 20.0 pt overflowing into seal_x
        assert!(!text.contains("BT /F2 20.0 Tf 38.00 766.00 Td (WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW) Tj ET"));
    }

    #[test]
    fn test_pdf_network_diagnostics_no_debug_format_and_subsystem_badge_intact() {
        let bars = vec![
            SubsystemScoreBar {
                label: "UserBenchmark Class Index".into(),
                score_pct: 94.0,
                metric_text: "Nuclear Submarine • Desk 94% / Game 91% / WS 92%".into(),
                status_label: "NUCLEAR SUBMARINE".into(),
            },
            SubsystemScoreBar {
                label: "GPU / VRAM / Power".into(),
                score_pct: 84.0,
                metric_text: "RTX 4060 Laptop • 85.2 FPS".into(),
                status_label: "AIRCRAFT CARRIER".into(),
            },
        ];

        for (ssid, sig, rssi) in [
            (Some("Office-5G"), Some(54), None),
            (Some("Office-5G"), None, Some(-78)),
            (None, None, None),
            (Some("Lab5G"), Some(88), Some(-54)),
        ] {
            let payload = ExportReportPayload {
                shop_profile: ShopProfile {
                    shop_name: "Swiss Lab".into(),
                    technician_name: "Tester".into(),
                    logo_data_url: None,
                    default_output_dir: None,
                },
                overall_verdict: "PASSED WITH WARNINGS".into(),
                subsystem_scores: bars.clone(),
                network_report: Some(NetworkDiagnosticsReport {
                    status: TestStatus::Warn,
                    interface_name: "Wi-Fi 6".into(),
                    link_speed_mbps: Some(866.0),
                    wifi_ssid: ssid.map(str::to_string),
                    wifi_signal_pct: sig,
                    rssi_dbm: rssi,
                    gateway_ping_ms: Some(12.4),
                    dns_resolve_ok: true,
                    packet_loss_pct: 0.0,
                    verdict: "DEGRADED".into(),
                    plain_summary: "Moderate RSSI.".into(),
                }),
                ..Default::default()
            };
            let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("Some("), "Rust Debug Some() leaked in PDF: {}", text);
            assert!(!text.contains("None%"), "Rust Debug None% leaked in PDF: {}", text);
            assert!(!text.contains("None dBm"), "Rust Debug None dBm leaked in PDF: {}", text);
            assert!(text.contains("(NUCLEAR SUBMARINE)"), "Expected intact NUCLEAR SUBMARINE badge");
            assert!(!text.contains("(NUCLEAR SUBM)"), "Unexpected truncated NUCLEAR SUBM badge");
            assert!(text.contains("(AIRCRAFT CARRIER)"), "Expected intact AIRCRAFT CARRIER badge");
            assert!(!text.contains("(AIRCRAFT CAR)"), "Unexpected truncated AIRCRAFT CAR badge");
        }
    }

    #[test]
    fn test_pdf_page1_section00_retains_critical_findings_with_many_userbenchmark_bullets() {
        let mk_comp = |name: &str| UserBenchmarkComponentRating {
            component: name.into(),
            detected_model: format!("Test {}", name),
            effective_speed_pct: 42.0,
            expected_class_pct: 85.0,
            relative_standing_pct: 49.4,
            vehicle_tier: "Speedboat".into(),
            standing_label: "Underperforming".into(),
            plain_summary: "Below class expectations.".into(),
            source_mode: "offline_calibrated".into(),
            bottleneck_flag: Some(format!("{} bottleneck advisory for testing priority", name)),
            ..Default::default()
        };

        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss Lab".into(),
                technician_name: "Tester".into(),
                ..Default::default()
            },
            overall_verdict: "FAILED".into(),
            durability_grade: Some("FAIL".into()),
            specs: Some(SystemSpecs {
                manufacturer: "Lenovo".into(),
                model: "ThinkPad".into(),
                serial_number: "SN-CRIT-01".into(),
                ram_config_warning: Some("Single-channel RAM bottleneck detected.".into()),
                ..Default::default()
            }),
            user_benchmark: Some(UserBenchmarkComparison {
                gaming_pct: 40.0,
                desktop_pct: 45.0,
                workstation_pct: 42.0,
                overall_vehicle_tier: "Speedboat".into(),
                headline_summary: "Multiple bottlenecks.".into(),
                source_mode: "offline_calibrated".into(),
                cpu: Some(mk_comp("cpu")),
                gpu: Some(mk_comp("gpu")),
                ssd: Some(mk_comp("ssd")),
                ram: Some(mk_comp("ram")),
                recommendations: vec![
                    "Recommendation 1: add RAM.".into(),
                    "Recommendation 2: clean fans.".into(),
                    "Recommendation 3: check NVMe.".into(),
                ],
            }),
            battery_discharge: Some(BatteryDischargeResult {
                status: TestStatus::Fail,
                verdict: "ABNORMAL".into(),
                plain_summary: "Sudden SoC drop detected.".into(),
                reasons: vec!["SoC cliff 4.5%/5s".into()],
                ..Default::default()
            }),
            tests: vec![ReportTestEntry {
                id: "storage".into(),
                name: "05. SSD SMART & Speed".into(),
                category: "Storage".into(),
                status: TestStatus::Fail,
                summary: "NVMe failure detected.".into(),
                metrics: vec![
                    ("Wear (Log 0x02)".into(), "104%".into()),
                    ("Spare".into(), "5%".into()),
                    ("Media Err".into(), "3".into()),
                    ("Unsafe Off".into(), "60".into()),
                ],
                notes: String::new(),
            }],
            ..Default::default()
        };

        let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
        let text = String::from_utf8_lossy(&bytes);
        // Extract Section 00 slice on Page 1 (between 00 // and 01 //)
        let sec00_start = text.find("00 // WHAT THIS MEANS FOR LONG-TERM USE").expect("Section 00 present");
        let sec01_start = text.find("01 // VERIFIED DEVICE HARDWARE IDENTITY").expect("Section 01 present");
        assert!(sec00_start < sec01_start);
        let sec00 = &text[sec00_start..sec01_start];

        assert!(sec00.contains("CRITICAL FAIL"), "Section 00 missing CRITICAL FAIL: {}", sec00);
        assert!(sec00.contains("ABNORMAL"), "Section 00 missing Battery ABNORMAL: {}", sec00);
        assert!(sec00.contains("DriveDx NVMe SMART Log 0x02"), "Section 00 missing SMART Log 0x02: {}", sec00);
        assert!(sec00.contains("Memory Configuration Warning"), "Section 00 missing RAM config warning: {}", sec00);
    }

    #[test]
    fn test_pdf_unicode_wrap_multiline_notes_and_insufficient_samples() {
        let deg_str = "°".repeat(80);
        for line in wrap_text(&deg_str, 80) {
            let escaped = pdf_escape(&line);
            assert!(
                escaped.len() <= 80,
                "Wrapped degree line expanded to {} bytes (> 80): {}",
                escaped.len(),
                escaped
            );
        }

        let arrow_str = "→".repeat(80);
        for line in wrap_text(&arrow_str, 70) {
            let escaped = pdf_escape(&line);
            assert!(
                escaped.len() <= 70,
                "Wrapped arrow line expanded to {} bytes (> 70): {}",
                escaped.len(),
                escaped
            );
        }

        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss\nLab\r\nQC".into(),
                technician_name: "Alex\nTester".into(),
                ..Default::default()
            },
            technician_notes: "Line one verified.\nLine two thermal OK.\r\nLine three ready.".into(),
            overall_verdict: "PASSED WITH WARNINGS".into(),
            battery_discharge: Some(BatteryDischargeResult {
                status: TestStatus::Warn,
                verdict: "INSUFFICIENT_SAMPLES".into(),
                plain_summary: "Insufficient readings.".into(),
                ..Default::default()
            }),
            ..Default::default()
        };

        let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("(Swiss Lab QC)"), "Expected sanitized single-line shop name in PDF");
        assert!(!text.contains("Swiss?Lab"), "Newline in shop_name leaked as '?'");
        assert!(text.contains("Line one verified."), "Missing line 1 of technician_notes");
        assert!(text.contains("Line two thermal OK."), "Missing line 2 of technician_notes");
        assert!(text.contains("Line three ready."), "Missing line 3 of technician_notes");
        assert!(!text.contains("verified.?Line"), "Newline in technician_notes leaked as '?'");
        assert!(
            text.contains("(INSUFFICIENT_SAMPLES)"),
            "Expected full 20-char INSUFFICIENT_SAMPLES verdict intact in PDF"
        );
    }

    #[test]
    fn test_pdf_subsystem_bars_fail_and_cancelled_render_non_blue() {
        let payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss Lab".into(),
                technician_name: "Tester".into(),
                ..Default::default()
            },
            overall_verdict: "FAILED".into(),
            durability_grade: Some("FAIL".into()),
            subsystem_scores: vec![
                SubsystemScoreBar {
                    label: "SSD Direct-IO".into(),
                    score_pct: 15.0,
                    metric_text: "R 6100 / W 3200 MB/s • Thermal Cutoff".into(),
                    status_label: "FAIL".into(),
                },
                SubsystemScoreBar {
                    label: "RAM Stability (TM5)".into(),
                    score_pct: 50.0,
                    metric_text: "2.5 GB verified • 0 bit errors".into(),
                    status_label: "CANCELLED".into(),
                },
            ],
            ..Default::default()
        };

        let bytes = render_qc_certificate_pdf(&payload, "2026-11-26 10:30:00");
        let text = String::from_utf8_lossy(&bytes);
        let sec02_start = text
            .find("02 // SUBSYSTEM HEALTH & PERFORMANCE CALIBRATION")
            .expect("Section 02 present");
        let sec05_start = text
            .find("05 // PHYSICAL SIGN-OFF")
            .expect("Section 05 present");
        let sec02 = &text[sec02_start..sec05_start];

        assert!(
            sec02.contains("0.035 0.035 0.043 rg"),
            "Expected COL_BLACK fill for FAIL bar in Section 02: {}",
            sec02
        );
        assert!(
            sec02.contains("0.247 0.247 0.275 rg"),
            "Expected COL_ZINC_DARK fill for CANCELLED bar in Section 02: {}",
            sec02
        );
        assert!(
            !sec02.contains("0.145 0.388 0.922 rg"),
            "FAIL and CANCELLED bars must not render Cobalt Blue fill (0.145 0.388 0.922): {}",
            sec02
        );
        assert!(
            !sec02.contains("0.114 0.306 0.847 rg"),
            "FAIL and CANCELLED labels must not render dark Cobalt Blue (0.114 0.306 0.847): {}",
            sec02
        );
    }

    #[test]
    fn test_pdf_section02_network_and_battery_discharge_render_non_blue() {
        let extract_sec02 = |payload: &ExportReportPayload| -> String {
            let bytes = render_qc_certificate_pdf(payload, "2026-11-26 10:30:00");
            let text = String::from_utf8_lossy(&bytes);
            let sec02_start = text
                .find("02 // SUBSYSTEM HEALTH & PERFORMANCE CALIBRATION")
                .expect("Section 02 present");
            let sec05_start = text
                .find("05 // PHYSICAL SIGN-OFF")
                .expect("Section 05 present");
            text[sec02_start..sec05_start].to_string()
        };

        let poor_payload = ExportReportPayload {
            shop_profile: ShopProfile {
                shop_name: "Swiss Lab".into(),
                technician_name: "Tester".into(),
                ..Default::default()
            },
            overall_verdict: "FAILED".into(),
            durability_grade: Some("FAIL".into()),
            subsystem_scores: vec![SubsystemScoreBar {
                label: "Network & Wi-Fi Link".into(),
                score_pct: 45.0,
                metric_text: "Wi-Fi • 54 Mbps • 142.0ms".into(),
                status_label: "POOR_LINK".into(),
            }],
            ..Default::default()
        };
        let poor_sec02 = extract_sec02(&poor_payload);
        assert!(
            poor_sec02.contains("0.035 0.035 0.043 rg") && poor_sec02.contains("(POOR_LINK)"),
            "Expected COL_BLACK fill and intact POOR_LINK label in Section 02: {}",
            poor_sec02
        );
        assert!(
            !poor_sec02.contains("0.145 0.388 0.922 rg"),
            "POOR_LINK bar must not render Cobalt Blue fill: {}",
            poor_sec02
        );
        assert!(
            !poor_sec02.contains("0.114 0.306 0.847 rg"),
            "POOR_LINK label must not render dark Cobalt Blue: {}",
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
            let payload = ExportReportPayload {
                shop_profile: ShopProfile {
                    shop_name: "Swiss Lab".into(),
                    technician_name: "Tester".into(),
                    ..Default::default()
                },
                overall_verdict: "PASSED WITH WARNINGS".into(),
                subsystem_scores: vec![SubsystemScoreBar {
                    label: if warn_label == "NO_ACTIVE_LINK"
                        || warn_label == "DEGRADED"
                        || warn_label == "LOCAL_ONLY_NO_DNS"
                    {
                        "Network & Wi-Fi Link".into()
                    } else {
                        "Battery Health & Discharge".into()
                    },
                    score_pct: 65.0,
                    metric_text: format!("Status {}", warn_label),
                    status_label: warn_label.into(),
                }],
                ..Default::default()
            };
            let sec02 = extract_sec02(&payload);
            assert!(
                sec02.contains("0.247 0.247 0.275 rg"),
                "Expected COL_ZINC_DARK fill for {} in Section 02: {}",
                warn_label,
                sec02
            );
            assert!(
                sec02.contains(&format!("({})", warn_label)),
                "Expected intact ({}) label without truncation in Section 02: {}",
                warn_label,
                sec02
            );
            assert!(
                !sec02.contains("0.145 0.388 0.922 rg"),
                "{} bar must not render Cobalt Blue fill: {}",
                warn_label,
                sec02
            );
            assert!(
                !sec02.contains("0.114 0.306 0.847 rg"),
                "{} label must not render dark Cobalt Blue: {}",
                warn_label,
                sec02
            );
        }
    }
}
