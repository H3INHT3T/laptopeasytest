use crate::cmd_util;
use crate::modules::baselines::{contains_ascii_token, normalize_hw_name};
use crate::types::{
    UserBenchmarkComparison, UserBenchmarkComponentRating, UserBenchmarkInput,
};
use std::sync::mpsc;
use std::time::Duration;

const OFFLINE_MODE: &str = "offline_calibrated";
#[allow(dead_code)]
const LIVE_MODE: &str = "live_verified";
const LIVE_LOOKUP_TIMEOUT_MS: u64 = 800;

fn valid_pos_opt(opt: Option<f64>) -> Option<f64> {
    opt.filter(|v| v.is_finite() && *v > 0.0)
}

fn has_invalid_pos_metric(opt: Option<f64>) -> bool {
    matches!(opt, Some(v) if !v.is_finite() || v < 0.0)
}

fn round1(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 10.0).round() / 10.0
}

/// Maps a UserBenchmark-calibrated Effective Speed % to its Vehicle Performance Tier.
pub fn vehicle_tier_from_pct(pct: f64) -> &'static str {
    if !pct.is_finite() {
        return "Raft";
    }
    if pct >= 100.0 {
        "UFO"
    } else if pct >= 90.0 {
        "Nuclear Submarine"
    } else if pct >= 80.0 {
        "Aircraft Carrier"
    } else if pct >= 70.0 {
        "Battleship"
    } else if pct >= 65.0 {
        "Cruiser"
    } else if pct >= 60.0 {
        "Destroyer"
    } else if pct >= 40.0 {
        "Speedboat"
    } else if pct >= 30.0 {
        "Jet Ski"
    } else {
        "Raft"
    }
}

/// Maps Same-Class Relative Standing % (measured vs expected class speed) to a clear buyer label.
pub fn standing_label_from_ratio(relative_standing_pct: f64) -> &'static str {
    if !relative_standing_pct.is_finite() {
        return "Underperforming";
    }
    if relative_standing_pct >= 105.0 {
        "Above Expectations"
    } else if relative_standing_pct >= 85.0 {
        "As Expected"
    } else if relative_standing_pct >= 70.0 {
        "Below Expectations"
    } else {
        "Underperforming"
    }
}

fn plain_tier_meaning(tier: &str) -> &'static str {
    match tier {
        "UFO" => "Flagship class — handles AAA gaming, 4K editing, and heavy multitasking effortlessly.",
        "Nuclear Submarine" => "High-end class — fast and responsive across demanding creative and gaming workloads.",
        "Aircraft Carrier" => "Upper-mid class — smooth 1080p/1440p gaming and heavy productivity.",
        "Battleship" => "Solid mid-range — reliable for coding, multitasking, and light-to-medium gaming.",
        "Cruiser" => "Mainstream productivity — comfortable for office suites, browsing, and media.",
        "Destroyer" => "Entry-mid tier — suitable for everyday productivity and light tasks.",
        "Speedboat" => "Budget / older generation — best for web, documents, and video playback.",
        "Jet Ski" => "Basic / aging hardware — light office and web browsing only.",
        _ => "Severely limited, heavily throttled, or bottlenecked — inspect cooling, RAM channel, or drive health.",
    }
}

/// Best-effort non-blocking live probe against `userbenchmark.com` with strict <=800ms timeout.
/// Because UserBenchmark employs Cloudflare protection and no component-level score scraping is
/// performed from the homepage, `source_mode` remains `"offline_calibrated"` unless component-level
/// live data is actually retrieved and parsed.
fn try_live_lookup_status(allow_live: bool, query_hint: &str) -> &'static str {
    if !allow_live || query_hint.trim().is_empty() {
        return OFFLINE_MODE;
    }

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let ok = cmd_util::silent_command("curl")
            .args([
                "--connect-timeout",
                "1",
                "--max-time",
                "1",
                "-sL",
                "-o",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
                "-w",
                "%{http_code}",
                "https://www.userbenchmark.com",
            ])
            .output()
            .ok()
            .map(|out| {
                let code = String::from_utf8_lossy(&out.stdout);
                out.status.success() && code.trim() == "200"
            })
            .unwrap_or(false);
        let _ = tx.send(ok);
    });

    let _ = rx.recv_timeout(Duration::from_millis(LIVE_LOOKUP_TIMEOUT_MS));
    // Never stamp "live_verified" solely from homepage HTTP 200 without component-level parsing.
    OFFLINE_MODE
}

struct CpuClassAnchor {
    label: &'static str,
    expected_ub_pct: f64,
    expected_composite: f64,
}

fn lookup_mobile_cpu_class(
    cpu_brand: &str,
    physical_cores: usize,
    logical_cores: usize,
) -> CpuClassAnchor {
    let b = normalize_hw_name(cpu_brand);

    // Apple Silicon (explicitly scoped to "apple", most-specific first: Ultra/Max -> Pro -> Base)
    if b.contains("apple") {
        if b.contains("m4 max") || b.contains("m4 ultra") {
            return CpuClassAnchor { label: "Apple M4 Max / Ultra", expected_ub_pct: 128.0, expected_composite: 23000.0 };
        }
        if b.contains("m3 ultra") {
            return CpuClassAnchor { label: "Apple M3 Ultra", expected_ub_pct: 126.0, expected_composite: 23000.0 };
        }
        if b.contains("m3 max") {
            return CpuClassAnchor { label: "Apple M3 Max", expected_ub_pct: 122.0, expected_composite: 22000.0 };
        }
        if b.contains("m2 ultra") {
            return CpuClassAnchor { label: "Apple M2 Ultra", expected_ub_pct: 114.0, expected_composite: 20500.0 };
        }
        if b.contains("m1 ultra") {
            return CpuClassAnchor { label: "Apple M1 Ultra", expected_ub_pct: 108.0, expected_composite: 19200.0 };
        }
        if b.contains("m4 pro") {
            return CpuClassAnchor { label: "Apple M4 Pro", expected_ub_pct: 112.0, expected_composite: 19500.0 };
        }
        if b.contains("m3 pro") {
            return CpuClassAnchor { label: "Apple M3 Pro", expected_ub_pct: 104.0, expected_composite: 17800.0 };
        }
        if b.contains("m2 max") || b.contains("m1 max") {
            return CpuClassAnchor { label: "Apple M1/M2 Max", expected_ub_pct: 102.0, expected_composite: 17200.0 };
        }
        if b.contains("m4") {
            return CpuClassAnchor { label: "Apple M4", expected_ub_pct: 98.0, expected_composite: 14500.0 };
        }
        if b.contains("m2 pro") || b.contains("m1 pro") {
            return CpuClassAnchor { label: "Apple M1/M2 Pro", expected_ub_pct: 92.0, expected_composite: 14800.0 };
        }
        if b.contains("m3") {
            return CpuClassAnchor { label: "Apple M3", expected_ub_pct: 89.0, expected_composite: 13000.0 };
        }
        if b.contains("m2") {
            return CpuClassAnchor { label: "Apple M2", expected_ub_pct: 82.0, expected_composite: 11200.0 };
        }
        if b.contains("m1") {
            return CpuClassAnchor { label: "Apple M1", expected_ub_pct: 77.0, expected_composite: 10200.0 };
        }
    }

    // Intel Mobile (HX / Ultra / U-P / H / Legacy — ordered most-specific first)
    if b.contains("ultra 9")
        || b.contains("i9-14900hx")
        || b.contains("i9-13980hx")
        || b.contains("i9-13900hx")
        || (b.contains("i9-14") && b.contains("hx"))
        || (b.contains("i9-13") && b.contains("hx"))
        || (b.contains("i9-12") && b.contains("hx"))
    {
        return CpuClassAnchor { label: "Flagship Intel Core Ultra 9 / i9-HX", expected_ub_pct: 112.0, expected_composite: 19000.0 };
    }
    if b.contains("i9-14") || b.contains("i9-13") || b.contains("i9-12") {
        return CpuClassAnchor { label: "Intel Core i9 Mobile (H-Series)", expected_ub_pct: 99.0, expected_composite: 16800.0 };
    }
    if b.contains("ultra 7")
        || b.contains("i7-14700hx")
        || b.contains("i7-13700hx")
        || b.contains("i7-13650hx")
        || b.contains("i7-12700hx")
        || b.contains("i7-12650hx")
        || (b.contains("i7-14") && b.contains("hx"))
        || (b.contains("i7-13") && b.contains("hx"))
        || (b.contains("i7-12") && b.contains("hx"))
    {
        return CpuClassAnchor { label: "Intel Core Ultra 7 / i7-HX High-Wattage", expected_ub_pct: 97.0, expected_composite: 16200.0 };
    }
    if b.contains("ultra 5")
        || b.contains("i5-14500hx")
        || b.contains("i5-13500hx")
        || b.contains("i5-13500h")
        || b.contains("i5-12500h")
        || b.contains("i7-1370p")
        || b.contains("i7-1360p")
        || b.contains("i7-1280p")
        || b.contains("i7-1270p")
        || b.contains("i7-1260p")
    {
        return CpuClassAnchor { label: "Intel Core Ultra 5 / i5-H / i7-P", expected_ub_pct: 82.0, expected_composite: 12200.0 };
    }
    if b.contains("i7-1465u")
        || b.contains("i7-1455u")
        || b.contains("i7-1365u")
        || b.contains("i7-1355u")
        || b.contains("i7-1265u")
        || b.contains("i7-1255u")
        || b.contains("i5-1435u")
        || b.contains("i5-1345u")
        || b.contains("i5-1335u")
        || b.contains("i5-1245u")
        || b.contains("i5-1235u")
        || b.contains("i5-12450h")
        || b.contains("i5-1340p")
        || b.contains("i5-1240p")
        || b.contains("i5-13")
        || b.contains("i5-14")
        || b.contains("i5-12")
    {
        return CpuClassAnchor { label: "Intel Core i5/i7 Thin-and-Light (12th–14th Gen)", expected_ub_pct: 75.0, expected_composite: 10200.0 };
    }
    if b.contains("i7-14")
        || b.contains("i7-13700h")
        || b.contains("i7-13620h")
        || b.contains("i7-12700h")
        || b.contains("i7-12650h")
        || b.contains("i7-13")
    {
        return CpuClassAnchor { label: "Intel Core i7 H-Series (12th–14th Gen)", expected_ub_pct: 89.0, expected_composite: 14000.0 };
    }
    if b.contains("i7-11") || b.contains("i5-11") || b.contains("i7-10750h") || b.contains("i7-10870h") {
        return CpuClassAnchor { label: "Intel 10th/11th Gen Mobile i5/i7", expected_ub_pct: 66.0, expected_composite: 8400.0 };
    }
    if b.contains("i7-10")
        || b.contains("i5-10")
        || b.contains("i7-8")
        || b.contains("i5-8")
        || b.contains("i5-9")
        || b.contains("i3-13")
        || b.contains("i3-12")
        || b.contains("i3-11")
    {
        return CpuClassAnchor { label: "Intel 8th–10th Gen / Modern i3 Mobile", expected_ub_pct: 52.0, expected_composite: 6500.0 };
    }
    if b.contains("core m3") || b.contains("m3-8") || b.contains("m3-7") || b.contains("m3-6") {
        return CpuClassAnchor { label: "Intel Core m3 Ultraportable", expected_ub_pct: 42.0, expected_composite: 4400.0 };
    }
    if b.contains("n100") || b.contains("n95") || b.contains("n97") || b.contains("n200") {
        return CpuClassAnchor { label: "Intel N-Series Entry Mobile (Alder Lake-N)", expected_ub_pct: 40.0, expected_composite: 4200.0 };
    }
    if b.contains("celeron") || b.contains("pentium") || b.contains("n4020") || b.contains("n4120") || b.contains("n5030") {
        return CpuClassAnchor { label: "Intel Celeron / Pentium Budget CPU", expected_ub_pct: 30.0, expected_composite: 3100.0 };
    }

    // AMD Ryzen Mobile (AI / HX / HS / H / U)
    if b.contains("ryzen ai 9")
        || b.contains("ryzen 9 7945hx")
        || b.contains("ryzen 9 8945hs")
        || b.contains("ryzen 9 7940hs")
        || b.contains("ryzen 9")
    {
        return CpuClassAnchor { label: "AMD Ryzen AI 9 / Ryzen 9 Mobile", expected_ub_pct: 108.0, expected_composite: 18400.0 };
    }
    if b.contains("ryzen ai 7")
        || b.contains("ryzen 7 8845hs")
        || b.contains("ryzen 7 7840hs")
        || b.contains("ryzen 7 7745hx")
    {
        return CpuClassAnchor { label: "AMD Ryzen AI 7 / Ryzen 7 HS-HX", expected_ub_pct: 95.0, expected_composite: 15400.0 };
    }
    if b.contains("ryzen 7 6800") || b.contains("ryzen 7 7735") || b.contains("ryzen 7 7730") {
        return CpuClassAnchor { label: "AMD Ryzen 7 6000/7035 Mobile", expected_ub_pct: 84.0, expected_composite: 13000.0 };
    }
    if b.contains("ryzen 5 8645")
        || b.contains("ryzen 5 7640")
        || b.contains("ryzen 5 7535")
        || b.contains("ryzen 5 6600")
        || b.contains("ryzen 5 5600h")
    {
        return CpuClassAnchor { label: "AMD Ryzen 5 Performance Mobile (HS/H)", expected_ub_pct: 78.0, expected_composite: 10800.0 };
    }
    if b.contains("ryzen 7 5800") || b.contains("ryzen 7 5700u") || b.contains("ryzen 7 4800") {
        return CpuClassAnchor { label: "AMD Ryzen 7 4000/5000 Mobile", expected_ub_pct: 72.0, expected_composite: 9800.0 };
    }
    if b.contains("ryzen 5 5500u") || b.contains("ryzen 5 4600h") || b.contains("ryzen 5 4500u") || b.contains("ryzen 5 7520u") || b.contains("ryzen 5") {
        return CpuClassAnchor { label: "AMD Ryzen 5 Efficiency Mobile (U-Series)", expected_ub_pct: 63.0, expected_composite: 7800.0 };
    }
    if b.contains("ryzen 3") || b.contains("athlon") {
        return CpuClassAnchor { label: "AMD Ryzen 3 / Athlon Entry Mobile", expected_ub_pct: 46.0, expected_composite: 5200.0 };
    }

    let cores = physical_cores.max(2) as f64;
    let threads = logical_cores.max(cores as usize) as f64;
    CpuClassAnchor {
        label: "Mobile Laptop CPU (Core-Scaled Estimate)",
        expected_ub_pct: (45.0 + cores * 4.2).clamp(32.0, 96.0),
        expected_composite: (cores * 1250.0 + threads * 330.0).clamp(3500.0, 20000.0),
    }
}

