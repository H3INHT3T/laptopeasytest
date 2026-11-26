use crate::types::BaselineRating;

/// Offline hardware baseline & normal-range rating engine for second-hand laptop QC (v2.0).
/// Compares measured SSD, RAM, CPU/Office/Creator Performance, GPU, VRAM, and Combined Power Torture
/// results against expected real-world normal ranges for the detected hardware model/class.

pub(crate) fn normalize_hw_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let stripped = lower
        .replace("(r)", " ")
        .replace("(tm)", " ")
        .replace("(c)", " ")
        .replace('®', " ")
        .replace('™', " ")
        .replace('©', " ");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn contains_ascii_token(haystack: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let tlen = token.len();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(token) {
        let idx = start + pos;
        let left_ok = idx == 0 || !bytes[idx - 1].is_ascii_alphanumeric();
        let right_idx = idx + tlen;
        let right_ok = right_idx == bytes.len() || !bytes[right_idx].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        start = idx + haystack[idx..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

fn grade_from_ratio(pct: f64, throttle_drop_pct: Option<f64>) -> (&'static str, String) {
    let throttled = throttle_drop_pct.map(|d| d >= 20.0).unwrap_or(false);
    if throttled {
        return (
            "BELOW NORMAL (THROTTLING)",
            format!(
                "Performance dropped {:.1}% under sustained load — inspect thermal paste, heatsink dust, or cooling fan.",
                throttle_drop_pct.unwrap_or(0.0)
            ),
        );
    }
    if pct >= 112.0 {
        ("EXCELLENT", "Performing above normal factory baseline for this hardware class.".into())
    } else if pct >= 85.0 {
        ("NORMAL", "Within healthy normal performance range for this laptop model/class.".into())
    } else if pct >= 65.0 {
        (
            "BELOW NORMAL",
            "Lower than expected for this hardware — verify power profile (AC plugged), cooling, or background load."
                .into(),
        )
    } else {
        (
            "POOR / UNDERPERFORMING",
            "Significantly below expected baseline — inspect thermal throttling, power adapter wattage, or hardware fault."
                .into(),
        )
    }
}

/// Computes an overall shop-ready A+ to FAIL Durability Grade combining baseline %,
/// thermal throttle drop, hardware errors (RAM/VRAM/NAND), thermal cutoff, and AC charger drain.
pub fn compute_durability_grade(
    percent_of_normal: f64,
    throttle_drop_pct: f64,
    hw_errors: u64,
    thermal_cutoff: bool,
    battery_drain_plugged: bool,
) -> String {
    if hw_errors > 0 || thermal_cutoff {
        return "FAIL".to_string();
    }
    if battery_drain_plugged || throttle_drop_pct >= 28.0 || percent_of_normal < 60.0 {
        return "C".to_string();
    }
    if throttle_drop_pct >= 18.0 || percent_of_normal < 82.0 {
        return "B".to_string();
    }
    if percent_of_normal >= 102.0 && throttle_drop_pct <= 8.0 {
        return "A+".to_string();
    }
    "A".to_string()
}

pub fn rate_cpu_performance(
    cpu_brand: &str,
    physical_cores: usize,
    logical_cores: usize,
    measured_composite: u64,
    throttle_drop_pct: f64,
) -> BaselineRating {
    let b = cpu_brand.to_lowercase();
    let cores = physical_cores.max(2) as f64;
    let threads = logical_cores.max(2) as f64;

    // Calibrated expected LaptopBench v2.0 composite baseline by real laptop CPU family
    let (class_label, expected_mid): (String, f64) = if b.contains("apple m4 max") || b.contains("apple m3 max") {
        ("Apple Silicon Pro/Max Class (M3/M4 Max)".into(), 23000.0)
    } else if b.contains("apple m4 pro")
        || b.contains("apple m3 pro")
        || b.contains("apple m2 max")
        || b.contains("apple m1 max")
    {
        ("Apple Silicon Pro/Max Class".into(), 18200.0)
    } else if b.contains("apple m4") || b.contains("apple m3") {
        ("Apple M3 / M4 Standard Notebook".into(), 13500.0)
    } else if b.contains("apple m2") || b.contains("apple m1") {
        ("Apple M1 / M2 Standard Notebook".into(), 10800.0)
    } else if b.contains("ultra 9")
        || b.contains("ryzen ai 9")
        || b.contains("i9-14")
        || b.contains("i9-13")
        || b.contains("ryzen 9 7")
        || b.contains("ryzen 9 8")
    {
        (format!("Flagship Mobile CPU ({}C/{}T)", physical_cores, logical_cores), 18200.0)
    } else if b.contains("ultra 7")
        || b.contains("ryzen ai 7")
        || b.contains("i7-14")
        || b.contains("i7-13")
        || b.contains("i7-12")
        || b.contains("ryzen 7 7")
        || b.contains("ryzen 7 8")
        || b.contains("ryzen 7 6")
    {
        (format!("High-Performance i7 / Ryzen 7 ({}C/{}T)", physical_cores, logical_cores), 14000.0)
    } else if b.contains("ultra 5")
        || b.contains("i5-14")
        || b.contains("i5-13")
        || b.contains("i5-12")
        || b.contains("ryzen 5 7")
        || b.contains("ryzen 5 6")
        || b.contains("ryzen 5 5")
    {
        (format!("Modern Mid-Range i5 / Ryzen 5 ({}C/{}T)", physical_cores, logical_cores), 10200.0)
    } else if b.contains("i7-11") || b.contains("i7-10") || b.contains("ryzen 7 4") || b.contains("ryzen 7 5") {
        (format!("10th/11th Gen i7 / Ryzen 7 ({}C/{}T)", physical_cores, logical_cores), 8800.0)
    } else if b.contains("i5-11")
        || b.contains("i5-10")
        || b.contains("i5-8")
        || b.contains("i5-9")
        || b.contains("ryzen 5 4")
        || b.contains("ryzen 5 3")
    {
        (format!("10th/11th Gen i5 Office Notebook ({}C/{}T)", physical_cores, logical_cores), 7000.0)
    } else if b.contains("i3") || b.contains("ryzen 3") {
        (format!("Entry i3 / Ryzen 3 Notebook ({}C/{}T)", physical_cores, logical_cores), 4900.0)
    } else if b.contains("celeron") || b.contains("pentium") || b.contains("n100") || b.contains("n95") {
        (format!("Budget / Low-Power CPU ({}C/{}T)", physical_cores, logical_cores), 3300.0)
    } else {
        let est = (cores * 1250.0 + threads * 330.0).clamp(3600.0, 21000.0);
        (format!("Laptop CPU ({}C/{}T)", physical_cores, logical_cores), est)
    };

    let low = (expected_mid * 0.85).round() as u64;
    let high = (expected_mid * 1.15).round() as u64;
    let pct = ((measured_composite as f64 / expected_mid) * 100.0 * 10.0).round() / 10.0;
    let (grade, note) = grade_from_ratio(pct, Some(throttle_drop_pct));

    BaselineRating {
        detected_class: class_label,
        expected_normal: format!("{} – {} Mark (Normal)", low, high),
        percent_of_normal: pct,
        grade: grade.to_string(),
        verdict_note: note,
    }
}

pub fn rate_storage(
    interface_hint: &str,
    media_hint: &str,
    seq_read_mb_s: f64,
    seq_write_mb_s: f64,
    integrity_errors: u64,
) -> BaselineRating {
    if integrity_errors > 0 {
        return BaselineRating {
            detected_class: format!("{} {}", interface_hint, media_hint),
            expected_normal: "0 Data Corruption Errors".into(),
            percent_of_normal: 0.0,
            grade: "FAIL / CORRUPTION".into(),
            verdict_note: format!(
                "CRITICAL: {} byte-verification mismatch(es) detected on read-back! Drive NAND or controller is failing.",
                integrity_errors
            ),
        };
    }

    let iface = interface_hint.to_lowercase();
    let media = media_hint.to_lowercase();
    let safe_read = if seq_read_mb_s.is_finite() && seq_read_mb_s > 0.0 {
        seq_read_mb_s
    } else {
        0.0
    };
    let safe_write = if seq_write_mb_s.is_finite() && seq_write_mb_s > 0.0 {
        seq_write_mb_s
    } else {
        0.0
    };

    let is_nvme = iface.contains("nvme") || iface.contains("pcie") || safe_read > 700.0;
    let is_hdd_media = media.contains("hdd")
        || media.contains("rotational")
        || media.contains("spinning")
        || (media.contains("hard")
            && !media.contains("fixed hard disk")
            && !media.contains("external hard disk"));
    let is_hdd_speed_fallback = !is_nvme
        && !media.contains("ssd")
        && !media.contains("solid state")
        && safe_read > 0.0
        && safe_read < 250.0;

    let (class_label, exp_read, exp_write): (&str, f64, f64) =
        if is_hdd_media || is_hdd_speed_fallback {
            ("Mechanical HDD (2.5\" SATA)", 120.0, 100.0)
        } else if is_nvme {
            ("NVMe PCIe SSD", 2200.0, 1400.0)
        } else {
            ("SATA III SSD", 480.0, 420.0)
        };

    let read_ratio = safe_read / exp_read;
    let write_ratio = safe_write / exp_write;
    let pct = (((read_ratio * 0.55 + write_ratio * 0.45) * 100.0) * 10.0).round() / 10.0;
    let (grade, note) = grade_from_ratio(pct, None);

    BaselineRating {
        detected_class: class_label.to_string(),
        expected_normal: format!(
            "~{:.0}+ MB/s Read | ~{:.0}+ MB/s Write (Direct I/O)",
            exp_read * 0.8,
            exp_write * 0.8
        ),
        percent_of_normal: pct,
        grade: grade.to_string(),
        verdict_note: note,
    }
}

pub fn rate_ram(
    memory_type_hint: &str,
    peak_bandwidth_gb_s: f64,
    errors_found: u64,
) -> BaselineRating {
    if errors_found > 0 {
        return BaselineRating {
            detected_class: memory_type_hint.to_string(),
            expected_normal: "0 Bit Errors Required".into(),
            percent_of_normal: 0.0,
            grade: "FAIL / BAD RAM".into(),
            verdict_note: format!(
                "CRITICAL: {} memory bit-flip error(s) detected! Replace faulty RAM module / inspect logic board.",
                errors_found
            ),
        };
    }

    let mt = memory_type_hint.to_lowercase();
    let (label, expected_bw): (&str, f64) = if mt.contains("ddr5") || mt.contains("lpddr5") || mt.contains("unified") {
        ("DDR5 / LPDDR5 / Unified High-Speed RAM", 36.0)
    } else if mt.contains("ddr4") || mt.contains("lpddr4") {
        ("DDR4 / LPDDR4X Laptop RAM", 22.0)
    } else if mt.contains("ddr3") || mt.contains("lpddr3") {
        ("DDR3 / LPDDR3 Laptop RAM", 14.0)
    } else {
        ("Standard Laptop DRAM", 20.0)
    };

    let pct = ((peak_bandwidth_gb_s / expected_bw) * 100.0 * 10.0).round() / 10.0;
    let (grade, note) = grade_from_ratio(pct, None);

    BaselineRating {
        detected_class: label.to_string(),
        expected_normal: format!(
            "0 Errors | ~{:.0}–{:.0} GB/s Effective Throughput",
            expected_bw * 0.8,
            expected_bw * 1.3
        ),
        percent_of_normal: pct,
        grade: grade.to_string(),
        verdict_note: note,
    }
}

pub fn rate_gpu(
    adapter_name: &str,
    resolution: &str,
    avg_fps: f64,
    fps_drop_pct: f64,
    thermal_cutoff: bool,
) -> BaselineRating {
    if thermal_cutoff {
        return BaselineRating {
            detected_class: adapter_name.to_string(),
            expected_normal: "Stable Thermal Operation (< 92°C)".into(),
            percent_of_normal: 0.0,
            grade: "FAIL / OVERHEATING".into(),
            verdict_note: "GPU hit thermal safety cutoff! Repaste GPU die and clean heatsink/fans immediately.".into(),
        };
    }

    let n = normalize_hw_name(adapter_name);
    let res_scale: f64 = match resolution {
        "1080p" | "1920x1080" => 0.48,
        "1440p" | "2560x1440" => 0.28,
        "4k" | "3840x2160" => 0.13,
        _ => 1.0,
    };

    let is_apple = n.contains("apple");
    let is_max_q = n.contains("max-q") || n.contains("max q");

    let (label, base_720p_fps): (&str, f64) = if n.contains("5090")
        || n.contains("5080")
        || n.contains("4090")
        || n.contains("4080")
        || (is_apple
            && (contains_ascii_token(&n, "m4 max")
                || contains_ascii_token(&n, "m3 max")
                || contains_ascii_token(&n, "m4 ultra")
                || contains_ascii_token(&n, "m3 ultra")))
    {
        if is_apple {
            ("Apple Silicon Max / Ultra GPU", 135.0)
        } else {
            ("Flagship Gaming / Workstation GPU", 135.0)
        }
    } else if n.contains("5070")
        || n.contains("4070")
        || n.contains("4060")
        || n.contains("3080")
        || n.contains("3070")
        || (contains_ascii_token(&n, "2080") && !is_max_q)
        || n.contains("rx 7900")
        || n.contains("rx 7800")
        || n.contains("rx 6800")
        || (is_apple
            && (contains_ascii_token(&n, "m4 pro")
                || contains_ascii_token(&n, "m3 pro")
                || contains_ascii_token(&n, "m2 ultra")
                || contains_ascii_token(&n, "m1 ultra")))
    {
        if is_apple {
            ("Apple Silicon Pro / Ultra GPU", 92.0)
        } else {
            ("High-End Discrete Laptop GPU", 92.0)
        }
    } else if (contains_ascii_token(&n, "2080") && is_max_q)
        || (contains_ascii_token(&n, "2070") && contains_ascii_token(&n, "super") && !is_max_q)
        || (is_apple
            && (contains_ascii_token(&n, "m2 max") || contains_ascii_token(&n, "m1 max")))
    {
        if is_apple {
            ("Apple Silicon M1/M2 Max GPU", 74.0)
        } else {
            ("Upper-Mid Discrete Laptop GPU", 74.0)
        }
    } else if n.contains("5060")
        || n.contains("4050")
        || n.contains("3060")
        || n.contains("3050")
        || (contains_ascii_token(&n, "2070") && !is_max_q)
        || n.contains("2060")
        || n.contains("rx 7900")
        || n.contains("rx 7800")
        || n.contains("rx 7700")
        || n.contains("rx 7600")
        || n.contains("rx 6800")
        || n.contains("rx 6700")
        || n.contains("rx 6600")
        || n.contains("rx 6500")
    {
        ("Mid-Range Gaming Laptop GPU", 62.0)
    } else if contains_ascii_token(&n, "2070") && is_max_q {
        ("Mid-Range Discrete Laptop GPU (Max-Q)", 58.0)
    } else if n.contains("quadro m5") || n.contains("quadro m4") || n.contains("quadro m3") {
        ("Mobile Workstation GPU (Quadro M3000M–M5000M)", 42.0)
    } else if n.contains("1660")
        || n.contains("1650")
        || n.contains("2050")
        || n.contains("1050")
        || n.contains("mx5")
        || n.contains("mx4")
        || n.contains("mx3")
        || n.contains("mx2")
        || contains_ascii_token(&n, "mx150")
        || n.contains("arc a7")
        || n.contains("arc a5")
        || n.contains("arc a3")
        || (is_apple
            && (contains_ascii_token(&n, "m1 pro")
                || contains_ascii_token(&n, "m2 pro")
                || contains_ascii_token(&n, "m4")
                || contains_ascii_token(&n, "m3")
                || contains_ascii_token(&n, "m2")
                || contains_ascii_token(&n, "m1")))
    {
        if is_apple {
            ("Apple Silicon GPU", 38.0)
        } else {
            ("Entry Discrete Laptop GPU", 38.0)
        }
    } else if n.contains("quadro m2")
        || n.contains("quadro m1")
        || n.contains("quadro m6")
        || n.contains("quadro p")
        || n.contains("quadro t")
        || n.contains("quadro rtx")
        || n.contains("arc graphics")
        || n.contains("arc pro")
        || n.contains("890m")
        || n.contains("880m")
        || n.contains("780m")
    {
        ("Workstation Entry / High-EU iGPU", 28.0)
    } else if contains_ascii_token(&n, "mx130") || contains_ascii_token(&n, "mx110") {
        ("Entry Legacy Discrete GPU (MX110/MX130)", 20.0)
    } else if n.contains("radeon r9 m") || n.contains("radeon r7 m") || n.contains("radeon r5 m") {
        ("AMD Radeon Legacy Mobile Discrete", 17.0)
    } else if contains_ascii_token(&n, "940mx")
        || contains_ascii_token(&n, "930mx")
        || contains_ascii_token(&n, "920mx")
    {
        ("Entry Legacy Discrete GPU (940MX)", 16.0)
    } else if n.contains("iris")
        || n.contains("radeon")
        || n.contains("vega")
        || n.contains("680m")
        || n.contains("660m")
    {
        ("Modern Integrated Laptop GPU (Iris Xe / Radeon)", 22.0)
    } else {
        ("Standard Integrated Graphics (UHD / HD)", 12.0)
    };

    let expected_fps = (base_720p_fps * res_scale).max(4.0);
    let pct = ((avg_fps / expected_fps) * 100.0 * 10.0).round() / 10.0;
    let (grade, note) = grade_from_ratio(pct, Some(fps_drop_pct));

    BaselineRating {
        detected_class: label.to_string(),
        expected_normal: format!(
            "~{:.0}–{:.0} FPS @ {} (Throttle drop < 15%)",
            expected_fps * 0.8,
            expected_fps * 1.25,
            resolution
        ),
        percent_of_normal: pct,
        grade: grade.to_string(),
        verdict_note: note,
    }
}

pub fn rate_vram(
    adapter_name: &str,
    is_discrete: bool,
    avg_bandwidth_gb_s: f64,
    errors_found: u64,
) -> BaselineRating {
    if errors_found > 0 {
        return BaselineRating {
            detected_class: adapter_name.to_string(),
            expected_normal: "0 VRAM Bit-Flip Errors Required".into(),
            percent_of_normal: 0.0,
            grade: "FAIL / BAD VRAM".into(),
            verdict_note: format!(
                "CRITICAL: {} VRAM bit-flip error(s) detected on {}! Faulty GDDR chip or GPU solder joint.",
                errors_found, adapter_name
            ),
        };
    }

    let expected_bw = if is_discrete { 65.0 } else { 18.0 };
    let pct = ((avg_bandwidth_gb_s / expected_bw) * 100.0 * 10.0).round() / 10.0;
    let (grade, note) = if pct >= 80.0 {
        ("PASS / HEALTHY VRAM", "Zero VRAM bit-flips across all memory banks with normal compute throughput.".into())
    } else {
        ("PASS (CONSERVATIVE BW)", "Zero VRAM bit-flips detected; lower compute bandwidth may reflect power-saving state.".into())
    };

    BaselineRating {
        detected_class: if is_discrete { "Discrete GDDR VRAM" } else { "Integrated / Unified GPU Memory" }.into(),
        expected_normal: format!("0 Bit Errors | ~{:.0}+ GB/s Effective Compute Sweep", expected_bw * 0.75),
        percent_of_normal: pct.min(180.0),
        grade: grade.to_string(),
        verdict_note: note,
    }
}

pub fn rate_power_torture(
    fps_drop_pct: f64,
    battery_drain_plugged: bool,
    thermal_cutoff: bool,
    peak_temp_c: Option<f32>,
) -> BaselineRating {
    if thermal_cutoff {
        return BaselineRating {
            detected_class: "Combined CPU + GPU + RAM Power Torture".into(),
            expected_normal: "Sustained Full-Chassis Load Without Cutoff".into(),
            percent_of_normal: 0.0,
            grade: "FAIL / THERMAL SHUTDOWN".into(),
            verdict_note: format!(
                "Hit thermal cutoff ({:.0}°C) under simultaneous CPU+GPU load. Clean fans & replace thermal paste.",
                peak_temp_c.unwrap_or(95.0)
            ),
        };
    }
    if battery_drain_plugged {
        return BaselineRating {
            detected_class: "Combined CPU + GPU + RAM Power Torture".into(),
            expected_normal: "AC Charger Holds Battery Level Under Full Load".into(),
            percent_of_normal: 65.0,
            grade: "WARNING / CHARGER DRAIN".into(),
            verdict_note: "Battery discharged while plugged into AC power! Inspect adapter wattage (under-rated/fake charger) or DC-in MOSFET.".into(),
        };
    }
    let stability = (100.0 - fps_drop_pct).clamp(20.0, 100.0);
    let (grade, note) = if fps_drop_pct <= 10.0 {
        ("EXCELLENT COOLING & VRM", "Cooling system and AC power delivery held rock-steady under simultaneous 100% CPU+GPU+RAM load.".into())
    } else if fps_drop_pct <= 20.0 {
        ("NORMAL (MILD THROTTLING)", format!("Acceptable {:.1}% thermal ramp under combined chassis load; AC power delivery healthy.", fps_drop_pct))
    } else {
        ("THERMAL THROTTLING", format!("Noticeable {:.1}% slowdown under combined CPU+GPU load — consider fan cleaning / repaste.", fps_drop_pct))
    };

    BaselineRating {
        detected_class: "Combined CPU + GPU + RAM Power Torture".into(),
        expected_normal: "Throttle Drop < 15% | No Battery Drain on AC".into(),
        percent_of_normal: (stability * 10.0).round() / 10.0,
        grade: grade.to_string(),
        verdict_note: note,
    }
}

// ============================================================================
// PassMark-11 Weighted Harmonic Mean Scoring Calibration (v2.3.0)
// ============================================================================

/// Minimum positive denominator guard to avoid floating-point underflow / division by zero.
#[allow(dead_code)]
pub const HARMONIC_EPSILON: f64 = 1e-12;

/// PassMark 11 CPU Mark subtest weights (9 subtests).
/// Higher weight on Single-Core, Integer, and Floating-Point reflects real-world responsiveness.
#[allow(dead_code)]
pub const PASSMARK_CPU_WEIGHTS: [(&str, f64); 9] = [
    ("single_core", 1.35),
    ("integer_math", 1.20),
    ("float_math", 1.15),
    ("vector_ext", 1.05),
    ("compression", 0.95),
    ("prime", 0.90),
    ("physics", 0.90),
    ("encryption", 0.85),
    ("sorting", 0.85),
];

/// PassMark 11 Memory Mark subtest weights.
#[allow(dead_code)]
pub const W_MEM_DATABASE: f64 = 0.0388;
#[allow(dead_code)]
pub const W_MEM_READ_CACHED: f64 = 12.8505;
#[allow(dead_code)]
pub const W_MEM_READ_UNCACHED: f64 = 5.8283;
#[allow(dead_code)]
pub const W_MEM_WRITE: f64 = 3.5454;
#[allow(dead_code)]
pub const W_MEM_AVAILABLE_RAM: f64 = 0.00002;
#[allow(dead_code)]
pub const W_MEM_LATENCY: f64 = 2.2560;
#[allow(dead_code)]
pub const W_MEM_THREADED: f64 = 7.9271;
#[allow(dead_code)]
pub const MEMORY_MARK_CONSTANT: f64 = 0.14;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default)]
pub struct CpuSubtestScores {
    pub single_core: f64,
    pub integer_math: f64,
    pub float_math: f64,
    pub prime: f64,
    pub vector_ext: f64,
    pub encryption: f64,
    pub compression: f64,
    pub sorting: f64,
    pub physics: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default)]
