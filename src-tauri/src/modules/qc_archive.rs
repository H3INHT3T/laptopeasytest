use crate::types::{ExportReportPayload, ExportedReportPaths, QcArchiveRecord, WarrantyReturnDiff};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn archive_file_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LaptopBenchQC"));
    let _ = fs::create_dir_all(&dir);
    dir.join("qc_archive.json")
}

pub fn load_archive_from_path(path: &PathBuf) -> Vec<QcArchiveRecord> {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(list) = serde_json::from_str::<Vec<QcArchiveRecord>>(&raw) {
            return list;
        }
    }
    Vec::new()
}

pub fn save_archive_to_path(path: &PathBuf, records: &[QcArchiveRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn build_archive_record(
    payload: &ExportReportPayload,
    paths: &ExportedReportPaths,
    cert_id: &str,
) -> QcArchiveRecord {
    let serial = payload
        .specs
        .as_ref()
        .map(|s| s.serial_number.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "UNKNOWN".to_string());
    let manufacturer = payload
        .specs
        .as_ref()
        .map(|s| s.manufacturer.trim().to_string())
        .unwrap_or_default();
    let model = payload
        .specs
        .as_ref()
        .map(|s| s.model.trim().to_string())
        .unwrap_or_else(|| "Laptop".to_string());
    let ssd_serial = payload
        .specs
        .as_ref()
        .and_then(|s| s.disks.first())
        .map(|d| d.serial_number.trim().to_string())
        .filter(|s| !s.is_empty());
    let ram_gb = payload.specs.as_ref().map(|s| s.total_ram_gb);

    let battery_health_pct = payload
        .battery_discharge
        .as_ref()
        .map(|b| (100.0 - b.wear_pct).clamp(0.0, 100.0))
        .or_else(|| {
            payload
                .subsystem_scores
                .iter()
                .find(|s| s.label.to_lowercase().contains("battery"))
                .map(|s| s.score_pct)
        });

    let ssd_wear_pct = payload
        .tests
        .iter()
        .find(|t| t.id == "storage")
        .and_then(|t| {
            t.metrics.iter().find_map(|(k, v)| {
                if k.to_lowercase().contains("wear") {
                    v.trim_end_matches('%').trim().parse::<u32>().ok()
                } else {
                    None
                }
            })
        });

    QcArchiveRecord {
        id: format!("{}_{}", cert_id, paths.generated_at.replace([' ', ':'], "_")),
        cert_id: cert_id.to_string(),
        tested_at: paths.generated_at.clone(),
        serial_number: serial,
        manufacturer,
        model,
        customer_or_sku: payload.customer_or_sku.trim().to_string(),
        overall_verdict: payload.overall_verdict.clone(),
        durability_grade: payload.durability_grade.clone(),
        cosmetic_grade: payload.cosmetic.as_ref().map(|c| c.grade.clone()),
        battery_health_pct,
        ssd_serial,
        ssd_wear_pct,
        ram_gb,
        pdf_path: paths.pdf_path.clone(),
        html_path: paths.html_path.clone(),
        json_path: paths.json_path.clone(),
        notes: payload.technician_notes.trim().to_string(),
    }
}

pub fn record_exported_qc(
    app: &AppHandle,
    payload: &ExportReportPayload,
    paths: &ExportedReportPaths,
    cert_id: &str,
) {
    let path = archive_file_path(app);
    let mut records = load_archive_from_path(&path);
    let rec = build_archive_record(payload, paths, cert_id);
    records.insert(0, rec);
    if records.len() > 2000 {
        records.truncate(2000);
    }
    let _ = save_archive_to_path(&path, &records);
}

pub fn list_archive(app: &AppHandle) -> Vec<QcArchiveRecord> {
    load_archive_from_path(&archive_file_path(app))
}

pub fn delete_archive_entry(app: &AppHandle, id: &str) -> Result<usize, String> {
    let path = archive_file_path(app);
    let mut records = load_archive_from_path(&path);
    let before = records.len();
    records.retain(|r| r.id != id);
    save_archive_to_path(&path, &records)?;
    Ok(before.saturating_sub(records.len()))
}

pub fn export_archive_to_file(app: &AppHandle, target_path: &str) -> Result<usize, String> {
    let records = list_archive(app);
    let json = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    fs::write(target_path, json).map_err(|e| e.to_string())?;
    Ok(records.len())
}

pub fn import_archive_from_file(app: &AppHandle, source_path: &str) -> Result<usize, String> {
    let raw = fs::read_to_string(source_path).map_err(|e| e.to_string())?;
    let incoming: Vec<QcArchiveRecord> =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid archive JSON: {}", e))?;
    let path = archive_file_path(app);
    let mut existing = load_archive_from_path(&path);
    let mut added = 0usize;
    for rec in incoming {
        if !existing.iter().any(|e| e.id == rec.id || (e.cert_id == rec.cert_id && e.tested_at == rec.tested_at)) {
            existing.push(rec);
            added += 1;
        }
    }
    existing.sort_by(|a, b| b.tested_at.cmp(&a.tested_at));
    save_archive_to_path(&path, &existing)?;
    Ok(added)
}

pub fn compute_warranty_return_diff(
    records: &[QcArchiveRecord],
    serial: &str,
    current_battery_health: Option<f64>,
    current_ssd_serial: Option<&str>,
    current_ssd_wear: Option<u32>,
    current_ram_gb: Option<f64>,
) -> Option<WarrantyReturnDiff> {
    let sn = serial.trim();
    if sn.is_empty() || sn.eq_ignore_ascii_case("UNKNOWN") || sn.eq_ignore_ascii_case("To Be Filled By O.E.M.") {
        return None;
    }

    let matching: Vec<&QcArchiveRecord> = records
        .iter()
        .filter(|r| r.serial_number.eq_ignore_ascii_case(sn))
        .collect();
    let prev = (*matching.first()?).clone();

    let mut alerts = Vec::new();
    let mut part_swap_suspected = false;

    if let (Some(prev_bat), Some(curr_bat)) = (prev.battery_health_pct, current_battery_health) {
        let drop = prev_bat - curr_bat;
        if drop >= 5.0 {
            alerts.push(format!(
                "Battery health dropped {:.1}% since sale ({:.0}% → {:.0}%)",
                drop, prev_bat, curr_bat
            ));
        } else if drop <= -8.0 {
            part_swap_suspected = true;
            alerts.push(format!(
                "Battery appears replaced since sale ({:.0}% → {:.0}%)",
                prev_bat, curr_bat
            ));
        }
    }

    if let (Some(prev_ssd), Some(curr_ssd)) = (prev.ssd_serial.as_deref(), current_ssd_serial) {
        let p = prev_ssd.trim();
        let c = curr_ssd.trim();
        if !p.is_empty() && !c.is_empty() && !p.eq_ignore_ascii_case(c) {
            part_swap_suspected = true;
            alerts.push(format!(
                "SSD SERIAL MISMATCH (Part Swapped!): Sold with {} → Returned with {}",
                p, c
            ));
        }
    }

    if let (Some(prev_w), Some(curr_w)) = (prev.ssd_wear_pct, current_ssd_wear) {
        if curr_w >= prev_w.saturating_add(5) {
            alerts.push(format!("SSD wear increased from {}% → {}%", prev_w, curr_w));
        }
    }

    if let (Some(prev_ram), Some(curr_ram)) = (prev.ram_gb, current_ram_gb) {
        if (prev_ram - curr_ram).abs() >= 1.5 {
            part_swap_suspected = true;
            alerts.push(format!(
                "RAM CAPACITY CHANGED (Part Swapped!): Sold with {:.0} GB → Returned with {:.0} GB",
                prev_ram, curr_ram
            ));
        }
    }

    let summary = if part_swap_suspected {
        format!(
            "WARRANTY ALERT: Previously tested on {} ({}) — suspected hardware swap detected!",
            prev.tested_at, prev.overall_verdict
        )
    } else if !alerts.is_empty() {
        format!(
            "Previously tested on {} ({}) — {} wear/degradation change(s) detected.",
            prev.tested_at,
            prev.overall_verdict,
            alerts.len()
        )
    } else {
        format!(
            "Previously tested on {} ({}) — hardware matches original sale record.",
            prev.tested_at, prev.overall_verdict
        )
    };

    Some(WarrantyReturnDiff {
        previous_record: prev,
        previous_count: matching.len(),
        alerts,
        part_swap_suspected,
        summary,
    })
}

pub fn check_warranty_return_diff(
    app: &AppHandle,
    serial: &str,
    current_battery_health: Option<f64>,
    current_ssd_serial: Option<&str>,
    current_ssd_wear: Option<u32>,
    current_ram_gb: Option<f64>,
) -> Option<WarrantyReturnDiff> {
    let records = list_archive(app);
    compute_warranty_return_diff(
        &records,
        serial,
        current_battery_health,
        current_ssd_serial,
        current_ssd_wear,
        current_ram_gb,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_warranty_return_diff_detects_part_swaps_and_battery_drop() {
        let sold = QcArchiveRecord {
            id: "1".into(),
            cert_id: "CERT-1234".into(),
            tested_at: "2026-10-01 10:00:00".into(),
            serial_number: "SN-DELL-999".into(),
            manufacturer: "Dell".into(),
            model: "Latitude 5420".into(),
            customer_or_sku: "CUST-01".into(),
            overall_verdict: "PASSED".into(),
            durability_grade: Some("A".into()),
            cosmetic_grade: Some("A Clean".into()),
            battery_health_pct: Some(90.0),
            ssd_serial: Some("S5GXNX0R123456".into()),
            ssd_wear_pct: Some(4),
            ram_gb: Some(16.0),
            pdf_path: "a.pdf".into(),
            html_path: "a.html".into(),
            json_path: "a.json".into(),
            notes: String::new(),
        };

        let clean = compute_warranty_return_diff(
            &[sold.clone()],
            "SN-DELL-999",
            Some(89.0),
            Some("S5GXNX0R123456"),
            Some(5),
            Some(16.0),
        )
        .unwrap();
        assert!(!clean.part_swap_suspected);
        assert!(clean.alerts.is_empty());

        let swapped = compute_warranty_return_diff(
            &[sold],
            "SN-DELL-999",
            Some(70.0),
            Some("CHEAP_OEM_SSD_001"),
            Some(18),
            Some(8.0),
        )
        .unwrap();
        assert!(swapped.part_swap_suspected);
        assert!(swapped.alerts.iter().any(|a| a.contains("SSD SERIAL MISMATCH")));
        assert!(swapped.alerts.iter().any(|a| a.contains("RAM CAPACITY CHANGED")));
        assert!(swapped.alerts.iter().any(|a| a.contains("Battery health dropped")));
    }
}
