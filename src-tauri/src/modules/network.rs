use crate::types::{NetworkDiagnosticsReport, TestStatus};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

#[allow(dead_code)]
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct NetshWlanInfo {
    pub interface_name: Option<String>,
    pub connected: bool,
    pub ssid: Option<String>,
    pub signal_pct: Option<u32>,
    pub rssi_dbm: Option<i32>,
    pub rx_rate_mbps: Option<f64>,
    pub tx_rate_mbps: Option<f64>,
    pub radio_type: Option<String>,
    pub channel: Option<u32>,
    pub band: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct MacosWifiInfo {
    pub ssid: Option<String>,
    pub rssi_dbm: Option<i32>,
    pub signal_pct: Option<u32>,
    pub link_speed_mbps: Option<f64>,
    pub channel: Option<u32>,
    pub band: Option<String>,
}

/// Infers Wi-Fi frequency band ("2.4 GHz" | "5 GHz" | "6 GHz") from explicit band, channel number, or radio type.
pub fn infer_wifi_band(
    channel: Option<u32>,
    radio_type: Option<&str>,
    explicit_band: Option<&str>,
) -> Option<String> {
    if let Some(b) = explicit_band {
        let low = b.to_lowercase();
        if low.contains("6") && !low.contains("2.4") && !low.contains("5") {
            return Some("6 GHz".to_string());
        }
        if low.contains("5") {
            return Some("5 GHz".to_string());
        }
        if low.contains("2.4") {
            return Some("2.4 GHz".to_string());
        }
    }
    if let Some(ch) = channel {
        if (1..=14).contains(&ch) {
            return Some("2.4 GHz".to_string());
        } else if (32..=177).contains(&ch) {
            return Some("5 GHz".to_string());
        } else if ch > 177 {
            return Some("6 GHz".to_string());
        }
    }
    if let Some(rt) = radio_type {
        let low = rt.to_lowercase();
        if low.contains("802.11ac") || low.contains("802.11a") {
            return Some("5 GHz".to_string());
        }
        if low.contains("802.11b") || low.contains("802.11g") {
            return Some("2.4 GHz".to_string());
        }
    }
    None
}

/// Computes `(avg_ms, jitter_stddev_ms, max_spike_ms, packet_loss_pct)` from a multi-packet ping burst.
pub fn compute_ping_burst_stats(
    rtts_ms: &[f64],
    total_sent: u32,
) -> (Option<f64>, Option<f64>, Option<f64>, f64) {
    let sent = total_sent.max(rtts_ms.len() as u32);
    if sent == 0 {
        return (None, None, None, 0.0);
    }
    let received = rtts_ms.len() as u32;
    let loss_pct = ((((sent.saturating_sub(received)) as f64) / (sent as f64)) * 100.0 * 10.0)
        .round()
        / 10.0;
    if rtts_ms.is_empty() {
        return (None, None, None, 100.0);
    }
    let avg = rtts_ms.iter().sum::<f64>() / (rtts_ms.len() as f64);
    let max_spike = rtts_ms.iter().copied().fold(0.0f64, f64::max);
    let var = rtts_ms
        .iter()
        .map(|v| {
            let d = v - avg;
            d * d
        })
        .sum::<f64>()
        / (rtts_ms.len() as f64);
    let jitter = var.sqrt();
    (
        Some((avg * 10.0).round() / 10.0),
        Some((jitter * 10.0).round() / 10.0),
        Some((max_spike * 10.0).round() / 10.0),
        loss_pct,
    )
}

/// Extracts per-reply RTT values (in ms) from standard Windows or macOS `ping` output.
pub fn extract_ping_reply_rtts(output: &str) -> Vec<f64> {
    let mut rtts = Vec::new();
    for line in output.lines() {
        let low = line.to_lowercase();
        if !low.contains("ttl=") && !low.contains("icmp_seq=") {
            continue;
        }
        if low.contains("<1ms") || low.contains("<1 ms") {
            rtts.push(0.5);
            continue;
        }
        for marker in ["time=", "zeit=", "temps=", "tiempo="] {
            if let Some(pos) = low.find(marker) {
                let after = &line[pos + marker.len()..];
                if let Some(val) = parse_first_f64(after) {
                    rtts.push(val);
                    break;
                }
            }
        }
    }
    rtts
}

/// Enriches a base `NetworkDiagnosticsReport` with v3.0.0 Wi-Fi Band/Channel & 15-packet Jitter/Spike telemetry.
pub fn enrich_network_v3(
    mut rep: NetworkDiagnosticsReport,
    wifi_band: Option<String>,
    wifi_channel: Option<u32>,
    radio_type: Option<&str>,
    jitter_ms: Option<f64>,
    max_spike_ms: Option<f64>,
    samples_count: u32,
) -> NetworkDiagnosticsReport {
    let resolved_band = infer_wifi_band(wifi_channel, radio_type, wifi_band.as_deref());
    let mut band_warning: Option<String> = None;
    if resolved_band.as_deref() == Some("2.4 GHz") {
        let rt_low = radio_type.unwrap_or("").to_lowercase();
        let modern_card = rt_low.contains("ac")
            || rt_low.contains("ax")
            || rt_low.contains("be")
            || rep.interface_name.to_lowercase().contains("wi-fi 6")
            || rep.interface_name.to_lowercase().contains("ax")
            || rep.interface_name.to_lowercase().contains("ac");
        if modern_card || rep.wifi_ssid.is_some() {
            band_warning = Some(
                "Connected on 2.4 GHz band — verify 5 GHz / 6 GHz reception (disconnected internal 5 GHz antenna coax often forces laptops onto 2.4 GHz)."
                    .to_string(),
            );
        }
    }

    let high_jitter = jitter_ms.map(|j| j > 25.0).unwrap_or(false);
    let high_spike = max_spike_ms.map(|s| s > 100.0).unwrap_or(false);

    if (high_jitter || high_spike) && rep.verdict == "HEALTHY" {
        rep.status = TestStatus::Warn;
        rep.verdict = "DEGRADED".to_string();
        rep.plain_summary = format!(
            "DEGRADED link stability on {}: high ping jitter/spikes (jitter {:.1} ms, max spike {:.1} ms across {} packets) — inspect Wi-Fi antenna or router interference.",
            rep.interface_name,
            jitter_ms.unwrap_or(0.0),
            max_spike_ms.unwrap_or(0.0),
            samples_count
        );
    } else if let Some(ref b) = resolved_band {
        if rep.verdict == "HEALTHY" {
            let ch_part = wifi_channel.map(|c| format!(" Ch {}", c)).unwrap_or_default();
            let jit_part = jitter_ms
                .map(|j| format!(", jitter {:.1} ms", j))
                .unwrap_or_default();
            rep.plain_summary = format!(
                "{} [Band: {}{}{}]",
                rep.plain_summary, b, ch_part, jit_part
            );
        }
    }

    rep.wifi_band = resolved_band;
    rep.wifi_channel = wifi_channel;
    rep.ping_jitter_ms = jitter_ms;
    rep.ping_max_spike_ms = max_spike_ms;
    rep.ping_samples_count = samples_count;
    rep.band_warning = band_warning;
    rep
}

pub fn run_network_diagnostics() -> Result<NetworkDiagnosticsReport, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(run_windows_network_diagnostics())
    }
    #[cfg(target_os = "macos")]
    {
        Ok(run_macos_network_diagnostics())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(NetworkDiagnosticsReport {
            status: TestStatus::NotApplicable,
            interface_name: "N/A".to_string(),
            link_speed_mbps: None,
            wifi_ssid: None,
            wifi_signal_pct: None,
            rssi_dbm: None,
            gateway_ping_ms: None,
            dns_resolve_ok: false,
            packet_loss_pct: 0.0,
            verdict: "NOT_APPLICABLE".to_string(),
            plain_summary: "Network diagnostics not supported on this operating system.".to_string(),
            ..Default::default()
        })
    }
}