pub struct MemorySubtestMetrics {
    pub database_kops: f64,
    pub read_cached_mb_s: f64,
    pub read_uncached_mb_s: f64,
    pub write_mb_s: f64,
    pub available_ram_mb: f64,
    pub latency_ns: f64,
    pub threaded_mb_s: f64,
}

/// Computes PassMark-style Weighted Harmonic Mean:
/// `Mark = constant * sum(W_i) / sum(W_i / X_i)`
///
/// Each element of `samples` is `(weight, value)`.
/// - Returns `0.0` if `constant` is non-finite or `<= 0.0`, or if `samples` is empty.
/// - Ignores terms with non-finite or `<= 0.0` weight.
/// - For any positive-weight term with non-finite or `<= 0.0` value, returns `0.0`
///   (matching the mathematical limit `lim_{x -> 0+} H = 0`, preventing `Inf`/`NaN`).
#[allow(dead_code)]
pub fn weighted_harmonic_mean(samples: &[(f64, f64)], constant: f64) -> f64 {
    if !constant.is_finite() || constant <= 0.0 || samples.is_empty() {
        return 0.0;
    }

    let mut sum_w = 0.0_f64;
    let mut sum_w_over_x = 0.0_f64;

    for &(weight, value) in samples {
        if !weight.is_finite() || weight <= 0.0 {
            continue;
        }
        if !value.is_finite() || value <= 0.0 {
            return 0.0;
        }
        sum_w += weight;
        sum_w_over_x += weight / value;
    }

    if sum_w <= 0.0 || !sum_w_over_x.is_finite() || sum_w_over_x <= 0.0 {
        return 0.0;
    }

    let result = constant * (sum_w / sum_w_over_x);
    if result.is_finite() {
        result
    } else {
        0.0
    }
}

