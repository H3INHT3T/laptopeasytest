use crate::types::{ExportReportPayload, TestStatus};
use std::fmt::Write as _;
use std::io::Write as _;

const PAGE_W: f32 = 595.0;
const PAGE_H: f32 = 842.0;
const MARGIN: f32 = 42.0;

fn pdf_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        // Keep printable ASCII for standard Helvetica built-in Type1 font
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
}

impl PageBuilder {
    fn new() -> Self {
        Self {
            pages: Vec::new(),
            cur: String::new(),
            y: PAGE_H - MARGIN,
        }
    }

    fn finish_page(&mut self) {
        if !self.cur.is_empty() {
            let page_num = self.pages.len() + 1;
            let _ = writeln!(
                self.cur,
                "0.45 0.50 0.58 rg BT /F1 8 Tf {} 22 Td (Generated offline by LaptopBench QC  |  Page {}) Tj ET",
                MARGIN, page_num
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

    fn rect_fill(&mut self, x: f32, y_bottom: f32, w: f32, h: f32, r: f32, g: f32, b: f32) {
        let _ = writeln!(
            self.cur,
            "{:.3} {:.3} {:.3} rg {:.2} {:.2} {:.2} {:.2} re f",
            r, g, b, x, y_bottom, w, h
        );
    }

    fn rect_stroke(&mut self, x: f32, y_bottom: f32, w: f32, h: f32, r: f32, g: f32, b: f32) {
        let _ = writeln!(
            self.cur,
            "0.6 w {:.3} {:.3} {:.3} RG {:.2} {:.2} {:.2} {:.2} re S",
            r, g, b, x, y_bottom, w, h
        );
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
        // 3: Font F1 (Helvetica)
        // 4: Font F2 (Helvetica-Bold)
        // For each page i in 0..page_count:
        //   obj 5 + i*2     : Page
        //   obj 5 + i*2 + 1 : Content stream
        let mut objects: Vec<Vec<u8>> = Vec::new();
        let mut kids_refs = String::new();
        for i in 0..page_count {
            let page_obj_id = 5 + i * 2;
            let _ = write!(kids_refs, "{} 0 R ", page_obj_id);
        }

        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(
            format!("<< /Type /Pages /Kids [ {}] /Count {} >>", kids_refs, page_count).into_bytes(),
        );
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>".to_vec());

        for (i, stream) in self.pages.iter().enumerate() {
            let content_obj_id = 5 + i * 2 + 1;
            let page_dict = format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.0} {:.0}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {} 0 R >>",
                PAGE_W, PAGE_H, content_obj_id
            );
            objects.push(page_dict.into_bytes());

            let bytes = stream.as_bytes();
            let mut content_obj = Vec::with_capacity(bytes.len() + 64);
            let _ = write!(
                &mut content_obj,
                "<< /Length {} >>\nstream\n",
                bytes.len()
            );
            content_obj.extend_from_slice(bytes);
            content_obj.extend_from_slice(b"\nendstream");
            objects.push(content_obj);
        }

        let mut pdf = Vec::with_capacity(16384);
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

fn verdict_rgb(verdict: &str) -> (f32, f32, f32) {
    match verdict {
        "PASSED" => (0.06, 0.58, 0.36),
        "PASSED WITH WARNINGS" => (0.82, 0.52, 0.05),
        "FAILED" => (0.82, 0.16, 0.20),
        _ => (0.35, 0.42, 0.52),
    }
}

fn status_badge(st: &TestStatus) -> (&'static str, (f32, f32, f32)) {
    match st {
        TestStatus::Pass => ("PASS", (0.06, 0.58, 0.36)),
        TestStatus::Warn => ("WARN", (0.82, 0.52, 0.05)),
        TestStatus::Fail => ("FAIL", (0.82, 0.16, 0.20)),
        TestStatus::NotApplicable => ("N/A", (0.45, 0.50, 0.58)),
        TestStatus::Running => ("RUN", (0.10, 0.48, 0.80)),
        TestStatus::Pending => ("SKIP", (0.50, 0.55, 0.62)),
    }
}

pub fn render_qc_certificate_pdf(payload: &ExportReportPayload, generated_at: &str) -> Vec<u8> {
    let mut pb = PageBuilder::new();
    let content_w = PAGE_W - MARGIN * 2.0;

    // Header Banner
    let banner_h = 84.0;
    let banner_y = PAGE_H - MARGIN - banner_h;
    pb.rect_fill(MARGIN, banner_y, content_w, banner_h, 0.06, 0.10, 0.17);

    let shop_title = if payload.shop_profile.shop_name.trim().is_empty() {
        "LaptopBench QC"
    } else {
        payload.shop_profile.shop_name.trim()
    };
    pb.text("F2", 18.0, MARGIN + 16.0, banner_y + 54.0, (1.0, 1.0, 1.0), shop_title);
    pb.text(
        "F1",
        10.0,
        MARGIN + 16.0,
        banner_y + 36.0,
        (0.65, 0.82, 0.96),
        "LAPTOP HARDWARE DIAGNOSTICS & QUALITY CONTROL CERTIFICATE",
    );

    let tech = if payload.shop_profile.technician_name.trim().is_empty() {
        "Technician"
    } else {
        payload.shop_profile.technician_name.trim()
    };
    let meta_line = format!(
        "Technician: {}   |   Date: {}{}",
        tech,
        generated_at,
        if payload.customer_or_sku.trim().is_empty() {
            String::new()
        } else {
            format!("   |   Ref/SKU: {}", payload.customer_or_sku.trim())
        }
    );
    pb.text("F1", 8.5, MARGIN + 16.0, banner_y + 16.0, (0.82, 0.86, 0.92), &meta_line);

    // Overall Verdict Pill inside Header
    let v_rgb = verdict_rgb(&payload.overall_verdict);
    let pill_w = 148.0;
    let pill_h = 26.0;
    let pill_x = MARGIN + content_w - pill_w - 14.0;
    let pill_y = banner_y + 44.0;
    pb.rect_fill(pill_x, pill_y, pill_w, pill_h, v_rgb.0, v_rgb.1, v_rgb.2);
    pb.text(
        "F2",
        9.5,
        pill_x + 10.0,
        pill_y + 9.0,
        (1.0, 1.0, 1.0),
        &payload.overall_verdict,
    );

    pb.y = banner_y - 18.0;

    // Hardware Specification Summary Box
    if let Some(specs) = &payload.specs {
        let gpu_list: String = specs
            .gpus
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        let disk_list: String = specs
            .disks
            .iter()
            .map(|d| format!("{} ({:.0} GB)", d.model, d.size_gb))
            .collect::<Vec<_>>()
            .join(", ");

        let spec_rows = [
            ("Device / Model", format!("{} {} ({})", specs.manufacturer, specs.model, specs.os_name)),
            ("Serial Number", format!("{}   |   BIOS/Firmware: {}", specs.serial_number, specs.bios_version)),
            ("Processor (CPU)", format!("{} ({}C/{}T)", specs.cpu_brand, specs.cpu_physical_cores, specs.cpu_logical_cores)),
            ("Memory (RAM)", format!("{:.1} GB ({} slot(s) detected)", specs.total_ram_gb, specs.ram_modules.len().max(1))),
            ("Graphics (GPU)", if gpu_list.is_empty() { "Integrated".into() } else { gpu_list }),
            ("Storage", if disk_list.is_empty() { "Detected".into() } else { disk_list }),
        ];

        let box_h = 22.0 + spec_rows.len() as f32 * 15.0 + 10.0;
        pb.ensure_space(box_h + 12.0);
        let box_y = pb.y - box_h;
        pb.rect_fill(MARGIN, box_y, content_w, box_h, 0.96, 0.97, 0.99);
        pb.rect_stroke(MARGIN, box_y, content_w, box_h, 0.82, 0.86, 0.91);

        pb.text("F2", 10.5, MARGIN + 10.0, pb.y - 16.0, (0.08, 0.14, 0.24), "DEVICE SPECIFICATIONS");
        let mut ry = pb.y - 33.0;
        for (k, v) in &spec_rows {
            pb.text("F2", 8.5, MARGIN + 10.0, ry, (0.25, 0.31, 0.40), k);
            let truncated: String = v.chars().take(78).collect();
            pb.text("F1", 8.5, MARGIN + 112.0, ry, (0.10, 0.13, 0.18), &truncated);
            ry -= 15.0;
        }
        pb.y = box_y - 16.0;
    }

    // Diagnostic Test Results Section
    pb.ensure_space(40.0);
    pb.text("F2", 11.0, MARGIN, pb.y - 4.0, (0.08, 0.14, 0.24), "DIAGNOSTIC TEST RESULTS");
    pb.y -= 14.0;

    // Table Header
    pb.rect_fill(MARGIN, pb.y - 18.0, content_w, 18.0, 0.12, 0.18, 0.28);
    pb.text("F2", 8.5, MARGIN + 8.0, pb.y - 12.5, (1.0, 1.0, 1.0), "TEST MODULE");
    pb.text("F2", 8.5, MARGIN + 150.0, pb.y - 12.5, (1.0, 1.0, 1.0), "STATUS");
    pb.text("F2", 8.5, MARGIN + 208.0, pb.y - 12.5, (1.0, 1.0, 1.0), "SUMMARY & KEY METRICS");
    pb.y -= 18.0;

    for (idx, t) in payload.tests.iter().enumerate() {
        let mut detail_text = t.summary.clone();
        if !t.notes.trim().is_empty() {
            detail_text.push_str(&format!(" [Note: {}]", t.notes.trim()));
        }
        let wrapped = wrap_text(&detail_text, 56);
        let row_h = (wrapped.len() as f32 * 11.5 + 10.0).max(22.0);
        pb.ensure_space(row_h + 4.0);

        let row_y = pb.y - row_h;
        if idx % 2 == 1 {
            pb.rect_fill(MARGIN, row_y, content_w, row_h, 0.97, 0.98, 0.99);
        }
        pb.rect_stroke(MARGIN, row_y, content_w, row_h, 0.88, 0.90, 0.94);

        pb.text("F2", 8.5, MARGIN + 8.0, pb.y - 13.5, (0.10, 0.14, 0.20), &t.name);

        let (label, badge_rgb) = status_badge(&t.status);
        pb.rect_fill(MARGIN + 148.0, pb.y - 16.5, 44.0, 13.0, badge_rgb.0, badge_rgb.1, badge_rgb.2);
        pb.text("F2", 7.5, MARGIN + 158.0, pb.y - 12.8, (1.0, 1.0, 1.0), label);

        let mut ty = pb.y - 13.0;
        for line in &wrapped {
            pb.text("F1", 8.2, MARGIN + 208.0, ty, (0.18, 0.22, 0.28), line);
            ty -= 11.5;
        }
        pb.y = row_y;
    }

    pb.y -= 16.0;

    // Ports & Speaker Sign-off + Technician Notes
    let signoff_h = 84.0;
    pb.ensure_space(signoff_h + 24.0);
    let sy = pb.y - signoff_h;
    pb.rect_fill(MARGIN, sy, content_w, signoff_h, 0.96, 0.98, 0.97);
    pb.rect_stroke(MARGIN, sy, content_w, signoff_h, 0.80, 0.86, 0.82);

    pb.text("F2", 10.0, MARGIN + 10.0, pb.y - 15.0, (0.08, 0.14, 0.24), "PHYSICAL PORTS, SPEAKERS & TECHNICIAN SIGN-OFF");

    let ports_line = format!(
        "Physical Ports Check (USB / HDMI / Power / Jack): {}  {}",
        if payload.signoff.ports_checked { "VERIFIED" } else { "NOT CONFIRMED" },
        payload.signoff.ports_notes.trim()
    );
    let spk_line = format!(
        "Speakers Stereo Check (Left / Right / Clarity): {}  {}",
        if payload.signoff.speakers_checked { "VERIFIED" } else { "NOT CONFIRMED" },
        payload.signoff.speakers_notes.trim()
    );
    pb.text("F1", 8.5, MARGIN + 10.0, pb.y - 32.0, (0.12, 0.16, 0.22), &ports_line);
    pb.text("F1", 8.5, MARGIN + 10.0, pb.y - 47.0, (0.12, 0.16, 0.22), &spk_line);

    let notes_text = if payload.technician_notes.trim().is_empty() {
        "Technician Notes: None".to_string()
    } else {
        format!("Technician Notes: {}", payload.technician_notes.trim().chars().take(90).collect::<String>())
    };
    pb.text("F1", 8.5, MARGIN + 10.0, pb.y - 63.0, (0.20, 0.25, 0.32), &notes_text);
    pb.text(
        "F2",
        8.5,
        MARGIN + 10.0,
        pb.y - 77.0,
        (0.10, 0.14, 0.20),
        &format!("Signed off by: {}  ({})\t  Date: {}", tech, shop_title, generated_at),
    );

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
            specs: None,
            tests: vec![ReportTestEntry {
                id: "ram".into(),
                name: "RAM Stress Test".into(),
                category: "Stress".into(),
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