#[allow(dead_code)]
pub(crate) fn is_valid_ping_target(addr: &str) -> bool {
    let trimmed = addr.trim();
    if trimmed.is_empty() {
        return false;
    }
    match trimmed.parse::<IpAddr>() {
        Ok(ip) => !ip.is_unspecified(),
        Err(_) => false,
    }
}

#[allow(dead_code)]
fn check_dns_resolution() -> bool {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let ok = ("dns.google", 443)
            .to_socket_addrs()
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
            || ("one.one.one.one", 443)
                .to_socket_addrs()
                .map(|mut it| it.next().is_some())
                .unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

#[allow(dead_code)]
pub(crate) fn parse_netsh_wlan(output: &str) -> NetshWlanInfo {
    fn finalize(mut block: NetshWlanInfo) -> NetshWlanInfo {
        if !block.connected {
            block.ssid = None;
            block.signal_pct = None;
            block.rssi_dbm = None;
            block.rx_rate_mbps = None;
            block.tx_rate_mbps = None;
        }
        block
    }

    let mut blocks: Vec<NetshWlanInfo> = Vec::new();
    let mut current: Option<NetshWlanInfo> = None;

    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            if let Some(block) = current.take() {
                blocks.push(finalize(block));
            }
            continue;
        }
        let Some((k, v)) = t.split_once(':') else {
            continue;
        };
        let key = k.trim().to_lowercase();
        let val = v.trim();
        if key == "name" && !val.is_empty() {
            if let Some(block) = current.take() {
                blocks.push(finalize(block));
            }
            current = Some(NetshWlanInfo {
                interface_name: Some(val.to_string()),
                ..Default::default()
            });
            continue;
        }

        let block = current.get_or_insert_with(NetshWlanInfo::default);
        if key == "state" {
            let vl = val.to_lowercase();
            block.connected = vl == "connected" || vl.starts_with("connected");
        } else if key == "ssid" && !val.is_empty() {
            block.ssid = Some(val.to_string());
        } else if key == "signal" {
            let digits: String = val.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(pct) = digits.parse::<u32>() {
                let clamped = pct.min(100);
                block.signal_pct = Some(clamped);
                block.rssi_dbm = Some((clamped as i32 / 2) - 100);
            }
        } else if key.starts_with("receive rate") {
            if let Some(mbps) = parse_first_f64(val) {
                block.rx_rate_mbps = Some(mbps);
            }
        } else if key.starts_with("transmit rate") {
            if let Some(mbps) = parse_first_f64(val) {
                block.tx_rate_mbps = Some(mbps);
            }
        } else if key == "radio type" && !val.is_empty() {
            block.radio_type = Some(val.to_string());
        } else if key == "channel" && !val.is_empty() {
            let digits: String = val.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(ch) = digits.parse::<u32>() {
                block.channel = Some(ch);
            }
        } else if key == "band" && !val.is_empty() {
            block.band = Some(val.to_string());
        }
    }

    if let Some(block) = current.take() {
        blocks.push(finalize(block));
    }

    blocks
        .iter()
        .find(|b| b.connected)
        .cloned()
        .or_else(|| blocks.into_iter().next())
        .unwrap_or_default()
}