/// Variant of `weighted_harmonic_mean` that clamps finite values to `min_floor.max(1e-6)`
/// and skips `NaN` / `Inf` values, so a single zero subtest severely penalizes the score
/// without collapsing the entire composite to `0.0`.
#[allow(dead_code)]
pub fn weighted_harmonic_mean_floored(samples: &[(f64, f64)], constant: f64, min_floor: f64) -> f64 {
    if !constant.is_finite() || constant <= 0.0 || samples.is_empty() {
        return 0.0;
    }
    let floor = if min_floor.is_finite() && min_floor > 1e-6 {
        min_floor
    } else {
        1e-6
    };

    let mut sum_w = 0.0_f64;
    let mut sum_w_over_x = 0.0_f64;

    for &(weight, value) in samples {
        if !weight.is_finite() || weight <= 0.0 || !value.is_finite() {
            continue;
        }
        let clamped_val = value.max(floor);
        sum_w += weight;
        sum_w_over_x += weight / clamped_val;
    }

    if sum_w <= 0.0 || !sum_w_over_x.is_finite() || sum_w_over_x <= 0.0 {
        return 0.0;
    }

    let result = constant * (sum_w / sum_w_over_x);
    if result.is_finite() {
        result
    } else {
        0.0
    }
}

/// Computes composite CPU Mark using PassMark 11's Weighted Harmonic Mean over all 9 subtests.
#[allow(dead_code)]
pub fn compute_cpu_mark_harmonic(scores: &CpuSubtestScores) -> u64 {
    let samples = [
        (PASSMARK_CPU_WEIGHTS[0].1, scores.single_core),
        (PASSMARK_CPU_WEIGHTS[1].1, scores.integer_math),
        (PASSMARK_CPU_WEIGHTS[2].1, scores.float_math),
        (PASSMARK_CPU_WEIGHTS[3].1, scores.vector_ext),
        (PASSMARK_CPU_WEIGHTS[4].1, scores.compression),
        (PASSMARK_CPU_WEIGHTS[5].1, scores.prime),
        (PASSMARK_CPU_WEIGHTS[6].1, scores.physics),
        (PASSMARK_CPU_WEIGHTS[7].1, scores.encryption),
        (PASSMARK_CPU_WEIGHTS[8].1, scores.sorting),
    ];
    weighted_harmonic_mean(&samples, 1.0).round().max(0.0) as u64
}

