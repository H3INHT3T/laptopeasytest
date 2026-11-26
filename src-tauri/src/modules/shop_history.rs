use crate::modules::portable;
use crate::types::{ShopModelBenchmarkAvg, ShopModelComparison, ShopRecordSample};
use chrono::Local;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = portable::resolve_config_dir(app)?;
    Ok(dir.join("shop_model_history.json"))
}

pub fn normalize_model_key(manufacturer: &str, model: &str, cpu_brand: &str) -> String {
    let clean = format!("{} {} {}", manufacturer.trim(), model.trim(), cpu_brand.trim())
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if clean.is_empty() {
        "unknown_laptop".to_string()
    } else {
        clean
    }
}

fn load_map(app: &AppHandle) -> HashMap<String, ShopModelBenchmarkAvg> {
    if let Ok(p) = history_path(app) {
        if let Ok(txt) = fs::read_to_string(p) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, ShopModelBenchmarkAvg>>(&txt) {
                return map;
            }
        }
    }
    HashMap::new()
}

fn save_map(app: &AppHandle, map: &HashMap<String, ShopModelBenchmarkAvg>) -> Result<(), String> {
    let p = history_path(app)?;
    let txt = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(p, txt).map_err(|e| e.to_string())
}

fn blend_opt(prev: Option<f64>, count_prev: u32, next: Option<f64>) -> Option<f64> {
    match (prev, next) {
        (Some(p), Some(n)) => {
            let v = (p * count_prev as f64 + n) / (count_prev as f64 + 1.0);
            Some((v * 10.0).round() / 10.0)
        }
        (None, Some(n)) => Some((n * 10.0).round() / 10.0),
        (Some(p), None) => Some(p),
        (None, None) => None,
    }
}

pub fn record_sample(app: &AppHandle, sample: ShopRecordSample) -> Result<ShopModelBenchmarkAvg, String> {
    let key = normalize_model_key(&sample.manufacturer, &sample.model, &sample.cpu_brand);
    let mut map = load_map(app);
    let now = Local::now().format("%Y-%m-%d %H:%M").to_string();

    let updated = if let Some(prev) = map.get(&key) {
        let c = prev.units_tested;
        ShopModelBenchmarkAvg {
            model_key: key.clone(),
            display_label: format!("{} {} ({})", sample.manufacturer.trim(), sample.model.trim(), sample.cpu_brand.trim()),
            units_tested: c + 1,
            avg_composite_score: blend_opt(prev.avg_composite_score, c, sample.composite_score),
            avg_office_score: blend_opt(prev.avg_office_score, c, sample.office_score),
            avg_creator_score: blend_opt(prev.avg_creator_score, c, sample.creator_score),
            avg_memory_mark: blend_opt(prev.avg_memory_mark, c, sample.memory_mark),
            avg_gpu_fps: blend_opt(prev.avg_gpu_fps, c, sample.gpu_fps),
            avg_ssd_read_mb_s: blend_opt(prev.avg_ssd_read_mb_s, c, sample.ssd_read_mb_s),
            last_tested_at: now,
        }
    } else {
        ShopModelBenchmarkAvg {
            model_key: key.clone(),
            display_label: format!("{} {} ({})", sample.manufacturer.trim(), sample.model.trim(), sample.cpu_brand.trim()),
            units_tested: 1,
            avg_composite_score: sample.composite_score,
            avg_office_score: sample.office_score,
            avg_creator_score: sample.creator_score,
            avg_memory_mark: sample.memory_mark,
            avg_gpu_fps: sample.gpu_fps,
            avg_ssd_read_mb_s: sample.ssd_read_mb_s,
            last_tested_at: now,
        }
    };

    map.insert(key, updated.clone());
    save_map(app, &map)?;
    Ok(updated)
}

pub fn compare_against_shop(
    app: &AppHandle,
    manufacturer: &str,
    model: &str,
    cpu_brand: &str,
    current_composite: Option<f64>,
) -> ShopModelComparison {
    let key = normalize_model_key(manufacturer, model, cpu_brand);
    let map = load_map(app);
    if let Some(avg) = map.get(&key) {
        let pct_vs_shop = match (current_composite, avg.avg_composite_score) {
            (Some(cur), Some(shop_avg)) if shop_avg > 1.0 => {
                Some(((cur / shop_avg) * 100.0 * 10.0).round() / 10.0)
            }
            _ => None,
        };
        ShopModelComparison {
            found: true,
            units_tested: avg.units_tested,
            shop_avg_composite: avg.avg_composite_score,
            shop_avg_office: avg.avg_office_score,
            shop_avg_creator: avg.avg_creator_score,
            shop_avg_gpu_fps: avg.avg_gpu_fps,
            shop_avg_ssd_read: avg.avg_ssd_read_mb_s,
            percent_vs_shop: pct_vs_shop,
            last_tested_at: Some(avg.last_tested_at.clone()),
        }
    } else {
        ShopModelComparison {
            found: false,
            units_tested: 0,
            shop_avg_composite: None,
            shop_avg_office: None,
            shop_avg_creator: None,
            shop_avg_gpu_fps: None,
            shop_avg_ssd_read: None,
            percent_vs_shop: None,
            last_tested_at: None,
        }
    }
}

pub fn list_history(app: &AppHandle) -> Vec<ShopModelBenchmarkAvg> {
    let mut vals: Vec<_> = load_map(app).into_values().collect();
    vals.sort_by(|a, b| b.last_tested_at.cmp(&a.last_tested_at));
    vals
}

pub fn export_history_to_file(app: &AppHandle, target_path: &str) -> Result<usize, String> {
    let map = load_map(app);
    let json = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    fs::write(target_path, json).map_err(|e| e.to_string())?;
    Ok(map.len())
}

pub fn import_history_from_file(app: &AppHandle, source_path: &str) -> Result<usize, String> {
    let txt = fs::read_to_string(source_path).map_err(|e| e.to_string())?;
    let incoming: HashMap<String, ShopModelBenchmarkAvg> =
        serde_json::from_str(&txt).map_err(|e| format!("Invalid shop history JSON: {}", e))?;
    let mut current = load_map(app);
    let added = incoming.len();
    for (k, v) in incoming {
        current.entry(k).or_insert(v);
    }
    save_map(app, &current)?;
    Ok(added)
}