struct GpuClassAnchor {
    label: &'static str,
    expected_ub_pct: f64,
    expected_720p_fps: f64,
    tgp_note: &'static str,
}

fn lookup_mobile_gpu_class(gpu_name: &str) -> GpuClassAnchor {
    let n = normalize_hw_name(gpu_name);

    if n.contains("5090") || n.contains("4090") {
        return GpuClassAnchor { label: "Flagship RTX 4090/5090 Laptop GPU", expected_ub_pct: 175.0, expected_720p_fps: 155.0, tgp_note: "150W–175W Flagship TGP" };
    }
    if n.contains("5080") || n.contains("4080") {
        return GpuClassAnchor { label: "Enthusiast RTX 4080/5080 Laptop GPU", expected_ub_pct: 148.0, expected_720p_fps: 135.0, tgp_note: "125W–175W High-TGP" };
    }
    if n.contains("5070") || n.contains("4070") || n.contains("3080") {
        return GpuClassAnchor { label: "High-End RTX 4070/3080 Laptop GPU", expected_ub_pct: 106.0, expected_720p_fps: 98.0, tgp_note: "80W–140W TGP Class" };
    }
    if contains_ascii_token(&n, "2080") {
        if n.contains("max-q") || n.contains("max q") {
            return GpuClassAnchor { label: "NVIDIA GeForce RTX 2080 Max-Q", expected_ub_pct: 78.0, expected_720p_fps: 74.0, tgp_note: "80W–90W Max-Q Laptop TGP" };
        }
        if contains_ascii_token(&n, "super") {
            return GpuClassAnchor { label: "NVIDIA GeForce RTX 2080 Super Laptop GPU", expected_ub_pct: 92.0, expected_720p_fps: 88.0, tgp_note: "150W–200W High-TGP Mobile" };
        }
        return GpuClassAnchor { label: "NVIDIA GeForce RTX 2080 Laptop GPU", expected_ub_pct: 86.0, expected_720p_fps: 82.0, tgp_note: "150W–200W Mobile TGP" };
    }
    if n.contains("4060") || n.contains("3070") {
        return GpuClassAnchor { label: "Upper-Mid RTX 4060/3070 Laptop GPU", expected_ub_pct: 88.0, expected_720p_fps: 85.0, tgp_note: "45W–140W Laptop TGP" };
    }
    if contains_ascii_token(&n, "2070") {
        if n.contains("max-q") || n.contains("max q") {
            return GpuClassAnchor { label: "NVIDIA GeForce RTX 2070 Max-Q", expected_ub_pct: 60.0, expected_720p_fps: 58.0, tgp_note: "80W–90W Max-Q Laptop TGP" };
        }
        if contains_ascii_token(&n, "super") {
            return GpuClassAnchor { label: "NVIDIA GeForce RTX 2070 Super Laptop GPU", expected_ub_pct: 76.0, expected_720p_fps: 72.0, tgp_note: "115W–150W Mobile TGP" };
        }
        return GpuClassAnchor { label: "NVIDIA GeForce RTX 2070 Laptop GPU", expected_ub_pct: 68.0, expected_720p_fps: 65.0, tgp_note: "115W Mobile TGP" };
    }
    if n.contains("4050") || n.contains("3060") {
        return GpuClassAnchor { label: "Mid-Range RTX 4050/3060 Laptop GPU", expected_ub_pct: 72.0, expected_720p_fps: 68.0, tgp_note: "45W–115W Laptop TGP" };
    }
    if n.contains("3050") || n.contains("2060") || n.contains("1660") {
        return GpuClassAnchor { label: "Entry Gaming RTX 3050 / GTX 1660 Ti Laptop", expected_ub_pct: 52.0, expected_720p_fps: 52.0, tgp_note: "35W–85W Laptop TGP" };
    }
    if n.contains("1650") || n.contains("2050") {
        return GpuClassAnchor { label: "Budget Discrete GTX 1650 / RTX 2050 Laptop", expected_ub_pct: 36.0, expected_720p_fps: 38.0, tgp_note: "35W–55W Laptop TGP" };
    }
    if n.contains("1050")
        || n.contains("mx5")
        || n.contains("mx4")
        || n.contains("mx3")
        || n.contains("mx2")
        || contains_ascii_token(&n, "mx150")
    {
        return GpuClassAnchor { label: "Ultrabook Discrete MX / GTX 1050", expected_ub_pct: 22.0, expected_720p_fps: 26.0, tgp_note: "25W–40W Ultrabook TGP" };
    }
    if contains_ascii_token(&n, "mx130") || contains_ascii_token(&n, "mx110") {
        return GpuClassAnchor { label: "NVIDIA GeForce MX110 / MX130 Entry Discrete", expected_ub_pct: 18.0, expected_720p_fps: 20.0, tgp_note: "25W Entry Ultrabook Discrete" };
    }
    if contains_ascii_token(&n, "940mx")
        || contains_ascii_token(&n, "930mx")
        || contains_ascii_token(&n, "920mx")
    {
        return GpuClassAnchor { label: "NVIDIA GeForce 940MX Legacy Ultrabook GPU", expected_ub_pct: 14.0, expected_720p_fps: 16.0, tgp_note: "15W–25W Legacy Ultrabook Discrete" };
    }
    if n.contains("apple") {
        if n.contains("m4 ultra") || n.contains("m4 max") || n.contains("m3 ultra") || n.contains("m3 max") {
            return GpuClassAnchor { label: "Apple Silicon Max / Ultra GPU (M3/M4)", expected_ub_pct: 115.0, expected_720p_fps: 115.0, tgp_note: "Unified 30–76 Core GPU" };
        }
        if n.contains("m2 ultra") || n.contains("m1 ultra") {
            return GpuClassAnchor { label: "Apple Silicon M1/M2 Ultra GPU", expected_ub_pct: 92.0, expected_720p_fps: 88.0, tgp_note: "Unified 48–76 Core GPU" };
        }
        if n.contains("m4 pro") || n.contains("m3 pro") {
            return GpuClassAnchor { label: "Apple Silicon Pro GPU (M3/M4 Pro)", expected_ub_pct: 82.0, expected_720p_fps: 78.0, tgp_note: "Unified 14–20 Core GPU" };
        }
        if n.contains("m2 max") || n.contains("m1 max") {
            return GpuClassAnchor { label: "Apple Silicon M1/M2 Max GPU", expected_ub_pct: 76.0, expected_720p_fps: 74.0, tgp_note: "Unified 24–38 Core GPU" };
        }
        if n.contains("m2 pro") || n.contains("m1 pro") || n.contains("m4") {
            return GpuClassAnchor { label: "Apple Silicon M1/M2 Pro / M4 GPU", expected_ub_pct: 52.0, expected_720p_fps: 50.0, tgp_note: "Unified 10–19 Core GPU" };
        }
        if n.contains("m3") || n.contains("m2") || n.contains("m1") {
            return GpuClassAnchor { label: "Apple Silicon Base GPU (M1/M2/M3)", expected_ub_pct: 26.0, expected_720p_fps: 28.0, tgp_note: "Unified 7–10 Core GPU" };
        }
    }
    if n.contains("quadro m5") || n.contains("quadro m4") || n.contains("quadro m3") {
        return GpuClassAnchor { label: "NVIDIA Quadro Mobile Workstation GPU (M3000M–M5000M)", expected_ub_pct: 42.0, expected_720p_fps: 42.0, tgp_note: "75W–100W Mobile Workstation" };
    }
    if n.contains("quadro m2")
        || n.contains("quadro m1")
        || n.contains("quadro m6")
        || n.contains("quadro p")
        || n.contains("quadro t")
        || n.contains("quadro rtx")
    {
        return GpuClassAnchor { label: "NVIDIA Quadro Mobile Workstation GPU", expected_ub_pct: 28.0, expected_720p_fps: 28.0, tgp_note: "35W–55W Mobile Workstation" };
    }
    if n.contains("rx 7900") || n.contains("rx 7800") || n.contains("rx 6800") {
        return GpuClassAnchor { label: "AMD Radeon RX Enthusiast Laptop GPU", expected_ub_pct: 98.0, expected_720p_fps: 92.0, tgp_note: "120W–165W SmartShift" };
    }
    if n.contains("rx 7700") || n.contains("rx 7600") || n.contains("rx 6700") || n.contains("rx 6600") {
        return GpuClassAnchor { label: "AMD Radeon RX Mid-Range Laptop GPU", expected_ub_pct: 68.0, expected_720p_fps: 66.0, tgp_note: "75W–120W SmartShift" };
    }
    if n.contains("arc a7") || n.contains("arc a5") {
        return GpuClassAnchor { label: "Intel Arc Discrete Laptop GPU", expected_ub_pct: 50.0, expected_720p_fps: 50.0, tgp_note: "60W–120W Mobile TGP" };
    }
    if n.contains("arc a3") {
        return GpuClassAnchor { label: "Intel Arc A3xx Discrete Laptop GPU", expected_ub_pct: 36.0, expected_720p_fps: 36.0, tgp_note: "30W–50W Entry Discrete TGP" };
    }
    if n.contains("arc graphics") || n.contains("arc pro") || n.contains("890m") || n.contains("880m") || n.contains("780m") {
        return GpuClassAnchor { label: "Modern High-EU Integrated GPU (Radeon 780M/890M / Intel Arc)", expected_ub_pct: 32.0, expected_720p_fps: 30.0, tgp_note: "Shared System RAM" };
    }
    if n.contains("680m") || n.contains("660m") || n.contains("iris xe") || n.contains("iris plus") {
        return GpuClassAnchor { label: "Integrated Iris Xe / Radeon 660M-680M", expected_ub_pct: 21.0, expected_720p_fps: 22.0, tgp_note: "Dual-Channel RAM Dependent" };
    }
    if n.contains("radeon r9 m") || n.contains("radeon r7 m") || n.contains("radeon r5 m") {
        return GpuClassAnchor { label: "AMD Radeon Legacy Mobile Discrete (R5/R7/R9 M-Series)", expected_ub_pct: 16.0, expected_720p_fps: 17.0, tgp_note: "25W–50W Legacy Mobile Discrete" };
    }
    if n.contains("radeon") || n.contains("vega") {
        return GpuClassAnchor { label: "Integrated AMD Radeon Graphics", expected_ub_pct: 17.0, expected_720p_fps: 18.0, tgp_note: "Shared System RAM" };
    }

    GpuClassAnchor {
        label: "Standard Integrated Graphics (Intel UHD / Basic)",
        expected_ub_pct: 8.0,
        expected_720p_fps: 11.0,
        tgp_note: "Office / Video Playback",
    }
}