/// Computes PassMark-11 calibrated Memory Mark using the 7 documented Memory Mark weights
/// (`0.0388`, `12.8505`, `5.8283`, `3.5454`, `0.00002`, `2.2560`, `7.9271`) with `1_000_000.0 / latency_ns`
/// dimensional alignment and `MEMORY_MARK_CONSTANT = 0.14`.
#[allow(dead_code)]
pub fn compute_memory_mark_harmonic(metrics: &MemorySubtestMetrics) -> u64 {
    if !metrics.latency_ns.is_finite() || metrics.latency_ns <= 0.0 {
        return 0;
    }
    let inv_latency = 1_000_000.0 / metrics.latency_ns.max(1.0);
    let samples = [
        (W_MEM_DATABASE, metrics.database_kops),
        (W_MEM_READ_CACHED, metrics.read_cached_mb_s),
        (W_MEM_READ_UNCACHED, metrics.read_uncached_mb_s),
        (W_MEM_WRITE, metrics.write_mb_s),
        (W_MEM_AVAILABLE_RAM, metrics.available_ram_mb),
        (W_MEM_LATENCY, inv_latency),
        (W_MEM_THREADED, metrics.threaded_mb_s),
    ];
    weighted_harmonic_mean(&samples, MEMORY_MARK_CONSTANT)
        .round()
        .max(0.0) as u64
}