#[allow(dead_code)]
pub(crate) fn parse_link_speed_mbps(link_speed: &str, rx_bps: f64) -> Option<f64> {
    if rx_bps.is_finite() && rx_bps > 0.0 {
        return Some(((rx_bps / 1_000_000.0) * 10.0).round() / 10.0);
    }
    let trimmed = link_speed.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val = parse_first_f64(trimmed)?;
    let low = trimmed.to_lowercase();
    if low.contains("gbps") || low.contains("gb/s") {
        Some((val * 1000.0 * 10.0).round() / 10.0)
    } else if low.contains("kbps") {
        Some(((val / 1000.0) * 10.0).round() / 10.0)
    } else {
        Some((val * 10.0).round() / 10.0)
    }
}

#[allow(dead_code)]
pub(crate) fn parse_windows_ping(output: &str) -> (Option<f64>, f64) {
    let mut loss_pct: Option<f64> = None;
    let mut avg_ms: Option<f64> = None;
    let mut has_ttl_reply = false;

    for line in output.lines() {
        let low = line.to_lowercase();
        if low.contains("ttl=") {
            has_ttl_reply = true;
        }

        if line.contains('(') && line.contains('%') {
            let mut rest = line;
            while let Some(open_paren) = rest.find('(') {
                let after_open = &rest[open_paren + 1..];
                if let Some(close_paren) = after_open.find(')') {
                    let inside = &after_open[..close_paren];
                    if let Some(pct_idx) = inside.find('%') {
                        let num_str: String = inside[..pct_idx]
                            .chars()
                            .filter(|c| c.is_ascii_digit() || *c == '.')
                            .collect();
                        if !num_str.is_empty() {
                            if let Ok(p) = num_str.parse::<f64>() {
                                loss_pct = Some(p.clamp(0.0, 100.0));
                            }
                        }
                    }
                    rest = &after_open[close_paren + 1..];
                } else {
                    break;
                }
            }
        }

        if !low.contains("ttl=")
            && low.contains("ms")
            && (line.matches('=').count() >= 2 || low.contains("average"))
        {
            if let Some(eq_pos) = line.rfind('=') {
                let after = &line[eq_pos + 1..];
                let after_l = after.to_lowercase();
                if after_l.contains("<1ms")
                    || after_l.contains("< 1ms")
                    || after_l.contains("<1 ms")
                    || after_l.contains("< 1 ms")
                {
                    avg_ms = Some(0.5);
                } else if let Some(v) = parse_first_f64(after) {
                    avg_ms = Some(v);
                }
            }
        }
    }

    let final_loss = loss_pct.unwrap_or(if has_ttl_reply { 0.0 } else { 100.0 });
    (avg_ms, final_loss)
}

#[allow(dead_code)]
pub(crate) fn parse_macos_route_default(output: &str) -> (Option<String>, Option<String>) {
    let mut iface: Option<String> = None;
    let mut gateway: Option<String> = None;
    for line in output.lines() {
        let t = line.trim();
        if let Some((k, v)) = t.split_once(':') {
            let key = k.trim().to_lowercase();
            let val = v.trim();
            if key == "interface" && !val.is_empty() {
                iface = Some(val.to_string());
            } else if key == "gateway" && !val.is_empty() {
                gateway = Some(val.to_string());
            }
        }
    }
    (iface, gateway)
}

#[allow(dead_code)]
pub(crate) fn parse_macos_airport(output: &str) -> MacosWifiInfo {
    let mut info = MacosWifiInfo::default();
    for line in output.lines() {
        let t = line.trim();
        let Some((k, v)) = t.split_once(':') else {
            continue;
        };
        let key = k.trim();
        let val = v.trim();
        match key {
            "SSID" if !val.is_empty() => info.ssid = Some(val.to_string()),
            "agrCtlRSSI" => {
                if let Ok(rssi) = val.parse::<i32>() {
                    if rssi != 0 {
                        info.rssi_dbm = Some(rssi);
                        info.signal_pct = Some((((rssi + 100) * 2).clamp(0, 100)) as u32);
                    }
                }
            }
            "lastTxRate" => {
                if let Ok(rate) = val.parse::<f64>() {
                    if rate > 0.0 {
                        info.link_speed_mbps = Some(rate);
                    }
                }
            }
            _ => {}
        }
    }
    info
}

#[allow(dead_code)]
pub(crate) fn parse_macos_sp_airport(json_raw: &str) -> MacosWifiInfo {
    use serde_json::Value;
    let mut info = MacosWifiInfo::default();
    let Ok(v) = serde_json::from_str::<Value>(json_raw) else {
        return info;
    };
    let Some(arr) = v["SPAirPortDataType"].as_array() else {
        return info;
    };
    for ap in arr {
        let Some(ifaces) = ap["spairport_airport_interfaces"].as_array() else {
            continue;
        };
        for iface in ifaces {
            let cur = &iface["spairport_current_network_information"];
            if cur.is_object() {
                if let Some(ssid) = cur["_name"].as_str().filter(|s| !s.trim().is_empty()) {
                    info.ssid = Some(ssid.trim().to_string());
                }
                if let Some(sig_noise) = cur["spairport_signal_noise"].as_str() {
                    if let Some(rssi) = parse_signed_i32(sig_noise) {
                        info.rssi_dbm = Some(rssi);
                        info.signal_pct = Some((((rssi + 100) * 2).clamp(0, 100)) as u32);
                    }
                }
                if let Some(rate) = cur["spairport_network_rate"].as_f64().filter(|&r| r > 0.0) {
                    info.link_speed_mbps = Some(rate);
                } else if let Some(rate_str) = cur["spairport_network_rate"].as_str() {
                    if let Some(rate) = parse_first_f64(rate_str) {
                        info.link_speed_mbps = Some(rate);
                    }
                }
                if info.ssid.is_some() || info.rssi_dbm.is_some() {
                    return info;
                }
            }
        }
    }
    info
}