fn rate_cpu_component(
    cpu_brand: &str,
    phys_cores: usize,
    log_cores: usize,
    single_core: Option<u64>,
    multi_core: Option<u64>,
    composite: Option<u64>,
    source_mode: &str,
) -> Option<(UserBenchmarkComponentRating, f64, f64)> {
    if cpu_brand.trim().is_empty() && composite.unwrap_or(0) == 0 && single_core.unwrap_or(0) == 0 {
        return None;
    }

    let anchor = lookup_mobile_cpu_class(cpu_brand, phys_cores, log_cores);
    let comp_val = composite.filter(|&v| v > 0).map(|v| v as f64);
    let sc_val = single_core.filter(|&v| v > 0).map(|v| v as f64);
    let mc_val = multi_core.filter(|&v| v > 0).map(|v| v as f64);

    let (ratio, gaming_ratio, workstation_ratio, measured_note) = match (comp_val, sc_val, mc_val) {
        (Some(c), Some(sc), Some(mc)) => {
            let c_ratio = (c / anchor.expected_composite).clamp(0.15, 2.0);
            let exp_sc = anchor.expected_composite * 0.85;
            let exp_mc = anchor.expected_composite * 1.05;
            let g_ratio = ((sc / exp_sc) * 0.50 + c_ratio * 0.50).clamp(0.15, 2.0);
            let w_ratio = ((mc / exp_mc) * 0.65 + c_ratio * 0.35).clamp(0.15, 2.0);
            (c_ratio, g_ratio, w_ratio, format!("Composite {:.0} (1C {:.0} / MC {:.0})", c, sc, mc))
        }
        (Some(c), _, _) => {
            let c_ratio = (c / anchor.expected_composite).clamp(0.15, 2.0);
            (c_ratio, c_ratio, c_ratio, format!("Composite Mark {:.0}", c))
        }
        (None, Some(sc), _) => {
            let r = (sc / (anchor.expected_composite * 0.85)).clamp(0.15, 2.0);
            (r, r, r, format!("Single-Core {:.0}", sc))
        }
        _ => (1.0, 1.0, 1.0, "Specs baseline preview (run Performance Bench for live score)".to_string()),
    };

    let effective_speed_pct = round1(anchor.expected_ub_pct * ratio);
    let gaming_cpu_pct = round1(anchor.expected_ub_pct * gaming_ratio);
    let workstation_cpu_pct = round1(anchor.expected_ub_pct * workstation_ratio);
    let relative_standing_pct = round1(ratio * 100.0);
    let vehicle_tier = vehicle_tier_from_pct(effective_speed_pct).to_string();
    let standing_label = standing_label_from_ratio(relative_standing_pct).to_string();

    let bottleneck_flag = if relative_standing_pct < 70.0 {
        Some("CPU Underperforming (Check Power Plan / Thermal Throttling)".to_string())
    } else {
        None
    };

    let plain_summary = format!(
        "{} scores {:.1}% ({} tier) — {} ({:.1}% of expected {} class). {}",
        if cpu_brand.trim().is_empty() { anchor.label } else { cpu_brand.trim() },
        effective_speed_pct,
        vehicle_tier,
        standing_label,
        relative_standing_pct,
        anchor.label,
        plain_tier_meaning(&vehicle_tier),
    );

    let sub_metrics = vec![
        ("Detected Class".to_string(), anchor.label.to_string()),
        ("Measurement".to_string(), measured_note),
        ("Gaming / 1C Bias %".to_string(), format!("{:.1}%", gaming_cpu_pct)),
        ("Workstation / All-Core %".to_string(), format!("{:.1}%", workstation_cpu_pct)),
    ];

    let rating = UserBenchmarkComponentRating {
        component: "CPU".to_string(),
        detected_model: if cpu_brand.trim().is_empty() {
            anchor.label.to_string()
        } else {
            cpu_brand.trim().to_string()
        },
        effective_speed_pct,
        expected_class_pct: round1(anchor.expected_ub_pct),
        relative_standing_pct,
        vehicle_tier,
        standing_label,
        plain_summary,
        source_mode: source_mode.to_string(),
        sub_metrics,
        bottleneck_flag,
    };

    Some((rating, gaming_cpu_pct, workstation_cpu_pct))
}

fn rate_gpu_component(
    gpu_name: &str,
    resolution: &str,
    avg_fps: Option<f64>,
    fps_drop_pct: Option<f64>,
    thermal_cutoff: bool,
    source_mode: &str,
) -> Option<UserBenchmarkComponentRating> {
    if !thermal_cutoff
        && (has_invalid_pos_metric(avg_fps) || matches!(fps_drop_pct, Some(d) if !d.is_finite()))
    {
        return None;
    }

    let valid_fps = valid_pos_opt(avg_fps);
    if gpu_name.trim().is_empty() && valid_fps.is_none() && !thermal_cutoff {
        return None;
    }

    let anchor = lookup_mobile_gpu_class(gpu_name);
    let model_label = if gpu_name.trim().is_empty() {
        anchor.label.to_string()
    } else {
        gpu_name.trim().to_string()
    };

    if thermal_cutoff {
        return Some(UserBenchmarkComponentRating {
            component: "GPU".to_string(),
            detected_model: model_label.clone(),
            effective_speed_pct: 0.0,
            expected_class_pct: round1(anchor.expected_ub_pct),
            relative_standing_pct: 0.0,
            vehicle_tier: "Raft".to_string(),
            standing_label: "Underperforming".to_string(),
            plain_summary: format!(
                "{} hit the GPU thermal safety cutoff during stress testing. Clean cooling fins and repaste GPU before buying/selling.",
                model_label
            ),
            source_mode: source_mode.to_string(),
            sub_metrics: vec![
                ("Class".to_string(), anchor.label.to_string()),
                ("TGP Profile".to_string(), anchor.tgp_note.to_string()),
            ],
            bottleneck_flag: Some("GPU Thermal Safety Cutoff Triggered".to_string()),
        });
    }

    let res_norm = resolution.to_lowercase();
    let res_scale = match res_norm.as_str() {
        "1080p" | "1920x1080" => 0.48,
        "1440p" | "2560x1440" => 0.28,
        "4k" | "3840x2160" => 0.13,
        _ => 1.0,
    };

    let (ratio, fps_note) = match valid_fps {
        Some(fps) => {
            let norm_720p = fps / res_scale;
            let raw_ratio = (norm_720p / anchor.expected_720p_fps).clamp(0.05, 2.2);
            (
                raw_ratio,
                format!("{:.1} FPS @ {} (720p-eq {:.1} FPS)", fps, if resolution.is_empty() { "720p" } else { resolution }, norm_720p),
            )
        }
        None => (1.0, "Specs baseline preview (run GPU Stress for live FPS)".to_string()),
    };

    let effective_speed_pct = round1(anchor.expected_ub_pct * ratio);
    let relative_standing_pct = round1(ratio * 100.0);
    let vehicle_tier = vehicle_tier_from_pct(effective_speed_pct).to_string();
    let standing_label = standing_label_from_ratio(relative_standing_pct).to_string();

    let throttle = fps_drop_pct.filter(|d| d.is_finite()).unwrap_or(0.0);
    let bottleneck_flag = if throttle >= 20.0 {
        Some(format!("GPU Thermal/Power Throttling ({:.1}% FPS drop)", throttle))
    } else if relative_standing_pct < 70.0 {
        Some("GPU Below Class Expectations (Check AC Power / TGP Limit / MUX)".to_string())
    } else {
        None
    };

    let plain_summary = format!(
        "{} scores {:.1}% ({} tier) — {} ({:.1}% of expected {} class, {}).",
        model_label,
        effective_speed_pct,
        vehicle_tier,
        standing_label,
        relative_standing_pct,
        anchor.label,
        anchor.tgp_note,
    );

    Some(UserBenchmarkComponentRating {
        component: "GPU".to_string(),
        detected_model: model_label,
        effective_speed_pct,
        expected_class_pct: round1(anchor.expected_ub_pct),
        relative_standing_pct,
        vehicle_tier,
        standing_label,
        plain_summary,
        source_mode: source_mode.to_string(),
        sub_metrics: vec![
            ("Class".to_string(), anchor.label.to_string()),
            ("TGP Profile".to_string(), anchor.tgp_note.to_string()),
            ("Measured FPS".to_string(), fps_note),
        ],
        bottleneck_flag,
    })
}