/// Computes Office Productivity Mark via Weighted Harmonic Mean.
#[allow(dead_code)]
pub fn compute_office_mark_harmonic(
    single_core: f64,
    compression: f64,
    encryption: f64,
    sorting: f64,
    database: f64,
) -> u64 {
    let samples = [
        (0.30, single_core),
        (0.20, compression),
        (0.15, encryption),
        (0.15, sorting),
        (0.20, database),
    ];
    weighted_harmonic_mean(&samples, 1.0).round().max(0.0) as u64
}

/// Computes Creator / Workstation Mark via Weighted Harmonic Mean.
#[allow(dead_code)]
pub fn compute_creator_mark_harmonic(
    raytrace_score: f64,
    ai_gemm_score: f64,
    image_score: f64,
) -> u64 {
    let samples = [
        (0.42, raytrace_score),
        (0.33, ai_gemm_score),
        (0.25, image_score),
    ];
    weighted_harmonic_mean(&samples, 1.0).round().max(0.0) as u64
}

/// Computes overall LaptopBench Composite Mark via Weighted Harmonic Mean.
#[allow(dead_code)]
pub fn compute_composite_mark_harmonic(
    single_core: f64,
    multi_core: f64,
    creator: f64,
    memory_mark: f64,
) -> u64 {
    let samples = [
        (0.16, single_core),
        (0.38, multi_core),
        (0.28, creator),
        (0.18, memory_mark),
    ];
    weighted_harmonic_mean(&samples, 1.0).round().max(0.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_weighted_harmonic_mean_identity_and_constant() {
        let identical = [(1.0, 100.0), (2.5, 100.0), (4.0, 100.0)];
        let h = weighted_harmonic_mean(&identical, 1.0);
        assert!((h - 100.0).abs() < 1e-9);

        let scaled = weighted_harmonic_mean(&identical, 2.5);
        assert!((scaled - 250.0).abs() < 1e-9);
    }

    #[test]
    fn test_weighted_harmonic_mean_guards_zero_negative_nan_inf_empty() {
        assert_eq!(weighted_harmonic_mean(&[], 1.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0)], 0.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0)], -1.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0)], f64::NAN), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0)], f64::INFINITY), 0.0);

        // Positive-weight zero/negative/NaN/Inf value returns 0.0 cleanly (no Inf/NaN).
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0), (1.0, 0.0)], 1.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0), (1.0, -5.0)], 1.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0), (1.0, f64::NAN)], 1.0), 0.0);
        assert_eq!(weighted_harmonic_mean(&[(1.0, 100.0), (1.0, f64::INFINITY)], 1.0), 0.0);

        // Zero-weight invalid entries are ignored.
        let h = weighted_harmonic_mean(&[(0.0, 0.0), (-2.0, f64::NAN), (1.0, 80.0)], 1.0);
        assert!((h - 80.0).abs() < 1e-9);
    }

    #[test]
    fn test_weighted_harmonic_mean_floored_penalizes_without_zeroing() {
        let samples = [(1.0, 1000.0), (1.0, 0.0), (1.0, f64::NAN)];
        let h = weighted_harmonic_mean_floored(&samples, 1.0, 10.0);
        assert!(h > 0.0 && h < 25.0);
    }

    #[test]
    fn test_harmonic_penalizes_bottlenecks_more_than_arithmetic() {
        let balanced = CpuSubtestScores {
            single_core: 10000.0,
            integer_math: 10000.0,
            float_math: 10000.0,
            prime: 10000.0,
            vector_ext: 10000.0,
            encryption: 10000.0,
            compression: 10000.0,
            sorting: 10000.0,
            physics: 10000.0,
        };
        let imbalanced = CpuSubtestScores {
            single_core: 1000.0, // severe single-core bottleneck
            integer_math: 11125.0,
            float_math: 11125.0,
            prime: 11125.0,
            vector_ext: 11125.0,
            encryption: 11125.0,
            compression: 11125.0,
            sorting: 11125.0,
            physics: 11125.0,
        };
        let h_bal = compute_cpu_mark_harmonic(&balanced);
        let h_imb = compute_cpu_mark_harmonic(&imbalanced);
        assert_eq!(h_bal, 10000);
        assert!(h_imb < 5000, "Bottleneck should pull harmonic CPU Mark down sharply, got {}", h_imb);
    }

    #[test]
    fn test_memory_mark_harmonic_exact_weights_and_ordering() {
        // Verify exact PassMark Memory weights
        assert!((W_MEM_DATABASE - 0.0388).abs() < 1e-9);
        assert!((W_MEM_READ_CACHED - 12.8505).abs() < 1e-9);
        assert!((W_MEM_READ_UNCACHED - 5.8283).abs() < 1e-9);
        assert!((W_MEM_WRITE - 3.5454).abs() < 1e-9);
        assert!((W_MEM_AVAILABLE_RAM - 0.00002).abs() < 1e-9);
        assert!((W_MEM_LATENCY - 2.2560).abs() < 1e-9);
        assert!((W_MEM_THREADED - 7.9271).abs() < 1e-9);

        let ddr5_dc = MemorySubtestMetrics {
            database_kops: 150.0,
            read_cached_mb_s: 62000.0,
            read_uncached_mb_s: 48000.0,
            write_mb_s: 44000.0,
            available_ram_mb: 32768.0,
            latency_ns: 65.0,
            threaded_mb_s: 56000.0,
        };
        let ddr4_dc = MemorySubtestMetrics {
            database_kops: 105.0,
            read_cached_mb_s: 42000.0,
            read_uncached_mb_s: 30000.0,
            write_mb_s: 28000.0,
            available_ram_mb: 16384.0,
            latency_ns: 72.0,
            threaded_mb_s: 36000.0,
        };
        let ddr4_sc = MemorySubtestMetrics {
            database_kops: 80.0,
            read_cached_mb_s: 34000.0,
            read_uncached_mb_s: 15000.0,
            write_mb_s: 14000.0,
            available_ram_mb: 8192.0,
            latency_ns: 88.0,
            threaded_mb_s: 16000.0,
        };

        let s5 = compute_memory_mark_harmonic(&ddr5_dc);
        let s4 = compute_memory_mark_harmonic(&ddr4_dc);
        let s1 = compute_memory_mark_harmonic(&ddr4_sc);
        assert!(s5 > s4 && s4 > s1, "Expected DDR5 ({}) > DDR4 DC ({}) > DDR4 SC ({})", s5, s4, s1);
        assert!(s4 >= 2500 && s4 <= 4500, "DDR4 DC mark {} should stay in calibrated 2500-4500 range", s4);

        let zero_lat = MemorySubtestMetrics {
            latency_ns: 0.0,
            ..ddr4_dc
        };
        assert_eq!(compute_memory_mark_harmonic(&zero_lat), 0);
    }

    #[test]
    fn test_office_creator_composite_harmonic() {
        let office = compute_office_mark_harmonic(8000.0, 9000.0, 9500.0, 8500.0, 7500.0);
        let creator = compute_creator_mark_harmonic(11000.0, 12000.0, 10500.0);
        let comp = compute_composite_mark_harmonic(8000.0, 11000.0, creator as f64, 3400.0);
        assert!(office > 7500 && office < 9500);
        assert!(creator > 10500 && creator < 12000);
        assert!(comp > 5500 && comp < 11000);
    }

    #[test]
    fn test_durability_grade_boundaries() {
        assert_eq!(compute_durability_grade(110.0, 5.0, 1, false, false), "FAIL");
        assert_eq!(compute_durability_grade(110.0, 5.0, 0, true, false), "FAIL");
        assert_eq!(compute_durability_grade(105.0, 5.0, 0, false, true), "C");
        assert_eq!(compute_durability_grade(105.0, 28.0, 0, false, false), "C");
        assert_eq!(compute_durability_grade(59.9, 5.0, 0, false, false), "C");
        assert_eq!(compute_durability_grade(81.9, 5.0, 0, false, false), "B");
        assert_eq!(compute_durability_grade(105.0, 18.0, 0, false, false), "B");
        assert_eq!(compute_durability_grade(102.0, 8.0, 0, false, false), "A+");
        assert_eq!(compute_durability_grade(95.0, 8.0, 0, false, false), "A");
    }

    #[test]
    fn test_weighted_harmonic_mean_large_values_and_small_weights() {
        assert!((weighted_harmonic_mean(&[(1.0, 1e12)], 1.0) - 1e12).abs() < 1e2);
        assert!((weighted_harmonic_mean(&[(1.0, 1e13)], 1.0) - 1e13).abs() < 1e3);
        assert!((weighted_harmonic_mean(&[(1e-6, 1e7)], 1.0) - 1e7).abs() < 1e-2);
        assert!((weighted_harmonic_mean_floored(&[(1.0, 1e12)], 1.0, 1.0) - 1e12).abs() < 1e2);

        let huge_cpu = CpuSubtestScores {
            single_core: 1e25,
            integer_math: 1e25,
            float_math: 1e25,
            prime: 1e25,
            vector_ext: 1e25,
            encryption: 1e25,
            compression: 1e25,
            sorting: 1e25,
            physics: 1e25,
        };
        assert!(compute_cpu_mark_harmonic(&huge_cpu) > 0);
    }

    #[test]
    fn test_contains_ascii_token_boundaries() {
        assert!(contains_ascii_token("apple m1 max", "m1"));
        assert!(contains_ascii_token("apple m1 max", "m1 max"));
        assert!(!contains_ascii_token("nvidia quadro m1000m", "m1"));
        assert!(!contains_ascii_token("nvidia quadro m2000m", "m2"));
        assert!(!contains_ascii_token("amd radeon r9 m275", "m2"));
        assert!(contains_ascii_token("nvidia geforce rtx 2070 with max-q design", "2070"));
        assert!(contains_ascii_token("nvidia geforce rtx 2070 with max-q design", "max-q"));
        assert!(!contains_ascii_token("rtx 20700", "2070"));
        assert!(!contains_ascii_token("anything", ""));
    }

    #[test]
    fn test_rate_storage_windows_fixed_hard_disk_media_cases() {
        let nvme_scsi = rate_storage("SCSI", "Fixed hard disk media", 3500.0, 2600.0, 0);
        assert_eq!(nvme_scsi.detected_class, "NVMe PCIe SSD");
        assert!(nvme_scsi.percent_of_normal > 120.0);
        assert!(!nvme_scsi.detected_class.contains("Mechanical HDD"));

        let sata_scsi = rate_storage("SCSI", "Fixed hard disk media", 530.0, 480.0, 0);
        assert_eq!(sata_scsi.detected_class, "SATA III SSD");
        assert!(sata_scsi.percent_of_normal > 100.0);

        let hdd_fixed = rate_storage("SATA", "Fixed hard disk media", 115.0, 95.0, 0);
        assert_eq!(hdd_fixed.detected_class, "Mechanical HDD (2.5\" SATA)");
        assert!(hdd_fixed.percent_of_normal >= 85.0 && hdd_fixed.percent_of_normal <= 115.0);

        let throttled_nvme = rate_storage("NVMe", "Fixed hard disk media", 200.0, 150.0, 0);
        assert_eq!(throttled_nvme.detected_class, "NVMe PCIe SSD");
        assert!(throttled_nvme.grade.contains("POOR"));

        let throttled_sata = rate_storage("SATA", "SSD", 180.0, 140.0, 0);
        assert_eq!(throttled_sata.detected_class, "SATA III SSD");
        assert!(throttled_sata.grade.contains("POOR"));

        let corrupt = rate_storage("NVMe", "SSD", 3000.0, 2000.0, 2);
        assert_eq!(corrupt.grade, "FAIL / CORRUPTION");
        assert_eq!(corrupt.percent_of_normal, 0.0);
    }

    #[test]
    fn test_rate_gpu_token_anchoring_and_laptop_classes() {
        for non_apple in [
            "NVIDIA Quadro M1000M",
            "NVIDIA Quadro M2000M",
            "AMD Radeon R9 M275",
            "AMD Radeon R7 M265",
        ] {
            let r = rate_gpu(non_apple, "1280x720", 20.0, 5.0, false);
            assert!(
                !r.detected_class.contains("Apple"),
                "{} falsely matched Apple Silicon: {}",
                non_apple,
                r.detected_class
            );
        }

        let m1 = rate_gpu("Apple M1", "1280x720", 38.0, 2.0, false);
        let m2_pro = rate_gpu("Apple M2 Pro", "1280x720", 38.0, 2.0, false);
        let m3_max = rate_gpu("Apple M3 Max", "1280x720", 135.0, 2.0, false);
        assert!(m1.detected_class.contains("Apple"));
        assert!(m2_pro.detected_class.contains("Apple"));
        assert!(m3_max.detected_class.contains("Apple"));
        assert_eq!(m1.grade, "NORMAL");
        assert_eq!(m3_max.grade, "NORMAL");

        // Monotonic ordering of expected FPS across RTX 2080 / 2070 / 940MX / UHD
        // Give each 1280x720 at a constant 30 FPS: higher baseline class yields lower percent_of_normal.
        let r2080 = rate_gpu("NVIDIA GeForce RTX 2080", "1280x720", 30.0, 3.0, false);
        let r2080_mq = rate_gpu("NVIDIA GeForce RTX 2080 with Max-Q Design", "1280x720", 30.0, 3.0, false);
        let r2070 = rate_gpu("NVIDIA GeForce RTX 2070", "1280x720", 30.0, 3.0, false);
        let r2070_mq = rate_gpu("NVIDIA GeForce RTX 2070 with Max-Q Design", "1280x720", 30.0, 3.0, false);
        let r940mx = rate_gpu("NVIDIA GeForce 940MX", "1280x720", 30.0, 3.0, false);
        let ruhd = rate_gpu("Intel(R) UHD Graphics 620", "1280x720", 30.0, 3.0, false);

        for r in [&r2080, &r2080_mq, &r2070, &r2070_mq, &r940mx] {
            assert_ne!(r.detected_class, "Standard Integrated Graphics (UHD / HD)");
        }
        assert!(
            r2080.percent_of_normal < r2080_mq.percent_of_normal
                && r2080_mq.percent_of_normal < r2070.percent_of_normal
                && r2070.percent_of_normal < r2070_mq.percent_of_normal
                && r2070_mq.percent_of_normal < r940mx.percent_of_normal
                && r940mx.percent_of_normal < ruhd.percent_of_normal,
            "Expected 2080 ({}) < 2080 MQ ({}) < 2070 ({}) < 2070 MQ ({}) < 940MX ({}) < UHD ({}) at constant 30 FPS",
            r2080.percent_of_normal,
            r2080_mq.percent_of_normal,
            r2070.percent_of_normal,
            r2070_mq.percent_of_normal,
            r940mx.percent_of_normal,
            ruhd.percent_of_normal,
        );

        // Resolution scaling equivalence: 1920x1080 (0.48x) vs 1280x720 (1.0x)
        let r_720 = rate_gpu("NVIDIA GeForce RTX 2070", "1280x720", 62.0, 3.0, false);
        let r_1080 = rate_gpu("NVIDIA GeForce RTX 2070", "1920x1080", 62.0 * 0.48, 3.0, false);
        assert!((r_720.percent_of_normal - r_1080.percent_of_normal).abs() < 0.2);
    }

    #[test]
    fn test_mx150_mx130_rtx2070_super_maxq_rx640_and_non_ascii_token() {
        let mx150_a = rate_gpu("GeForce MX150", "1280x720", 30.0, 2.0, false);
        let mx150_b = rate_gpu("NVIDIA GeForce MX150", "1280x720", 30.0, 2.0, false);
        let mx130 = rate_gpu("NVIDIA GeForce MX130", "1280x720", 30.0, 2.0, false);
        let mx110 = rate_gpu("NVIDIA GeForce MX110", "1280x720", 30.0, 2.0, false);
        let g940mx = rate_gpu("GeForce 940MX", "1280x720", 30.0, 2.0, false);
        let uhd = rate_gpu("Intel(R) UHD Graphics 620", "1280x720", 30.0, 2.0, false);

        assert_eq!(mx150_a.detected_class, "Entry Discrete Laptop GPU");
        assert_eq!(mx150_b.detected_class, "Entry Discrete Laptop GPU");
        assert_eq!(mx130.detected_class, "Entry Legacy Discrete GPU (MX110/MX130)");
        assert_eq!(mx110.detected_class, "Entry Legacy Discrete GPU (MX110/MX130)");
        assert_eq!(g940mx.detected_class, "Entry Legacy Discrete GPU (940MX)");
        assert!(
            mx150_b.percent_of_normal < mx130.percent_of_normal
                && mx130.percent_of_normal < g940mx.percent_of_normal
                && g940mx.percent_of_normal < uhd.percent_of_normal,
            "Expected MX150 ({}) < MX130 ({}) < 940MX ({}) < UHD ({}) at constant 30 FPS",
            mx150_b.percent_of_normal,
            mx130.percent_of_normal,
            g940mx.percent_of_normal,
            uhd.percent_of_normal
        );

        let r2070_sup_mq = rate_gpu("RTX 2070 Super with Max-Q Design", "1280x720", 30.0, 2.0, false);
        let r2070_sup = rate_gpu("RTX 2070 Super", "1280x720", 30.0, 2.0, false);
        assert_eq!(r2070_sup_mq.detected_class, "Mid-Range Discrete Laptop GPU (Max-Q)");
        assert_eq!(r2070_sup.detected_class, "Upper-Mid Discrete Laptop GPU");
        assert!(r2070_sup.percent_of_normal < r2070_sup_mq.percent_of_normal);

        let rx640 = rate_gpu("AMD Radeon RX 640", "1280x720", 22.0, 2.0, false);
        let rx6600m = rate_gpu("AMD Radeon RX 6600M", "1280x720", 62.0, 2.0, false);
        assert_eq!(rx640.detected_class, "Modern Integrated Laptop GPU (Iris Xe / Radeon)");
        assert_eq!(rx640.grade, "NORMAL");
        assert_eq!(rx6600m.detected_class, "Mid-Range Gaming Laptop GPU");

        // Non-ASCII token traversal must not panic on multi-byte boundaries
        assert!(contains_ascii_token("café m1", "m1"));
        assert!(!contains_ascii_token("café", "é"));
        assert!(contains_ascii_token("caf é test", "é"));
    }

    #[test]
    fn test_rate_storage_non_finite_negative_and_external_usb_ssd() {
        let nan_read = rate_storage("SCSI", "Fixed hard disk media", f64::NAN, 500.0, 0);
        assert!(nan_read.percent_of_normal.is_finite());
        assert!(nan_read.percent_of_normal >= 0.0);

        let inf_write = rate_storage("NVMe", "SSD", 2200.0, f64::INFINITY, 0);
        assert!(inf_write.percent_of_normal.is_finite());
        assert!(inf_write.percent_of_normal >= 0.0);

        let neg = rate_storage("SCSI", "Fixed hard disk media", -1.0, -1.0, 0);
        assert_eq!(neg.percent_of_normal, 0.0);
        assert_eq!(neg.detected_class, "SATA III SSD");

        let fast_usb_nvme = rate_storage("USB", "External hard disk media", 950.0, 850.0, 0);
        assert_eq!(fast_usb_nvme.detected_class, "NVMe PCIe SSD");

        let slow_usb_hdd = rate_storage("USB", "External hard disk media", 110.0, 90.0, 0);
        assert_eq!(slow_usb_hdd.detected_class, "Mechanical HDD (2.5\" SATA)");
        assert_eq!(slow_usb_hdd.grade, "NORMAL");
    }
}
