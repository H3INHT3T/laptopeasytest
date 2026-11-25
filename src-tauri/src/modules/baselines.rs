use crate::types::BaselineRating;

/// Offline hardware baseline & normal-range rating engine for second-hand laptop QC (v2.0).
/// Compares measured SSD, RAM, CPU/Office/Creator Performance, GPU, VRAM, and Combined Power Torture
/// results against expected real-world normal ranges for the detected hardware model/class.

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

    let (class_label, exp_read, exp_write): (&str, f64, f64) = if media.contains("hdd") || media.contains("hard") {
        ("Mechanical HDD (2.5\" SATA)", 120.0, 100.0)
    } else if iface.contains("nvme") || iface.contains("pcie") || seq_read_mb_s > 700.0 {
        ("NVMe PCIe SSD", 2200.0, 1400.0)
    } else {
        ("SATA III SSD", 480.0, 420.0)
    };

    let read_ratio = seq_read_mb_s / exp_read;
    let write_ratio = seq_write_mb_s / exp_write;
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

    let n = adapter_name.to_lowercase();
    let res_scale: f64 = match resolution {
        "1080p" | "1920x1080" => 0.48,
        "1440p" | "2560x1440" => 0.28,
        "4k" | "3840x2160" => 0.13,
        _ => 1.0,
    };

    let (label, base_720p_fps): (&str, f64) = if n.contains("5090") || n.contains("5080") || n.contains("4090") || n.contains("4080") || n.contains("m4 max") || n.contains("m3 max") {
        ("Flagship Gaming / Workstation GPU", 135.0)
    } else if n.contains("5070") || n.contains("4070") || n.contains("4060") || n.contains("3080") || n.contains("3070") || n.contains("m4 pro") || n.contains("m3 pro") {
        ("High-End Discrete Laptop GPU", 92.0)
    } else if n.contains("5060") || n.contains("4050") || n.contains("3060") || n.contains("3050") || n.contains("2060") || n.contains("rx 6") || n.contains("rx 7") {
        ("Mid-Range Gaming Laptop GPU", 62.0)
    } else if n.contains("1660") || n.contains("1650") || n.contains("1050") || n.contains("mx") || n.contains("arc") || n.contains("m2") || n.contains("m1") {
        ("Entry Discrete / Apple Silicon GPU", 38.0)
    } else if n.contains("iris") || n.contains("radeon") || n.contains("vega") || n.contains("780m") || n.contains("680m") {
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