fn rate_ssd_component(
    model: &str,
    interface_hint: &str,
    media_hint: &str,
    seq_read: Option<f64>,
    seq_write: Option<f64>,
    rand_4k_read: Option<f64>,
    rand_4k_write: Option<f64>,
    integrity_errors: u64,
    source_mode: &str,
) -> Option<UserBenchmarkComponentRating> {
    if integrity_errors == 0
        && (has_invalid_pos_metric(seq_read)
            || has_invalid_pos_metric(seq_write)
            || has_invalid_pos_metric(rand_4k_read)
            || has_invalid_pos_metric(rand_4k_write))
    {
        return None;
    }

    let sr_opt = valid_pos_opt(seq_read);
    let sw_opt = valid_pos_opt(seq_write);
    let r4k_opt = valid_pos_opt(rand_4k_read);
    let w4k_opt = valid_pos_opt(rand_4k_write);

    if model.trim().is_empty()
        && interface_hint.trim().is_empty()
        && sr_opt.is_none()
        && integrity_errors == 0
    {
        return None;
    }

    let model_label = if !model.trim().is_empty() {
        model.trim().to_string()
    } else if !interface_hint.trim().is_empty() {
        format!("{} Drive", interface_hint.trim())
    } else {
        "System Drive".to_string()
    };

    if integrity_errors > 0 {
        return Some(UserBenchmarkComponentRating {
            component: "SSD".to_string(),
            detected_model: model_label.clone(),
            effective_speed_pct: 0.0,
            expected_class_pct: 100.0,
            relative_standing_pct: 0.0,
            vehicle_tier: "Raft".to_string(),
            standing_label: "Underperforming".to_string(),
            plain_summary: format!(
                "CRITICAL: {} reported {} data integrity mismatch(es). Replace this drive before relying on it.",
                model_label, integrity_errors
            ),
            source_mode: source_mode.to_string(),
            sub_metrics: vec![("Integrity Errors".to_string(), integrity_errors.to_string())],
            bottleneck_flag: Some("Drive Data Corruption / Integrity Error".to_string()),
        });
    }

    let m = model.to_lowercase();
    let iface = interface_hint.to_lowercase();
    let media = media_hint.to_lowercase();
    let sr = sr_opt.unwrap_or(0.0);

    let is_known_nvme = m.contains("nvme")
        || m.contains("sn5")
        || m.contains("sn7")
        || m.contains("sn8")
        || m.contains("980")
        || m.contains("990")
        || m.contains("970")
        || m.contains("960")
        || m.contains("p3")
        || m.contains("p5")
        || m.contains("pm9")
        || m.contains("pc7")
        || m.contains("pc8")
        || m.contains("p31")
        || m.contains("p41")
        || m.contains("p44")
        || m.contains("kc3000")
        || m.contains("micron")
        || m.contains("kioxia")
        || m.contains("hynix")
        || m.contains("solidigm")
        || m.contains("sabrent")
        || m.contains("apple ssd");
    let is_known_ssd_or_nvme = is_known_nvme
        || m.contains("ssd")
        || m.contains("kingston")
        || m.contains("crucial")
        || m.contains("evo")
        || m.contains("qvo")
        || m.contains("mx500")
        || m.contains("bx500")
        || m.contains("sa510")
        || m.contains("a400");
    let is_explicit_hdd_model = !is_known_ssd_or_nvme
        && (m.contains("hdd")
            || m.contains("barracuda")
            || m.contains("ironwolf")
            || m.contains("wd blue 5400")
            || m.contains("7200rpm")
            || m.contains("5400rpm")
            || m.contains("7200 rpm")
            || m.contains("5400 rpm")
            || m.contains("spzx")
            || m.contains("travelstar")
            || m.contains("spinpoint")
            || m.contains("caviar"));
    let is_hdd_media = media.contains("hdd")
        || media.contains("rotational")
        || media.contains("spinning")
        || (media.contains("hard")
            && !media.contains("fixed hard disk")
            && !media.contains("external hard disk"));
    let is_hdd = is_hdd_media
        || is_explicit_hdd_model
        || (!is_known_ssd_or_nvme
            && !iface.contains("nvme")
            && !iface.contains("pcie")
            && !media.contains("ssd")
            && !media.contains("solid state")
            && sr > 0.0
            && sr < 250.0);

    let (class_label, expected_ub_pct, exp_r, exp_w, exp_4k) = if is_hdd {
        ("Mechanical HDD (SATA)", 24.0, 120.0, 100.0, 1.2)
    } else if m.contains("990 pro")
        || m.contains("980 pro")
        || m.contains("sn850")
        || m.contains("p5 plus")
        || m.contains("kc3000")
        || m.contains("pm9a1")
        || m.contains("pc801")
        || sr >= 5200.0
    {
        ("PCIe 4.0 High-End NVMe (DRAM)", 310.0, 6500.0, 4800.0, 72.0)
    } else if m.contains("970 evo")
        || m.contains("sn770")
        || m.contains("sn750")
        || m.contains("pm981")
        || m.contains("p31")
        || m.contains("pc711")
        || sr >= 3000.0
    {
        ("PCIe 4.0 Mid / PCIe 3.0 High NVMe", 210.0, 3800.0, 2800.0, 55.0)
    } else if iface.contains("nvme") || iface.contains("pcie") || is_known_nvme || sr >= 700.0 {
        ("Entry NVMe / DRAM-less SSD", 135.0, 2200.0, 1400.0, 40.0)
    } else {
        ("SATA III SSD", 95.0, 520.0, 460.0, 32.0)
    };

    let sw = sw_opt.unwrap_or(0.0);
    let r4k = r4k_opt.unwrap_or(0.0);
    let w4k = w4k_opt.unwrap_or(0.0);

    let ratio = if sr > 0.0 {
        let r_ratio = (sr / exp_r).clamp(0.1, 2.0);
        let w_ratio = if sw > 0.0 { (sw / exp_w).clamp(0.1, 2.0) } else { r_ratio };
        let k_ratio = if r4k > 0.0 { (r4k / exp_4k).clamp(0.1, 2.0) } else { r_ratio };
        (r_ratio * 0.35 + w_ratio * 0.25 + k_ratio * 0.40).clamp(0.1, 2.0)
    } else {
        1.0
    };

    let effective_speed_pct = round1(expected_ub_pct * ratio);
    let relative_standing_pct = round1(ratio * 100.0);
    let vehicle_tier = vehicle_tier_from_pct(effective_speed_pct).to_string();
    let standing_label = standing_label_from_ratio(relative_standing_pct).to_string();

    let bottleneck_flag = if class_label.starts_with("Mechanical") {
        Some("Mechanical HDD OS Bottleneck (Upgrade to SSD Strongly Recommended)".to_string())
    } else if relative_standing_pct < 70.0 {
        Some("SSD Slower Than Expected (Check Thermal Throttling, Full Drive, or PCIe Lanes)".to_string())
    } else {
        None
    };

    let plain_summary = format!(
        "{} ({}) scores {:.1}% ({} tier) — {} ({:.1}% of class baseline).",
        model_label, class_label, effective_speed_pct, vehicle_tier, standing_label, relative_standing_pct
    );

    let mut sub_metrics = vec![("Storage Class".to_string(), class_label.to_string())];
    if sr > 0.0 {
        sub_metrics.push(("Seq Read / Write".to_string(), format!("{:.0} / {:.0} MB/s", sr, sw)));
    }
    if r4k > 0.0 || w4k > 0.0 {
        sub_metrics.push(("4K Random R / W".to_string(), format!("{:.1} / {:.1} MB/s", r4k, w4k)));
    }

    Some(UserBenchmarkComponentRating {
        component: "SSD".to_string(),
        detected_model: model_label,
        effective_speed_pct,
        expected_class_pct: round1(expected_ub_pct),
        relative_standing_pct,
        vehicle_tier,
        standing_label,
        plain_summary,
        source_mode: source_mode.to_string(),
        sub_metrics,
        bottleneck_flag,
    })
}