#[allow(dead_code)]
pub(crate) fn parse_macos_ifconfig_speed(output: &str) -> Option<f64> {
    let low = output.to_lowercase();
    if low.contains("10gbase") {
        Some(10_000.0)
    } else if low.contains("5000base") {
        Some(5_000.0)
    } else if low.contains("2500base") {
        Some(2_500.0)
    } else if low.contains("1000base") {
        Some(1_000.0)
    } else if low.contains("100base") {
        Some(100.0)
    } else if low.contains("10base") {
        Some(10.0)
    } else {
        None
    }
}

#[allow(dead_code)]
pub(crate) fn parse_macos_ping(output: &str) -> (Option<f64>, f64) {
    let mut loss_pct: Option<f64> = None;
    let mut avg_ms: Option<f64> = None;

    for line in output.lines() {
        let low = line.to_lowercase();
        if low.contains("packet loss") {
            if let Some(pct_idx) = low.find('%') {
                let prefix = &low[..pct_idx];
                let num_token = prefix.split_whitespace().last().unwrap_or("");
                if let Ok(p) = num_token.parse::<f64>() {
                    loss_pct = Some(p.clamp(0.0, 100.0));
                }
            }
        } else if (low.contains("round-trip") || low.contains("rtt")) && line.contains('=') {
            if let Some((_, rhs)) = line.split_once('=') {
                let nums: Vec<&str> = rhs.trim().split('/').collect();
                if nums.len() >= 2 {
                    if let Ok(avg) = nums[1].trim().parse::<f64>() {
                        avg_ms = Some((avg * 10.0).round() / 10.0);
                    }
                }
            }
        }
    }

    (avg_ms, loss_pct.unwrap_or(100.0))
}

pub fn classify_network_report(
    interface_name: String,
    link_speed_mbps: Option<f64>,
    wifi_ssid: Option<String>,
    wifi_signal_pct: Option<u32>,
    rssi_dbm: Option<i32>,
    gateway_ping_ms: Option<f64>,
    dns_resolve_ok: bool,
    packet_loss_pct: f64,
) -> NetworkDiagnosticsReport {
    let clean_iface = interface_name.trim().to_string();
    let iface_missing =
        clean_iface.is_empty() || clean_iface.eq_ignore_ascii_case("disconnected");

    let (status, verdict, plain_summary) = if iface_missing {
        (
            TestStatus::Warn,
            "NO_ACTIVE_LINK".to_string(),
            "No active Wi-Fi or Ethernet link detected. Connect to a router or hotspot to verify network speed and stability.".to_string(),
        )
    } else if packet_loss_pct >= 25.0
        || wifi_signal_pct.map(|p| p < 25).unwrap_or(false)
        || rssi_dbm.map(|r| r < -82).unwrap_or(false)
    {
        let reason = if packet_loss_pct >= 25.0 {
            format!("severe gateway packet loss ({:.0}%)", packet_loss_pct)
        } else {
            format!(
                "very weak Wi-Fi signal ({}% / {} dBm — check internal M.2 Wi-Fi antenna coax cables)",
                wifi_signal_pct.unwrap_or(0),
                rssi_dbm.unwrap_or(-85)
            )
        };
        (
            TestStatus::Fail,
            "POOR_LINK".to_string(),
            format!(
                "POOR LINK on {}: {} — unstable connectivity for daily use.",
                clean_iface, reason
            ),
        )
    } else if packet_loss_pct > 0.0
        || gateway_ping_ms.map(|ms| ms > 50.0).unwrap_or(false)
        || wifi_signal_pct.map(|p| p < 45).unwrap_or(false)
        || rssi_dbm.map(|r| r < -75).unwrap_or(false)
    {
        let mut issues = Vec::new();
        if packet_loss_pct > 0.0 {
            issues.push(format!("{:.0}% packet loss", packet_loss_pct));
        }
        if let Some(ms) = gateway_ping_ms.filter(|&m| m > 50.0) {
            issues.push(format!("elevated gateway latency ({:.1} ms)", ms));
        }
        if wifi_signal_pct.map(|p| p < 45).unwrap_or(false)
            || rssi_dbm.map(|r| r < -75).unwrap_or(false)
        {
            issues.push(format!(
                "weak Wi-Fi signal ({}% / {} dBm — inspect internal antenna leads if close to router)",
                wifi_signal_pct.unwrap_or(0),
                rssi_dbm.unwrap_or(-80)
            ));
        }
        (
            TestStatus::Warn,
            "DEGRADED".to_string(),
            format!(
                "DEGRADED link on {}: {}.",
                clean_iface,
                issues.join("; ")
            ),
        )
    } else if !dns_resolve_ok {
        (
            TestStatus::Warn,
            "LOCAL_ONLY_NO_DNS".to_string(),
            format!(
                "Local link on {} is healthy{} (0% packet loss), but external DNS resolution failed — normal on offline shop benches, otherwise check router internet.",
                clean_iface,
                gateway_ping_ms
                    .map(|ms| format!(" ({:.1} ms gateway)", ms))
                    .unwrap_or_default()
            ),
        )
    } else {
        let speed_txt = link_speed_mbps
            .map(|s| format!(" at {:.0} Mbps", s))
            .unwrap_or_default();
        let wifi_txt = match (&wifi_ssid, wifi_signal_pct) {
            (Some(ssid), Some(pct)) => format!(" (Wi-Fi '{}' {}%)", ssid, pct),
            (Some(ssid), None) => format!(" (Wi-Fi '{}')", ssid),
            _ => String::new(),
        };
        let ping_txt = gateway_ping_ms
            .map(|ms| format!(", gateway {:.1} ms", ms))
            .unwrap_or_default();
        (
            TestStatus::Pass,
            "HEALTHY".to_string(),
            format!(
                "HEALTHY: {} connected{}{}{} with 0% packet loss and DNS OK.",
                clean_iface, speed_txt, wifi_txt, ping_txt
            ),
        )
    };

    NetworkDiagnosticsReport {
        status,
        interface_name: if clean_iface.is_empty() {
            "Disconnected".to_string()
        } else {
            clean_iface
        },
        link_speed_mbps,
        wifi_ssid,
        wifi_signal_pct,
        rssi_dbm,
        gateway_ping_ms,
        dns_resolve_ok,
        packet_loss_pct,
        verdict,
        plain_summary,
        ..Default::default()
    }
}

fn parse_first_f64(s: &str) -> Option<f64> {
    let mut started = false;
    let mut buf = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() || (ch == '.' && started && !buf.contains('.')) {
            started = true;
            buf.push(ch);
        } else if started {
            break;
        }
    }
    buf.parse::<f64>().ok().filter(|v| v.is_finite())
}

#[allow(dead_code)]
fn parse_signed_i32(s: &str) -> Option<i32> {
    let mut started = false;
    let mut buf = String::new();
    for ch in s.chars() {
        if (ch == '-' && !started) || ch.is_ascii_digit() {
            started = true;
            buf.push(ch);
        } else if started {
            break;
        }
    }
    buf.parse::<i32>().ok()
}

#[cfg(target_os = "windows")]
fn run_windows_icmp_burst(gateway: &str, count: u32) -> Option<(Option<f64>, Option<f64>, Option<f64>, f64, u32)> {
    use std::ffi::c_void;
    use std::net::Ipv4Addr;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

    let ipv4: Ipv4Addr = gateway.trim().parse().ok()?;
    let dest_addr: u32 = u32::from_ne_bytes(ipv4.octets());

    #[repr(C)]
    struct IcmpEchoReply {
        address: u32,
        status: u32,
        round_trip_time: u32,
        data_size: u16,
        reserved: u16,
        data: *mut c_void,
        ttl: u8,
        tos: u8,
        flags: u8,
        options_size: u8,
        options_data: *mut u8,
        _pad: [u8; 64],
    }

    type IcmpCreateFileFn = unsafe extern "system" fn() -> *mut c_void;
    type IcmpCloseHandleFn = unsafe extern "system" fn(*mut c_void) -> i32;
    type IcmpSendEchoFn = unsafe extern "system" fn(
        *mut c_void,
        u32,
        *const c_void,
        u16,
        *const c_void,
        *mut c_void,
        u32,
        u32,
    ) -> u32;

    let hmod = unsafe { LoadLibraryA(b"iphlpapi.dll\0".as_ptr()) };
    if hmod.is_null() {
        return None;
    }
    let create_p = unsafe { GetProcAddress(hmod, b"IcmpCreateFile\0".as_ptr()) }?;
    let close_p = unsafe { GetProcAddress(hmod, b"IcmpCloseHandle\0".as_ptr()) }?;
    let send_p = unsafe { GetProcAddress(hmod, b"IcmpSendEcho\0".as_ptr()) }?;
    let icmp_create: IcmpCreateFileFn = unsafe { std::mem::transmute(create_p) };
    let icmp_close: IcmpCloseHandleFn = unsafe { std::mem::transmute(close_p) };
    let icmp_send: IcmpSendEchoFn = unsafe { std::mem::transmute(send_p) };

    let handle = unsafe { icmp_create() };
    if handle.is_null() || handle == (-1isize) as *mut c_void {
        return None;
    }

    let payload = [0x4Cu8; 32];
    let mut reply_buf = vec![0u8; std::mem::size_of::<IcmpEchoReply>() + 64];
    let mut rtts: Vec<f64> = Vec::with_capacity(count as usize);

    for i in 0..count {
        let ret = unsafe {
            icmp_send(
                handle,
                dest_addr,
                payload.as_ptr().cast::<c_void>(),
                payload.len() as u16,
                std::ptr::null(),
                reply_buf.as_mut_ptr().cast::<c_void>(),
                reply_buf.len() as u32,
                800,
            )
        };
        if ret > 0 {
            let reply = unsafe { &*(reply_buf.as_ptr().cast::<IcmpEchoReply>()) };
            if reply.status == 0 {
                let rtt = if reply.round_trip_time == 0 {
                    0.5
                } else {
                    reply.round_trip_time as f64
                };
                rtts.push(rtt);
            }
        }
        if i + 1 < count {
            std::thread::sleep(Duration::from_millis(90));
        }
    }

    unsafe {
        icmp_close(handle);
    }

    let (avg, jitter, max_spike, loss) = compute_ping_burst_stats(&rtts, count);
    Some((avg, jitter, max_spike, loss, count))
}