fn rate_ram_component(
    ram_type: &str,
    bandwidth_gb_s: Option<f64>,
    latency_ns: Option<f64>,
    channel_mode: Option<&str>,
    single_dimm_in_multi_slot: bool,
    errors_found: u64,
    source_mode: &str,
) -> Option<UserBenchmarkComponentRating> {
    if errors_found == 0
        && (has_invalid_pos_metric(bandwidth_gb_s) || has_invalid_pos_metric(latency_ns))
    {
        return None;
    }

    let bw_val = valid_pos_opt(bandwidth_gb_s);
    let lat_val = valid_pos_opt(latency_ns);

    if ram_type.trim().is_empty()
        && bw_val.is_none()
        && lat_val.is_none()
        && channel_mode.is_none()
        && errors_found == 0
    {
        return None;
    }

    let mt = ram_type.to_lowercase();
    let (class_label, expected_ub_pct, exp_bw, exp_lat, sc_bw_thresh) =
        if mt.contains("ddr5") || mt.contains("lpddr5") || mt.contains("unified") {
            ("DDR5 / LPDDR5X / Unified Memory", 105.0, 46.0, 78.0, 27.0)
        } else if mt.contains("ddr4") || mt.contains("lpddr4") {
            ("DDR4 / LPDDR4X Memory", 82.0, 32.0, 72.0, 20.0)
        } else if mt.contains("ddr3") || mt.contains("lpddr3") {
            ("DDR3 / LPDDR3 Memory", 55.0, 16.0, 68.0, 11.0)
        } else {
            ("Laptop System RAM", 75.0, 28.0, 75.0, 18.0)
        };

    let model_label = if ram_type.trim().is_empty() {
        class_label.to_string()
    } else {
        ram_type.trim().to_string()
    };

    if errors_found > 0 {
        return Some(UserBenchmarkComponentRating {
            component: "RAM".to_string(),
            detected_model: model_label.clone(),
            effective_speed_pct: 0.0,
            expected_class_pct: round1(expected_ub_pct),
            relative_standing_pct: 0.0,
            vehicle_tier: "Raft".to_string(),
            standing_label: "Underperforming".to_string(),
            plain_summary: format!(
                "CRITICAL: {} RAM bit-flip error(s) detected! Faulty memory module or board trace.",
                errors_found
            ),
            source_mode: source_mode.to_string(),
            sub_metrics: vec![("Bit-Flip Errors".to_string(), errors_found.to_string())],
            bottleneck_flag: Some("RAM Hardware Bit-Flip Error Detected".to_string()),
        });
    }

    let ch_lower = channel_mode.map(|m| m.to_lowercase()).unwrap_or_default();
    let suppress_single_channel = mt.contains("lpddr")
        || mt.contains("unified")
        || ch_lower.contains("dual")
        || ch_lower.contains("unified")
        || ch_lower.contains("integrated")
        || ch_lower.contains("soldered")
        || ch_lower.contains("on-board")
        || ch_lower.contains("flex")
        || ch_lower.contains("quad")
        || ch_lower.contains("multi");
    let explicit_single = !suppress_single_channel && ch_lower.contains("single");
    let ch_empty_or_unknown = ch_lower.trim().is_empty() || ch_lower.contains("unknown");
    let low_bw_single = !suppress_single_channel
        && ch_empty_or_unknown
        && bw_val.map(|b| b < sc_bw_thresh).unwrap_or(false);
    let is_single_channel =
        explicit_single || (!suppress_single_channel && single_dimm_in_multi_slot) || low_bw_single;

    let ratio = match (bw_val, lat_val) {
        (Some(bw), Some(lat)) => {
            let bw_r = (bw / exp_bw).clamp(0.20, 1.6);
            let lat_r = (exp_lat / lat).clamp(0.45, 1.4);
            (bw_r * 0.72 + lat_r * 0.28).clamp(0.20, 1.55)
        }
        (Some(bw), None) => (bw / exp_bw).clamp(0.20, 1.55),
        (None, _) => {
            if is_single_channel {
                0.58
            } else {
                1.0
            }
        }
    };

    let effective_speed_pct = round1(expected_ub_pct * ratio);
    let relative_standing_pct = round1(ratio * 100.0);
    let vehicle_tier = vehicle_tier_from_pct(effective_speed_pct).to_string();
    let standing_label = standing_label_from_ratio(relative_standing_pct).to_string();

    let bottleneck_flag = if is_single_channel {
        Some("Single-Channel RAM Bottleneck Detected".to_string())
    } else if relative_standing_pct < 70.0 {
        Some("Memory Throughput Below Class Expectations".to_string())
    } else {
        None
    };

    let plain_summary = if is_single_channel {
        format!(
            "{} is running in Single-Channel mode ({:.1}% — {} tier, {:.1}% of Dual-Channel potential). Adding a second matching DIMM boosts memory bandwidth and iGPU/CPU speed.",
            model_label, effective_speed_pct, vehicle_tier, relative_standing_pct
        )
    } else {
        format!(
            "{} scores {:.1}% ({} tier) — {} ({:.1}% of expected dual-channel {} class).",
            model_label, effective_speed_pct, vehicle_tier, standing_label, relative_standing_pct, class_label
        )
    };

    let mut sub_metrics = vec![("Memory Class".to_string(), class_label.to_string())];
    if let Some(ch) = channel_mode {
        sub_metrics.push(("Channel Mode".to_string(), ch.to_string()));
    } else if is_single_channel {
        sub_metrics.push(("Channel Mode".to_string(), "Single-Channel (Inferred)".to_string()));
    }
    if let Some(bw) = bw_val {
        sub_metrics.push(("Bandwidth".to_string(), format!("{:.1} GB/s", bw)));
    }
    if let Some(lat) = lat_val {
        sub_metrics.push(("Latency".to_string(), format!("{:.1} ns", lat)));
    }

    Some(UserBenchmarkComponentRating {
        component: "RAM".to_string(),
        detected_model: model_label,
        effective_speed_pct,
        expected_class_pct: round1(expected_ub_pct),
        relative_standing_pct,
        vehicle_tier,
        standing_label,
        plain_summary,
        source_mode: source_mode.to_string(),
        sub_metrics,
        bottleneck_flag,
    })
}

fn weighted_avg(terms: &[(Option<f64>, f64)]) -> f64 {
    let mut sum_w = 0.0;
    let mut sum_v = 0.0;
    for &(val_opt, w) in terms {
        if let Some(v) = val_opt {
            if v.is_finite() && w > 0.0 {
                sum_w += w;
                sum_v += v * w;
            }
        }
    }
    if sum_w > 0.0 {
        round1(sum_v / sum_w)
    } else {
        0.0
    }
}