#[cfg(target_os = "windows")]
fn run_windows_network_diagnostics() -> NetworkDiagnosticsReport {
    use crate::cmd_util::{run_cmd_stdout, run_powershell};
    use serde_json::Value;

    let wlan = run_cmd_stdout("netsh", &["wlan", "show", "interfaces"])
        .map(|out| parse_netsh_wlan(&out))
        .unwrap_or_default();

    let ps = r#"
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
$iface = if ($route) {
    Get-NetAdapter -InterfaceIndex $route.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
    Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
}
@{
    ifaceName = if ($iface) { [string]$iface.Name } elseif ($route) { [string]$route.InterfaceAlias } else { '' }
    ifaceDesc = if ($iface) { [string]$iface.InterfaceDescription } else { '' }
    linkSpeed = if ($iface) { [string]$iface.LinkSpeed } else { '' }
    rxBps = if ($iface) { [double]$iface.ReceiveLinkSpeed } else { 0 }
    gateway = if ($route) { [string]$route.NextHop } else { '' }
} | ConvertTo-Json -Compress
"#;

    let mut iface_name = String::new();
    let mut link_speed_mbps: Option<f64> = None;
    let mut gateway = String::new();

    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            iface_name = v["ifaceName"].as_str().unwrap_or("").trim().to_string();
            let desc = v["ifaceDesc"].as_str().unwrap_or("").trim();
            if !desc.is_empty() && !iface_name.is_empty() && !desc.eq_ignore_ascii_case(&iface_name) {
                iface_name = format!("{} ({})", iface_name, desc);
            }
            let rx_bps = v["rxBps"].as_f64().unwrap_or(0.0);
            let ls_str = v["linkSpeed"].as_str().unwrap_or("");
            link_speed_mbps = parse_link_speed_mbps(ls_str, rx_bps);
            gateway = v["gateway"].as_str().unwrap_or("").trim().to_string();
        }
    }

    if iface_name.is_empty() && wlan.connected {
        iface_name = wlan
            .interface_name
            .clone()
            .unwrap_or_else(|| "Wi-Fi".to_string());
    }
    if link_speed_mbps.is_none() {
        link_speed_mbps = wlan.rx_rate_mbps.or(wlan.tx_rate_mbps);
    }

    let (gateway_ping_ms, ping_jitter_ms, ping_max_spike_ms, packet_loss_pct, ping_samples) =
        if is_valid_ping_target(&gateway) {
            if let Some(burst) = run_windows_icmp_burst(&gateway, 15) {
                burst
            } else {
                run_cmd_stdout("ping", &["-n", "6", "-w", "1200", &gateway])
                    .map(|out| {
                        let (avg, loss) = parse_windows_ping(&out);
                        let rtts = extract_ping_reply_rtts(&out);
                        let (_, jit, spk, _) = compute_ping_burst_stats(&rtts, 6);
                        (avg, jit, spk, loss, 6)
                    })
                    .unwrap_or((None, None, None, 100.0, 6))
            }
        } else if iface_name.is_empty() {
            (None, None, None, 100.0, 0)
        } else {
            (None, None, None, 0.0, 0)
        };

    let dns_resolve_ok = if iface_name.is_empty() {
        false
    } else {
        check_dns_resolution()
    };

    let base = classify_network_report(
        iface_name,
        link_speed_mbps,
        wlan.ssid,
        wlan.signal_pct,
        wlan.rssi_dbm,
        gateway_ping_ms,
        dns_resolve_ok,
        packet_loss_pct,
    );
    enrich_network_v3(
        base,
        wlan.band,
        wlan.channel,
        wlan.radio_type.as_deref(),
        ping_jitter_ms,
        ping_max_spike_ms,
        ping_samples,
    )
}

#[cfg(target_os = "macos")]
fn run_macos_network_diagnostics() -> NetworkDiagnosticsReport {
    use crate::cmd_util::run_cmd_stdout;

    let (iface_opt, gw_opt) = run_cmd_stdout("route", &["-n", "get", "default"])
        .map(|out| parse_macos_route_default(&out))
        .unwrap_or((None, None));

    let iface_name = iface_opt.unwrap_or_default();
    let mut wifi = run_cmd_stdout(
        "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
        &["-I"],
    )
    .map(|out| parse_macos_airport(&out))
    .unwrap_or_default();

    if wifi.ssid.is_none() && wifi.rssi_dbm.is_none() {
        if let Ok(sp_json) = run_cmd_stdout("system_profiler", &["-json", "SPAirPortDataType"]) {
            let sp_wifi = parse_macos_sp_airport(&sp_json);
            if sp_wifi.ssid.is_some() || sp_wifi.rssi_dbm.is_some() {
                wifi = sp_wifi;
            }
        }
    }

    let mut link_speed_mbps = wifi.link_speed_mbps;
    if link_speed_mbps.is_none() && !iface_name.is_empty() {
        if let Ok(if_out) = run_cmd_stdout("ifconfig", &[&iface_name]) {
            link_speed_mbps = parse_macos_ifconfig_speed(&if_out);
        }
    }

    let (gateway_ping_ms, ping_jitter_ms, ping_max_spike_ms, packet_loss_pct, ping_samples) =
        match gw_opt.as_deref() {
            Some(gw) if is_valid_ping_target(gw) => {
                run_cmd_stdout("ping", &["-c", "15", "-i", "0.2", "-W", "1000", gw])
                    .map(|out| {
                        let (avg, loss) = parse_macos_ping(&out);
                        let rtts = extract_ping_reply_rtts(&out);
                        let (b_avg, jit, spk, _) = compute_ping_burst_stats(&rtts, 15);
                        (avg.or(b_avg), jit, spk, loss, 15)
                    })
                    .unwrap_or((None, None, None, 100.0, 15))
            }
            _ if iface_name.is_empty() => (None, None, None, 100.0, 0),
            _ => (None, None, None, 0.0, 0),
        };

    let dns_resolve_ok = if iface_name.is_empty() {
        false
    } else {
        check_dns_resolution()
    };

    let base = classify_network_report(
        iface_name,
        link_speed_mbps,
        wifi.ssid,
        wifi.signal_pct,
        wifi.rssi_dbm,
        gateway_ping_ms,
        dns_resolve_ok,
        packet_loss_pct,
    );
    enrich_network_v3(
        base,
        wifi.band,
        wifi.channel,
        None,
        ping_jitter_ms,
        ping_max_spike_ms,
        ping_samples,
    )
}