/// Evaluates hardware specs & measured LaptopBench marks against the calibrated UserBenchmark
/// mobile-aware scale, optionally probing `userbenchmark.com` with a strict <=800ms timeout.
pub fn compare_userbenchmark(input: &UserBenchmarkInput) -> UserBenchmarkComparison {
    let specs_ref = input.specs.as_ref();
    let perf_ref = input.perf.as_ref();
    let gpu_ref = input.gpu.as_ref();
    let storage_ref = input.storage.as_ref();
    let ram_ref = input.ram.as_ref();

    let cpu_brand = if !input.cpu_brand.trim().is_empty() {
        input.cpu_brand.clone()
    } else {
        specs_ref.map(|s| s.cpu_brand.clone()).unwrap_or_default()
    };

    let source_mode = try_live_lookup_status(input.allow_live_lookup, &cpu_brand);

    let phys_cores = input
        .cpu_physical_cores
        .or_else(|| specs_ref.map(|s| s.cpu_physical_cores))
        .unwrap_or(4);
    let log_cores = input
        .cpu_logical_cores
        .or_else(|| specs_ref.map(|s| s.cpu_logical_cores))
        .unwrap_or(phys_cores * 2);

    let cpu_sc = input
        .cpu_single_core
        .or_else(|| perf_ref.map(|p| p.single_core_score));
    let cpu_mc = input
        .cpu_multi_core
        .or_else(|| perf_ref.map(|p| p.multi_core_score));
    let cpu_comp = input
        .cpu_composite
        .or_else(|| perf_ref.map(|p| p.composite_score));

    let cpu_eval = rate_cpu_component(
        &cpu_brand,
        phys_cores,
        log_cores,
        cpu_sc,
        cpu_mc,
        cpu_comp,
        source_mode,
    );

    let gpu_name = input
        .gpu_name
        .clone()
        .or_else(|| gpu_ref.map(|g| g.adapter_name.clone()))
        .or_else(|| {
            specs_ref.and_then(|s| {
                s.gpus
                    .iter()
                    .find(|g| g.is_discrete)
                    .or_else(|| s.gpus.first())
                    .map(|g| g.name.clone())
            })
        })
        .unwrap_or_default();

    let gpu_res = input
        .gpu_resolution
        .clone()
        .or_else(|| gpu_ref.map(|g| g.resolution.clone()))
        .unwrap_or_else(|| "1080p".to_string());
    let gpu_fps = input
        .gpu_avg_fps
        .or_else(|| gpu_ref.map(|g| g.avg_fps).filter(|&f| f.is_finite() && f > 0.0));
    let gpu_drop = input
        .gpu_fps_drop_pct
        .or_else(|| gpu_ref.map(|g| g.fps_drop_pct).filter(|&d| d.is_finite()));
    let gpu_cutoff = input.gpu_thermal_cutoff
        || gpu_ref.map(|g| g.thermal_cutoff_triggered).unwrap_or(false);

    let gpu_rating = rate_gpu_component(
        &gpu_name,
        &gpu_res,
        gpu_fps,
        gpu_drop,
        gpu_cutoff,
        source_mode,
    );

    let first_disk = specs_ref.and_then(|s| s.disks.first());
    let ssd_model = input
        .ssd_model
        .clone()
        .or_else(|| first_disk.map(|d| d.model.clone()))
        .unwrap_or_default();
    let ssd_iface = input
        .ssd_interface
        .clone()
        .or_else(|| first_disk.map(|d| d.interface_type.clone()))
        .unwrap_or_default();
    let ssd_media = input
        .ssd_media_type
        .clone()
        .or_else(|| first_disk.map(|d| d.media_type.clone()))
        .unwrap_or_default();
    let ssd_seq_r = input
        .ssd_seq_read_mb_s
        .or_else(|| storage_ref.map(|s| s.seq_read_mb_s).filter(|&v| v.is_finite() && v > 0.0));
    let ssd_seq_w = input
        .ssd_seq_write_mb_s
        .or_else(|| storage_ref.map(|s| s.seq_write_mb_s).filter(|&v| v.is_finite() && v > 0.0));
    let ssd_4k_r = input
        .ssd_rand_4k_read_mb_s
        .or_else(|| storage_ref.map(|s| s.rand_4k_read_mb_s).filter(|&v| v.is_finite() && v > 0.0));
    let ssd_4k_w = input
        .ssd_rand_4k_write_mb_s
        .or_else(|| storage_ref.map(|s| s.rand_4k_write_mb_s).filter(|&v| v.is_finite() && v > 0.0));
    let ssd_errs = input
        .ssd_integrity_errors
        .max(storage_ref.map(|s| s.integrity_errors).unwrap_or(0));

    let ssd_rating = rate_ssd_component(
        &ssd_model,
        &ssd_iface,
        &ssd_media,
        ssd_seq_r,
        ssd_seq_w,
        ssd_4k_r,
        ssd_4k_w,
        ssd_errs,
        source_mode,
    );

    let cpu_norm = normalize_hw_name(&cpu_brand);
    let is_apple_silicon_cpu = cpu_norm.contains("apple")
        && (cpu_norm.contains("m1")
            || cpu_norm.contains("m2")
            || cpu_norm.contains("m3")
            || cpu_norm.contains("m4"));

    let ram_type = input
        .ram_type
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            specs_ref
                .and_then(|s| s.ram_modules.first().map(|m| m.memory_type.clone()))
                .filter(|t| !t.trim().is_empty())
        })
        .unwrap_or_else(|| {
            if is_apple_silicon_cpu {
                "Unified Memory (Apple Silicon)".to_string()
            } else {
                String::new()
            }
        });
    let ram_bw = input
        .ram_bandwidth_gb_s
        .or_else(|| perf_ref.map(|p| p.memory_bandwidth_gb_s).filter(|&b| b.is_finite() && b > 0.0))
        .or_else(|| ram_ref.map(|r| r.peak_bandwidth_gb_s).filter(|&b| b.is_finite() && b > 0.0));
    let ram_lat = input
        .ram_latency_ns
        .or_else(|| perf_ref.map(|p| p.memory_latency_ns).filter(|&l| l.is_finite() && l > 0.0));
    let ram_channel = input
        .ram_channel_mode
        .clone()
        .or_else(|| specs_ref.and_then(|s| s.ram_channel_mode.clone()));
    let single_dimm_multi_slot = specs_ref
        .map(|s| {
            s.ram_modules.len() == 1
                && s.ram_slots_total.unwrap_or(0) >= 2
                && !ram_type.to_lowercase().contains("lpddr")
                && !ram_type.to_lowercase().contains("unified")
        })
        .unwrap_or(false);
    let ram_errs = input
        .ram_errors_found
        .max(ram_ref.map(|r| r.errors_found).unwrap_or(0));

    let ram_rating = rate_ram_component(
        &ram_type,
        ram_bw,
        ram_lat,
        ram_channel.as_deref(),
        single_dimm_multi_slot,
        ram_errs,
        source_mode,
    );

    let (cpu_rating, cpu_gaming_pct, cpu_ws_pct) = match cpu_eval {
        Some((r, g, w)) => (Some(r), Some(g), Some(w)),
        None => (None, None, None),
    };

    let cpu_desktop_pct = cpu_rating.as_ref().map(|r| r.effective_speed_pct);
    let gpu_pct = gpu_rating.as_ref().map(|r| r.effective_speed_pct);
    // Cap SSD profile contribution at 165% so ultra-fast NVMe doesn't inflate desktop % above realistic ranges
    let ssd_profile_pct = ssd_rating.as_ref().map(|r| r.effective_speed_pct.min(165.0));
    let ram_pct = ram_rating.as_ref().map(|r| r.effective_speed_pct);

    let gaming_pct = weighted_avg(&[(gpu_pct, 0.65), (cpu_gaming_pct, 0.25), (ram_pct, 0.10)]);
    let desktop_pct = weighted_avg(&[(cpu_desktop_pct, 0.45), (ssd_profile_pct, 0.40), (ram_pct, 0.15)]);
    let workstation_pct = weighted_avg(&[
        (cpu_ws_pct, 0.45),
        (gpu_pct, 0.30),
        (ssd_profile_pct, 0.15),
        (ram_pct, 0.10),
    ]);

    let overall_pct = weighted_avg(&[
        (if desktop_pct > 0.0 { Some(desktop_pct) } else { None }, 0.40),
        (if gaming_pct > 0.0 { Some(gaming_pct) } else { None }, 0.35),
        (if workstation_pct > 0.0 { Some(workstation_pct) } else { None }, 0.25),
    ]);
    let has_critical_fault = gpu_cutoff || ssd_errs > 0 || ram_errs > 0;
    let overall_vehicle_tier = if has_critical_fault {
        "Raft".to_string()
    } else {
        vehicle_tier_from_pct(overall_pct).to_string()
    };

    let mut recommendations = Vec::new();
    for comp in [&cpu_rating, &gpu_rating, &ssd_rating, &ram_rating] {
        if let Some(c) = comp {
            if let Some(flag) = &c.bottleneck_flag {
                if flag.contains("Single-Channel") {
                    recommendations.push(
                        "Upgrade to Dual-Channel RAM by adding a matching second memory stick (+25–45% bandwidth & smoother gaming/UI).".to_string(),
                    );
                } else if flag.contains("Mechanical HDD") {
                    recommendations.push(
                        "Replace the mechanical HDD with an NVMe or SATA SSD for a dramatic boot and app responsiveness boost.".to_string(),
                    );
                } else {
                    recommendations.push(format!("{}: {}", c.component, flag));
                }
            }
        }
    }
    if recommendations.is_empty() && overall_pct > 0.0 {
        recommendations.push(
            "Balanced configuration — all evaluated subsystems are performing cleanly within expected laptop class ranges.".to_string(),
        );
    }

    let headline_summary = if has_critical_fault {
        let mut faults = Vec::new();
        if gpu_cutoff {
            faults.push("GPU thermal cutoff");
        }
        if ssd_errs > 0 {
            faults.push("SSD data integrity errors");
        }
        if ram_errs > 0 {
            faults.push("RAM bit-flip errors");
        }
        format!(
            "CRITICAL HARDWARE FAULT ({}) — Overall {} Tier ({:.1}% avg) — Gaming {:.1}% | Desktop {:.1}% | Workstation {:.1}% [{}]",
            faults.join(", "),
            overall_vehicle_tier,
            overall_pct,
            gaming_pct,
            desktop_pct,
            workstation_pct,
            source_mode
        )
    } else if overall_pct <= 0.0 {
        "No hardware metrics provided yet — run system scan or benchmarks to compute UserBenchmark ratings.".to_string()
    } else {
        format!(
            "Overall {} Tier ({:.1}% avg) — Gaming {:.1}% | Desktop {:.1}% | Workstation {:.1}% [{}]",
            overall_vehicle_tier, overall_pct, gaming_pct, desktop_pct, workstation_pct, source_mode
        )
    };

    UserBenchmarkComparison {
        gaming_pct,
        desktop_pct,
        workstation_pct,
        overall_vehicle_tier,
        cpu: cpu_rating,
        gpu: gpu_rating,
        ssd: ssd_rating,
        ram: ram_rating,
        headline_summary,
        recommendations,
        source_mode: source_mode.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_vehicle_tier_exact_boundaries() {
        let cases = [
            (-5.0, "Raft"),
            (0.0, "Raft"),
            (29.9, "Raft"),
            (30.0, "Jet Ski"),
            (39.9, "Jet Ski"),
            (40.0, "Speedboat"),
            (59.9, "Speedboat"),
            (60.0, "Destroyer"),
            (64.9, "Destroyer"),
            (65.0, "Cruiser"),
            (69.9, "Cruiser"),
            (70.0, "Battleship"),
            (79.9, "Battleship"),
            (80.0, "Aircraft Carrier"),
            (89.9, "Aircraft Carrier"),
            (90.0, "Nuclear Submarine"),
            (99.9, "Nuclear Submarine"),
            (100.0, "UFO"),
            (250.0, "UFO"),
            (f64::NAN, "Raft"),
            (f64::INFINITY, "Raft"),
        ];
        for (pct, expected) in cases {
            assert_eq!(
                vehicle_tier_from_pct(pct),
                expected,
                "Failed Vehicle Tier boundary for {}",
                pct
            );
        }
    }

    #[test]
    fn test_standing_label_exact_boundaries() {
        assert_eq!(standing_label_from_ratio(69.9), "Underperforming");
        assert_eq!(standing_label_from_ratio(70.0), "Below Expectations");
        assert_eq!(standing_label_from_ratio(84.9), "Below Expectations");
        assert_eq!(standing_label_from_ratio(85.0), "As Expected");
        assert_eq!(standing_label_from_ratio(104.9), "As Expected");
        assert_eq!(standing_label_from_ratio(105.0), "Above Expectations");
        assert_eq!(standing_label_from_ratio(f64::NAN), "Underperforming");
    }

    #[test]
    fn test_mobile_cpu_matching_and_apple_silicon() {
        let hx = lookup_mobile_cpu_class("Intel Core i7-13700HX", 16, 24);
        let u = lookup_mobile_cpu_class("Intel Core i5-1335U", 10, 12);
        let celeron = lookup_mobile_cpu_class("Intel Celeron N4020", 2, 2);
        let m3_max = lookup_mobile_cpu_class("Apple M3 Max", 16, 16);
        let ryzen_ai = lookup_mobile_cpu_class("AMD Ryzen AI 9 HX 370", 12, 24);

        assert!(hx.expected_ub_pct > u.expected_ub_pct);
        assert!(u.expected_ub_pct > celeron.expected_ub_pct);
        assert_eq!(vehicle_tier_from_pct(m3_max.expected_ub_pct), "UFO");
        assert_eq!(vehicle_tier_from_pct(ryzen_ai.expected_ub_pct), "UFO");
        assert_eq!(vehicle_tier_from_pct(celeron.expected_ub_pct), "Jet Ski");
    }

    #[test]
    fn test_gpu_resolution_normalization_and_thermal_cutoff() {
        let r1080 = rate_gpu_component("NVIDIA GeForce RTX 4060 Laptop GPU", "1080p", Some(40.8), Some(5.0), false, OFFLINE_MODE).unwrap();
        let r720 = rate_gpu_component("NVIDIA GeForce RTX 4060 Laptop GPU", "720p", Some(85.0), Some(5.0), false, OFFLINE_MODE).unwrap();
        assert!(
            (r1080.effective_speed_pct - r720.effective_speed_pct).abs() < 0.2,
            "1080p ({}) vs 720p ({}) should normalize identically",
            r1080.effective_speed_pct,
            r720.effective_speed_pct
        );
        assert_eq!(r1080.standing_label, "As Expected");

        let cutoff = rate_gpu_component("NVIDIA GeForce RTX 4060 Laptop GPU", "1080p", Some(40.0), Some(10.0), true, OFFLINE_MODE).unwrap();
        assert_eq!(cutoff.effective_speed_pct, 0.0);
        assert_eq!(cutoff.vehicle_tier, "Raft");
        assert_eq!(cutoff.standing_label, "Underperforming");
        assert!(cutoff.bottleneck_flag.is_some());
    }

    #[test]
    fn test_ssd_classification_and_integrity_hard_fail() {
        let nvme = rate_ssd_component("Samsung 980 PRO 1TB", "NVMe", "SSD", Some(6600.0), Some(4900.0), Some(75.0), Some(180.0), 0, OFFLINE_MODE).unwrap();
        let sata = rate_ssd_component("Samsung 870 EVO", "SATA", "SSD", Some(530.0), Some(480.0), Some(34.0), Some(90.0), 0, OFFLINE_MODE).unwrap();
        let hdd = rate_ssd_component("WDC WD10SPZX", "SATA", "HDD", Some(115.0), Some(95.0), Some(1.1), Some(1.0), 0, OFFLINE_MODE).unwrap();
        assert!(nvme.effective_speed_pct > sata.effective_speed_pct);
        assert!(sata.effective_speed_pct > hdd.effective_speed_pct);
        assert!(hdd.bottleneck_flag.unwrap().contains("HDD"));

        let corrupt = rate_ssd_component("Samsung 980 PRO 1TB", "NVMe", "SSD", Some(6600.0), Some(4900.0), Some(75.0), Some(180.0), 3, OFFLINE_MODE).unwrap();
        assert_eq!(corrupt.effective_speed_pct, 0.0);
        assert_eq!(corrupt.vehicle_tier, "Raft");
        assert_eq!(corrupt.standing_label, "Underperforming");
    }

    #[test]
    fn test_single_channel_ram_flagging_and_bit_flip_fail() {
        let input_sc_mode = UserBenchmarkInput {
            cpu_brand: "Intel Core i5-12450H".into(),
            ram_type: Some("DDR4".into()),
            ram_channel_mode: Some("Single-Channel (1 of 2 slots)".into()),
            ram_bandwidth_gb_s: Some(15.2),
            ram_latency_ns: Some(85.0),
            ..Default::default()
        };
        let cmp = compare_userbenchmark(&input_sc_mode);
        let ram = cmp.ram.expect("RAM rating should be present");
        assert!(ram.bottleneck_flag.as_deref().unwrap_or("").contains("Single-Channel"));
        assert!(cmp.recommendations.iter().any(|r| r.contains("Dual-Channel")));
        assert!(ram.relative_standing_pct < 70.0);

        // Also test low-bandwidth single-channel inference without explicit channel_mode string
        let inferred = rate_ram_component("DDR5-4800", Some(21.0), Some(92.0), None, false, 0, OFFLINE_MODE).unwrap();
        assert!(inferred.bottleneck_flag.as_deref().unwrap_or("").contains("Single-Channel"));

        // Bit-flip error forces Raft / Underperforming
        let bad_ram = rate_ram_component("DDR5-5600", Some(50.0), Some(70.0), Some("Dual-Channel"), false, 2, OFFLINE_MODE).unwrap();
        assert_eq!(bad_ram.effective_speed_pct, 0.0);
        assert_eq!(bad_ram.vehicle_tier, "Raft");
        assert_eq!(bad_ram.standing_label, "Underperforming");
    }

    #[test]
    fn test_offline_comparison_and_bounded_live_fallback() {
        let input = UserBenchmarkInput {
            cpu_brand: "AMD Ryzen 7 7840HS".into(),
            cpu_physical_cores: Some(8),
            cpu_logical_cores: Some(16),
            cpu_single_core: Some(13500),
            cpu_multi_core: Some(16000),
            cpu_composite: Some(15400),
            gpu_name: Some("NVIDIA GeForce RTX 4060 Laptop GPU".into()),
            gpu_resolution: Some("1080p".into()),
            gpu_avg_fps: Some(41.0),
            ssd_model: Some("WD Black SN770".into()),
            ssd_interface: Some("NVMe".into()),
            ssd_seq_read_mb_s: Some(4100.0),
            ssd_seq_write_mb_s: Some(3200.0),
            ssd_rand_4k_read_mb_s: Some(60.0),
            ram_type: Some("DDR5".into()),
            ram_bandwidth_gb_s: Some(48.0),
            ram_latency_ns: Some(74.0),
            ram_channel_mode: Some("Dual-Channel".into()),
            allow_live_lookup: false,
            ..Default::default()
        };

        let t0 = Instant::now();
        let res = compare_userbenchmark(&input);
        assert!(t0.elapsed() < Duration::from_millis(200));
        assert_eq!(res.source_mode, OFFLINE_MODE);
        assert!(res.gaming_pct >= 80.0 && res.desktop_pct >= 85.0 && res.workstation_pct >= 85.0);
        assert!(res.cpu.is_some() && res.gpu.is_some() && res.ssd.is_some() && res.ram.is_some());

        // Even with allow_live_lookup = true, must return cleanly within <=1s and NOT stamp "live_verified"
        // without component-level live data parsed.
        let mut live_input = input;
        live_input.allow_live_lookup = true;
        let t1 = Instant::now();
        let live_res = compare_userbenchmark(&live_input);
        assert!(t1.elapsed() < Duration::from_millis(1200));
        assert_eq!(live_res.source_mode, OFFLINE_MODE);
        assert!(live_res.desktop_pct > 0.0);
    }

    #[test]
    fn test_embedded_specs_and_camel_case_json_contract() {
        let json_str = r#"{
            "specs": {
                "osFamily": "Windows",
                "osName": "Windows 11 Pro",
                "osVersion": "23H2",
                "osBuild": "22631",
                "architecture": "x86_64",
                "hostname": "TEST-LAPTOP",
                "manufacturer": "Lenovo",
                "model": "ThinkPad T14 Gen 4",
                "systemSku": "SKU1",
                "chassisType": "Notebook",
                "serialNumber": "SN123",
                "systemUuid": "UUID1",
                "motherboardVendor": "Lenovo",
                "motherboardProduct": "T14",
                "motherboardSerial": "MB1",
                "biosVendor": "Lenovo",
                "biosVersion": "1.10",
                "biosDate": "2024-01-01",
                "cpuBrand": "Intel Core i7-13700H",
                "cpuSocket": "BGA",
                "cpuPhysicalCores": 14,
                "cpuLogicalCores": 20,
                "cpuBaseMhz": 2400,
                "cpuMaxMhz": 5000,
                "cpuL2Kb": 11520,
                "cpuL3Kb": 24576,
                "cpuVirtualization": true,
                "totalRamGb": 16.0,
                "ramSlotsTotal": 2,
                "ramMaxCapacityGb": 64.0,
                "ramModules": [{
                    "slot": "DIMM 0",
                    "capacityGb": 16.0,
                    "speedMhz": 3200,
                    "memoryType": "DDR4",
                    "formFactor": "SODIMM",
                    "manufacturer": "Samsung",
                    "partNumber": "M471A2K43DB1",
                    "serialNumber": "0001"
                }],
                "gpus": [{
                    "name": "Intel Iris Xe Graphics",
                    "vendor": "Intel",
                    "vramMb": 128,
                    "driverVersion": "31.0",
                    "driverDate": "2024-01-01",
                    "pnpDeviceId": "PCI\\VEN_8086",
                    "isDiscrete": false
                }],
                "disks": [{
                    "model": "Samsung PM9A1 512GB",
                    "interfaceType": "NVMe",
                    "mediaType": "SSD",
                    "sizeGb": 512.0,
                    "serialNumber": "SSD1",
                    "firmware": "1.0",
                    "partitionStyle": "GPT"
                }],
                "volumes": [],
                "displays": [],
                "networkAdapters": [],
                "peripherals": [],
                "isGamingCapable": false,
                "isElevated": true,
                "uptimeSeconds": 100
            }
        }"#;
        let input: UserBenchmarkInput = serde_json::from_str(json_str).expect("UserBenchmarkInput JSON must deserialize cleanly");
        let cmp = compare_userbenchmark(&input);
        assert!(cmp.cpu.is_some());
        assert!(cmp.gpu.is_some());
        assert!(cmp.ssd.is_some());
        let ram = cmp.ram.as_ref().expect("RAM rating should be derived from SystemSpecs");
        assert!(ram.bottleneck_flag.as_deref().unwrap_or("").contains("Single-Channel"));

        let out_json = serde_json::to_value(&cmp).unwrap();
        assert!(out_json.get("gamingPct").is_some());
        assert!(out_json.get("desktopPct").is_some());
        assert!(out_json.get("workstationPct").is_some());
        assert!(out_json.get("overallVehicleTier").is_some());
    }

    #[test]
    fn test_windows_fixed_hard_disk_media_not_misclassified_as_hdd() {
        for model in [
            "Micron 2450 NVMe 256GB",
            "Samsung SSD 980 1TB",
            "Crucial P3 1TB",
            "WD Blue SN570 500GB",
            "SK hynix Gold P31 1TB",
        ] {
            let r = rate_ssd_component(
                model,
                "SCSI",
                "Fixed hard disk media",
                None,
                None,
                None,
                None,
                0,
                OFFLINE_MODE,
            )
            .expect("SSD should rate cleanly");
            assert!(
                !r.plain_summary.contains("Mechanical HDD"),
                "{} should NOT be classified as Mechanical HDD: {}",
                model,
                r.plain_summary
            );
            assert!(
                r.effective_speed_pct >= 95.0,
                "{} should rate as SSD/NVMe (>=95%), got {}",
                model,
                r.effective_speed_pct
            );
            assert!(
                !r.bottleneck_flag
                    .as_deref()
                    .unwrap_or("")
                    .contains("Mechanical HDD"),
                "{} should not emit Mechanical HDD bottleneck",
                model
            );
        }

        // Throttled known NVMe with <250 MB/s read speed must still stay NVMe (underperforming), NOT HDD
        let throttled_nvme = rate_ssd_component(
            "WD Black SN770 1TB",
            "SCSI",
            "Fixed hard disk media",
            Some(200.0),
            None,
            None,
            None,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(!throttled_nvme.plain_summary.contains("Mechanical HDD"));
        assert!(throttled_nvme
            .bottleneck_flag
            .as_deref()
            .unwrap_or("")
            .contains("Slower Than Expected"));

        // Genuine mechanical HDD must still be caught
        let real_hdd = rate_ssd_component(
            "WDC WD10SPZX",
            "SATA",
            "Fixed hard disk media",
            Some(115.0),
            Some(95.0),
            None,
            None,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(real_hdd.plain_summary.contains("Mechanical HDD"));
        assert!(real_hdd
            .bottleneck_flag
            .as_deref()
            .unwrap_or("")
            .contains("Mechanical HDD"));
    }

    #[test]
    fn test_apple_silicon_unified_lpddr_and_dual_channel_not_flagged_single() {
        // 1. Apple Silicon macOS specs: ram_modules = [], channel_mode = Unified / Integrated Memory, bw = 17.0 GB/s
        let mut apple_specs: crate::types::SystemSpecs = serde_json::from_str(
            r#"{
                "osFamily": "macOS", "osName": "macOS", "osVersion": "14.5", "osBuild": "23F79",
                "architecture": "aarch64", "hostname": "MacBookPro", "manufacturer": "Apple",
                "model": "MacBook Pro", "systemSku": "", "chassisType": "Laptop", "serialNumber": "",
                "systemUuid": "", "motherboardVendor": "Apple", "motherboardProduct": "", "motherboardSerial": "",
                "biosVendor": "Apple", "biosVersion": "", "biosDate": "",
                "cpuBrand": "Apple M3 Pro", "cpuSocket": "SoC", "cpuPhysicalCores": 12, "cpuLogicalCores": 12,
                "cpuBaseMhz": 3200, "cpuMaxMhz": 4050, "cpuL2Kb": 16384, "cpuL3Kb": 0, "cpuVirtualization": true,
                "totalRamGb": 18.0, "ramSlotsTotal": 1, "ramMaxCapacityGb": 18.0,
                "ramChannelMode": "Unified / Integrated Memory",
                "ramModules": [], "gpus": [{"name": "Apple M3 Pro", "vendor": "Apple", "vramMb": 18432, "driverVersion": "", "driverDate": "", "pnpDeviceId": "", "isDiscrete": false}],
                "disks": [], "volumes": [], "displays": [], "networkAdapters": [], "peripherals": [],
                "isGamingCapable": true, "isElevated": false, "uptimeSeconds": 100
            }"#,
        )
        .unwrap();
        apple_specs.ram_modules.clear();

        let cmp_apple = compare_userbenchmark(&UserBenchmarkInput {
            ram_bandwidth_gb_s: Some(17.0),
            specs: Some(apple_specs),
            ..Default::default()
        });
        let apple_ram = cmp_apple.ram.expect("Apple Silicon RAM rating should exist");
        assert_eq!(apple_ram.detected_model, "Unified Memory (Apple Silicon)");
        assert!(
            !apple_ram
                .bottleneck_flag
                .as_deref()
                .unwrap_or("")
                .contains("Single-Channel"),
            "Apple Silicon Unified Memory must NOT be flagged Single-Channel: {:?}",
            apple_ram.bottleneck_flag
        );
        assert!(!cmp_apple.recommendations.iter().any(|r| r.contains("Dual-Channel")));

        // 2. Soldered LPDDR5 @ 24.0 GB/s
        let lpddr5 = rate_ram_component(
            "LPDDR5-6400",
            Some(24.0),
            Some(75.0),
            Some("On-Board / Soldered"),
            false,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(!lpddr5
            .bottleneck_flag
            .as_deref()
            .unwrap_or("")
            .contains("Single-Channel"));

        // 3. Explicit Dual-Channel DDR5 @ 25.0 GB/s
        let dual_ddr5 = rate_ram_component(
            "DDR5-4800",
            Some(25.0),
            Some(80.0),
            Some("Dual-Channel Matched (2x DIMM)"),
            false,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(!dual_ddr5
            .bottleneck_flag
            .as_deref()
            .unwrap_or("")
            .contains("Single-Channel"));
    }

    #[test]
    fn test_trademark_normalization_and_no_apple_m_collisions() {
        // Windows WMI (R)/(TM) GPU strings
        let iris_xe = lookup_mobile_gpu_class("Intel(R) Iris(R) Xe Graphics");
        assert_eq!(iris_xe.expected_ub_pct, 21.0);

        let arc_igpu = lookup_mobile_gpu_class("Intel(R) Arc(TM) Graphics");
        assert_eq!(arc_igpu.expected_ub_pct, 32.0);

        let arc_a370m = lookup_mobile_gpu_class("Intel(R) Arc(TM) A370M Graphics");
        assert_eq!(arc_a370m.expected_ub_pct, 36.0);

        // Non-Apple GPUs with m1..m4 tokens must NOT match Apple Silicon
        for non_apple_gpu in [
            "NVIDIA Quadro M1000M",
            "NVIDIA Quadro M2000M",
            "NVIDIA Quadro M4000M",
            "AMD Radeon R7 M445",
            "AMD Radeon R9 M375",
        ] {
            let cls = lookup_mobile_gpu_class(non_apple_gpu);
            assert!(
                !cls.label.contains("Apple"),
                "{} collided with Apple GPU class: {}",
                non_apple_gpu,
                cls.label
            );
        }

        // Non-Apple Core m3 CPU must NOT match Apple M3
        let core_m3 = lookup_mobile_cpu_class("Intel(R) Core(TM) m3-8100Y CPU @ 1.10GHz", 2, 4);
        assert!(!core_m3.label.contains("Apple"), "Got {}", core_m3.label);
        assert!(core_m3.expected_ub_pct < 55.0);

        // Apple Ultra tiers ordered >= Max
        let m3_ultra = lookup_mobile_cpu_class("Apple M3 Ultra", 24, 24);
        let m3_max = lookup_mobile_cpu_class("Apple M3 Max", 16, 16);
        assert!(m3_ultra.expected_ub_pct >= m3_max.expected_ub_pct);
        assert!(m3_ultra.label.contains("Ultra"));

        // Intel 13th Gen U-series & 12th Gen HX
        let i7_1365u = lookup_mobile_cpu_class("13th Gen Intel(R) Core(TM) i7-1365U", 10, 12);
        assert!(i7_1365u.label.contains("Thin-and-Light"));
        let i7_12700hx = lookup_mobile_cpu_class("12th Gen Intel(R) Core(TM) i7-12700HX", 16, 24);
        assert!(i7_12700hx.label.contains("HX"));
        assert!(i7_12700hx.expected_ub_pct > 90.0);
    }

    #[test]
    fn test_nan_inf_negative_inputs_rejected_cleanly() {
        let ssd_nan = compare_userbenchmark(&UserBenchmarkInput {
            ssd_seq_read_mb_s: Some(f64::NAN),
            ..Default::default()
        });
        assert!(ssd_nan.ssd.is_none());

        let ssd_inf = compare_userbenchmark(&UserBenchmarkInput {
            ssd_seq_read_mb_s: Some(f64::INFINITY),
            ..Default::default()
        });
        assert!(ssd_inf.ssd.is_none());

        let ssd_neg_with_model = compare_userbenchmark(&UserBenchmarkInput {
            ssd_model: Some("Samsung 980 PRO 1TB".into()),
            ssd_seq_read_mb_s: Some(-100.0),
            ..Default::default()
        });
        assert!(ssd_neg_with_model.ssd.is_none());

        let gpu_nan = compare_userbenchmark(&UserBenchmarkInput {
            gpu_name: Some("NVIDIA GeForce RTX 4060 Laptop GPU".into()),
            gpu_avg_fps: Some(f64::NAN),
            ..Default::default()
        });
        assert!(gpu_nan.gpu.is_none());

        let gpu_neg = compare_userbenchmark(&UserBenchmarkInput {
            gpu_name: Some("NVIDIA GeForce RTX 4060 Laptop GPU".into()),
            gpu_avg_fps: Some(-20.0),
            ..Default::default()
        });
        assert!(gpu_neg.gpu.is_none());

        let ram_nan = compare_userbenchmark(&UserBenchmarkInput {
            ram_bandwidth_gb_s: Some(f64::NAN),
            ..Default::default()
        });
        assert!(ram_nan.ram.is_none());
    }

    #[test]
    fn test_critical_hardware_fault_caps_overall_tier_and_partial_serde() {
        let cmp = compare_userbenchmark(&UserBenchmarkInput {
            cpu_brand: "Intel Core i9-14900HX".into(),
            cpu_composite: Some(19000),
            gpu_name: Some("NVIDIA GeForce RTX 4080 Laptop GPU".into()),
            gpu_avg_fps: Some(135.0),
            gpu_resolution: Some("720p".into()),
            ssd_model: Some("Samsung 990 PRO".into()),
            ssd_integrity_errors: 2,
            ..Default::default()
        });
        assert_eq!(cmp.overall_vehicle_tier, "Raft");
        assert!(cmp.headline_summary.contains("CRITICAL HARDWARE FAULT"));

        // Struct-level #[serde(default)] allows partial JSON deserialization
        let _: UserBenchmarkComponentRating = serde_json::from_str("{}").unwrap();
        let _: UserBenchmarkComparison = serde_json::from_str("{}").unwrap();
        let _: crate::types::BatteryDischargeProgress = serde_json::from_str("{}").unwrap();
        let _: crate::types::BatteryDischargeResult = serde_json::from_str("{}").unwrap();
        let _: crate::types::NetworkDiagnosticsReport = serde_json::from_str("{}").unwrap();
    }

    #[test]
    fn test_legacy_and_turing_mobile_gpu_anchors_940mx_2070_2080() {
        let g940 = rate_gpu_component(
            "NVIDIA GeForce 940MX",
            "720p",
            Some(16.0),
            Some(4.0),
            false,
            OFFLINE_MODE,
        )
        .unwrap();
        assert_eq!(g940.expected_class_pct, 14.0);
        assert_eq!(g940.standing_label, "As Expected");
        assert!(g940.sub_metrics.iter().any(|(_, v)| v.contains("940MX")));

        let c2080_sup = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2080 Super");
        let c2080 = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2080");
        let c2080_mq = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2080 with Max-Q Design");
        let c2070_sup = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2070 Super");
        let c2070 = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2070");
        let c2070_mq = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2070 with Max-Q Design");
        let c2060 = lookup_mobile_gpu_class("NVIDIA GeForce RTX 2060");
        let c940 = lookup_mobile_gpu_class("NVIDIA GeForce 940MX");
        let cuhd = lookup_mobile_gpu_class("Intel(R) UHD Graphics 620");

        assert_eq!(vehicle_tier_from_pct(c2080_sup.expected_ub_pct), "Nuclear Submarine");
        assert_eq!(vehicle_tier_from_pct(c2080.expected_ub_pct), "Aircraft Carrier");
        assert_eq!(vehicle_tier_from_pct(c2080_mq.expected_ub_pct), "Battleship");
        assert_eq!(vehicle_tier_from_pct(c2070_sup.expected_ub_pct), "Battleship");
        assert_eq!(vehicle_tier_from_pct(c2070.expected_ub_pct), "Cruiser");
        assert_eq!(vehicle_tier_from_pct(c2070_mq.expected_ub_pct), "Destroyer");

        assert!(
            c2080_sup.expected_ub_pct > c2080.expected_ub_pct
                && c2080.expected_ub_pct > c2080_mq.expected_ub_pct
        );
        assert!(
            c2070_sup.expected_ub_pct > c2070.expected_ub_pct
                && c2070.expected_ub_pct > c2070_mq.expected_ub_pct
                && c2070_mq.expected_ub_pct > c2060.expected_ub_pct
                && c2060.expected_ub_pct > c940.expected_ub_pct
                && c940.expected_ub_pct > cuhd.expected_ub_pct
        );

        // Verify token boundary helper does not match substrings like "20700" or "m1000m"
        assert!(contains_ascii_token("nvidia geforce rtx 2070", "2070"));
        assert!(!contains_ascii_token("nvidia rtx 20700", "2070"));
        assert!(!contains_ascii_token("nvidia quadro m1000m", "m1"));
        assert!(contains_ascii_token("nvidia geforce rtx 2080 with max-q design", "max-q"));
    }

    #[test]
    fn test_mx150_mx130_rtx2070_super_maxq_rx640_and_external_usb_ssd() {
        let mx150_a = lookup_mobile_gpu_class("GeForce MX150");
        let mx150_b = lookup_mobile_gpu_class("NVIDIA GeForce MX150");
        let mx130 = lookup_mobile_gpu_class("NVIDIA GeForce MX130");
        let mx110 = lookup_mobile_gpu_class("NVIDIA GeForce MX110");
        let g940 = lookup_mobile_gpu_class("GeForce 940MX");
        let uhd = lookup_mobile_gpu_class("Intel(R) UHD Graphics 620");

        assert_eq!(mx150_a.expected_ub_pct, 22.0);
        assert_eq!(mx150_b.expected_ub_pct, 22.0);
        assert_eq!(mx130.expected_ub_pct, 18.0);
        assert_eq!(mx110.expected_ub_pct, 18.0);
        assert_eq!(g940.expected_ub_pct, 14.0);
        assert!(
            mx150_b.expected_ub_pct > mx130.expected_ub_pct
                && mx130.expected_ub_pct > g940.expected_ub_pct
                && g940.expected_ub_pct > uhd.expected_ub_pct
        );

        let r2070_sup_mq = lookup_mobile_gpu_class("RTX 2070 Super with Max-Q Design");
        assert_eq!(r2070_sup_mq.expected_ub_pct, 60.0);

        let rx640 = lookup_mobile_gpu_class("AMD Radeon RX 640");
        assert_eq!(rx640.label, "Integrated AMD Radeon Graphics");
        assert_eq!(rx640.expected_ub_pct, 17.0);

        let fast_usb_ssd = rate_ssd_component(
            "USB NVMe Enclosure",
            "USB",
            "External hard disk media",
            Some(950.0),
            Some(850.0),
            None,
            None,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(!fast_usb_ssd.plain_summary.contains("Mechanical HDD"));

        let slow_usb_hdd = rate_ssd_component(
            "USB External Drive",
            "USB",
            "External hard disk media",
            Some(110.0),
            Some(90.0),
            None,
            None,
            0,
            OFFLINE_MODE,
        )
        .unwrap();
        assert!(slow_usb_hdd.plain_summary.contains("Mechanical HDD"));
    }
}