#[cfg(test)]
mod v3_network_tests {
    use super::*;

    #[test]
    fn test_wifi_band_inference_and_15_packet_jitter_v300() {
        assert_eq!(infer_wifi_band(Some(6), None, None).as_deref(), Some("2.4 GHz"));
        assert_eq!(infer_wifi_band(Some(36), None, None).as_deref(), Some("5 GHz"));
        assert_eq!(infer_wifi_band(Some(149), None, None).as_deref(), Some("5 GHz"));
        assert_eq!(infer_wifi_band(None, None, Some("6 GHz")).as_deref(), Some("6 GHz"));

        let rtts = vec![2.0, 2.5, 3.0, 2.2, 120.0, 2.4, 2.1, 2.3, 2.5, 2.2, 2.0, 2.1, 2.4, 2.3, 2.2];
        let (avg, jit, spk, loss) = compute_ping_burst_stats(&rtts, 15);
        assert!(avg.unwrap() > 5.0);
        assert!(jit.unwrap() > 25.0);
        assert_eq!(spk, Some(120.0));
        assert_eq!(loss, 0.0);

        let base = classify_network_report(
            "Wi-Fi (Intel Wi-Fi 6 AX201)".into(),
            Some(144.0),
            Some("ShopWiFi".into()),
            Some(85),
            Some(-55),
            avg,
            true,
            0.0,
        );
        let enriched = enrich_network_v3(base, None, Some(6), Some("802.11ax"), jit, spk, 15);
        assert_eq!(enriched.wifi_band.as_deref(), Some("2.4 GHz"));
        assert!(enriched.band_warning.is_some());
        assert_eq!(enriched.status, TestStatus::Warn);
        assert_eq!(enriched.verdict, "DEGRADED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_netsh_wlan_connected_and_disconnected() {
        let connected = r#"
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX211 160MHz
    GUID                   : 12345678-1234-1234-1234-1234567890ab
    Physical address       : aa:bb:cc:dd:ee:ff
    State                  : connected
    SSID                   : BenchOffice_5G
    BSSID                  : 11:22:33:44:55:66
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Authentication         : WPA2-Personal
    Cipher                 : CCMP
    Receive rate (Mbps)    : 1201
    Transmit rate (Mbps)   : 960
    Signal                 : 84%
"#;
        let info = parse_netsh_wlan(connected);
        assert!(info.connected);
        assert_eq!(info.interface_name.as_deref(), Some("Wi-Fi"));
        assert_eq!(info.ssid.as_deref(), Some("BenchOffice_5G")); // Ignores BSSID
        assert_eq!(info.signal_pct, Some(84));
        assert_eq!(info.rssi_dbm, Some(-58));
        assert_eq!(info.rx_rate_mbps, Some(1201.0));
        assert_eq!(info.radio_type.as_deref(), Some("802.11ax"));

        let disconnected = r#"
    Name                   : Wi-Fi
    State                  : disconnected
    Signal                 : 0%
"#;
        let d_info = parse_netsh_wlan(disconnected);
        assert!(!d_info.connected);
        assert_eq!(d_info.ssid, None);
        assert_eq!(d_info.signal_pct, None);
    }

    #[test]
    fn test_parse_link_speed_and_ping_target_validation() {
        assert_eq!(parse_link_speed_mbps("1.2 Gbps", 0.0), Some(1200.0));
        assert_eq!(parse_link_speed_mbps("866.7 Mbps", 0.0), Some(866.7));
        assert_eq!(parse_link_speed_mbps("", 2_500_000_000.0), Some(2500.0));

        assert!(is_valid_ping_target("192.168.1.1"));
        assert!(is_valid_ping_target("fe80::1"));
        assert!(!is_valid_ping_target("0.0.0.0"));
        assert!(!is_valid_ping_target("192.168.1.1 && calc.exe"));
        assert!(!is_valid_ping_target(""));
    }

    #[test]
    fn test_parse_windows_ping_variants() {
        let ok = r#"
Ping statistics for 192.168.1.1:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 1ms, Maximum = 4ms, Average = 2ms
"#;
        assert_eq!(parse_windows_ping(ok), (Some(2.0), 0.0));

        let sub_ms = r#"
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
    Minimum = 0ms, Maximum = 0ms, Average = <1ms
"#;
        assert_eq!(parse_windows_ping(sub_ms), (Some(0.5), 0.0));

        let loss = r#"
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
    Minimum = 10ms, Maximum = 35ms, Average = 22ms
"#;
        assert_eq!(parse_windows_ping(loss), (Some(22.0), 25.0));

        let timeout = "Request timed out.\nPackets: Sent = 4, Received = 0, Lost = 4 (100% loss),";
        assert_eq!(parse_windows_ping(timeout), (None, 100.0));
    }

    #[test]
    fn test_parse_macos_route_airport_sp_ifconfig_and_ping() {
        let route = "   route to: default\n destination: default\n       gateway: 192.168.50.1\n   interface: en0\n";
        assert_eq!(
            parse_macos_route_default(route),
            (Some("en0".to_string()), Some("192.168.50.1".to_string()))
        );

        let airport = "     agrCtlRSSI: -54\n     lastTxRate: 866\n           SSID: LabWiFi\n";
        let aw = parse_macos_airport(airport);
        assert_eq!(aw.ssid.as_deref(), Some("LabWiFi"));
        assert_eq!(aw.rssi_dbm, Some(-54));
        assert_eq!(aw.signal_pct, Some(92));
        assert_eq!(aw.link_speed_mbps, Some(866.0));

        let sp_json = r#"{
            "SPAirPortDataType": [{
                "spairport_airport_interfaces": [{
                    "_name": "en0",
                    "spairport_current_network_information": {
                        "_name": "Shop5G",
                        "spairport_signal_noise": "-62 dBm / -94 dBm",
                        "spairport_network_rate": 1200
                    }
                }]
            }]
        }"#;
        let sp = parse_macos_sp_airport(sp_json);
        assert_eq!(sp.ssid.as_deref(), Some("Shop5G"));
        assert_eq!(sp.rssi_dbm, Some(-62));
        assert_eq!(sp.signal_pct, Some(76));
        assert_eq!(sp.link_speed_mbps, Some(1200.0));

        assert_eq!(
            parse_macos_ifconfig_speed("media: autoselect (1000baseT <full-duplex>)"),
            Some(1000.0)
        );

        let mac_ping = "4 packets transmitted, 4 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 1.234/2.567/4.890/1.100 ms\n";
        assert_eq!(parse_macos_ping(mac_ping), (Some(2.6), 0.0));
    }

    #[test]
    fn test_classify_network_report_verdicts() {
        let healthy = classify_network_report(
            "Wi-Fi".into(),
            Some(866.0),
            Some("Office5G".into()),
            Some(86),
            Some(-57),
            Some(3.2),
            true,
            0.0,
        );
        assert_eq!(healthy.status, TestStatus::Pass);
        assert_eq!(healthy.verdict, "HEALTHY");

        let no_dns = classify_network_report(
            "Ethernet".into(),
            Some(1000.0),
            None,
            None,
            None,
            Some(1.0),
            false,
            0.0,
        );
        assert_eq!(no_dns.status, TestStatus::Warn);
        assert_eq!(no_dns.verdict, "LOCAL_ONLY_NO_DNS");

        let degraded = classify_network_report(
            "Wi-Fi".into(),
            Some(144.0),
            Some("Cafe".into()),
            Some(38),
            Some(-81),
            Some(18.0),
            true,
            0.0,
        );
        assert_eq!(degraded.status, TestStatus::Warn);
        assert_eq!(degraded.verdict, "DEGRADED");

        let poor = classify_network_report(
            "Wi-Fi".into(),
            Some(54.0),
            Some("WeakNet".into()),
            Some(20),
            Some(-90),
            Some(95.0),
            false,
            50.0,
        );
        assert_eq!(poor.status, TestStatus::Fail);
        assert_eq!(poor.verdict, "POOR_LINK");

        let disconnected =
            classify_network_report(String::new(), None, None, None, None, None, false, 100.0);
        assert_eq!(disconnected.status, TestStatus::Warn);
        assert_eq!(disconnected.verdict, "NO_ACTIVE_LINK");
    }

    #[test]
    fn test_parse_netsh_wlan_multi_interface_retains_connected() {
        let multi = r#"
There are 2 interfaces on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX211 160MHz
    State                  : connected
    SSID                   : Office5G
    Receive rate (Mbps)    : 1200
    Transmit rate (Mbps)   : 960
    Signal                 : 90%

    Name                   : Local Area Connection* 10
    Description            : Microsoft Wi-Fi Direct Virtual Adapter
    State                  : disconnected
    Signal                 : 0%
"#;
        let info = parse_netsh_wlan(multi);
        assert!(info.connected);
        assert_eq!(info.interface_name.as_deref(), Some("Wi-Fi"));
        assert_eq!(info.ssid.as_deref(), Some("Office5G"));
        assert_eq!(info.signal_pct, Some(90));
        assert_eq!(info.rx_rate_mbps, Some(1200.0));

        // Disconnected primary followed by connected USB Wi-Fi adapter
        let second_connected = r#"
    Name                   : Wi-Fi
    State                  : disconnected
    Signal                 : 0%

    Name                   : Wi-Fi 2
    State                  : connected
    SSID                   : BenchUSB
    Receive rate (Mbps)    : 866.7
    Signal                 : 82%
"#;
        let info2 = parse_netsh_wlan(second_connected);
        assert!(info2.connected);
        assert_eq!(info2.interface_name.as_deref(), Some("Wi-Fi 2"));
        assert_eq!(info2.ssid.as_deref(), Some("BenchUSB"));
        assert_eq!(info2.signal_pct, Some(82));
    }

    #[test]
    fn test_parse_windows_ping_non_english_locales_and_ttl_fallback() {
        let german = r#"
Ping wird ausgeführt für 192.168.1.1 mit 32 Bytes Daten:
Antwort von 192.168.1.1: Bytes=32 Zeit=2ms TTL=64

Ping-Statistik für 192.168.1.1:
    Pakete: Gesendet = 4, Empfangen = 4, Verloren = 0 (0% Verlust),
Ca. Zeitangaben in Millisek.:
    Minimum = 1ms, Maximum = 4ms, Mittelwert = 2ms
"#;
        assert_eq!(parse_windows_ping(german), (Some(2.0), 0.0));

        let french_sub_ms = r#"
Statistiques Ping pour 192.168.1.1:
    Paquets : envoyés = 4, reçus = 4, perdus = 0 (perte 0%),
Durée approximative des boucles en millisecondes :
    Minimum = 0ms, Maximum = 0ms, Moyenne = <1ms
"#;
        assert_eq!(parse_windows_ping(french_sub_ms), (Some(0.5), 0.0));

        let ttl_only = "Reply from 192.168.1.1: bytes=32 time=3ms TTL=64\n";
        assert_eq!(parse_windows_ping(ttl_only), (None, 0.0));
    }
}
