import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Bluetooth, CheckCircle2, Headphones, Plane, PlugZap, RefreshCw, Square, Sun, Usb, Volume2, Waves, Wifi, XCircle } from "lucide-react";
import type { HardwareControlsReport, NetworkDiagnosticsReport, PortsSpeakerSignoff, TestStatus, UsbDeviceInfo, UsbHotplugEvent } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface PortsSpeakersViewProps {
  status: TestStatus;
  signoff: PortsSpeakerSignoff;
  networkReport?: NetworkDiagnosticsReport | null;
  onRunNetworkDiagnostics?: () => Promise<NetworkDiagnosticsReport | null>;
  stepNumber: number;
  totalSteps: number;
  onUpdateSignoff: (signoff: PortsSpeakerSignoff) => void;
  onVerdict: (status: TestStatus, summary: string) => void;
  onFinish: () => void;
  onSkip: () => void;
}

const PORT_ITEMS = [
  "USB-A Ports (Data & Power)",
  "USB-C / Thunderbolt Ports",
  "HDMI / DisplayPort External Output",
  "DC / USB-C Charging Port",
  "3.5mm Headphone / Combo Audio Jack",
  "SD Card Reader / Ethernet LAN (if equipped)",
];

function formatMbps(mbps: number): string {
  if (mbps >= 1000) {
    const gbps = mbps / 1000;
    return Number.isInteger(gbps) ? `${gbps} Gbps` : `${gbps.toFixed(1)} Gbps`;
  }
  return `${mbps} Mbps`;
}

function classifyUsbTier(d: UsbDeviceInfo): "usb4" | "usb32" | "usb30" | "usb20" {
  const mbps = d.negotiatedMbps ?? 0;
  const ctrl = (d.controllerType ?? "").toLowerCase();
  const spd = (d.speedClass ?? "").toLowerCase();
  if (mbps >= 40000 || /usb4|thunderbolt/.test(ctrl) || /usb4|40\s*gbps/.test(spd)) return "usb4";
  if (mbps >= 10000 || /3\.2|10\s*gbps|20\s*gbps/.test(spd)) return "usb32";
  if (mbps >= 5000 || d.isSuperspeed || /3\.0|3\.x|5\s*gbps|superspeed/.test(spd)) return "usb30";
  return "usb20";
}

function freqBandLabel(hz: number): string {
  if (hz < 250) return "Sub-Bass / Bass (80–250 Hz)";
  if (hz < 2000) return "Midrange (250–2k Hz)";
  return "Treble (2k–12k Hz)";
}

export const PortsSpeakersView: React.FC<PortsSpeakersViewProps> = ({
  status,
  signoff,
  networkReport = null,
  onRunNetworkDiagnostics,
  stepNumber,
  totalSteps,
  onUpdateSignoff,
  onVerdict,
  onFinish,
  onSkip,
}) => {
  const [checkedPorts, setCheckedPorts] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (signoff.portsNotes) {
      for (const item of PORT_ITEMS) {
        if (signoff.portsNotes.includes(item)) initial.add(item);
      }
    }
    return initial;
  });
  const [usbMonitoring, setUsbMonitoring] = useState(true);
  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [usbLog, setUsbLog] = useState<Array<{ ts: string; kind: string; name: string; speed: string; ss: boolean }>>([]);
  const [netRunning, setNetRunning] = useState(false);
  const [hwControls, setHwControls] = useState<HardwareControlsReport | null>(null);
  const [hwLoading, setHwLoading] = useState(false);

  const loadHardwareControls = async () => {
    setHwLoading(true);
    try {
      const rep = await invoke<HardwareControlsReport>("get_hardware_controls_status");
      setHwControls(rep);
    } catch {
      // Ignore outside Tauri or transient failure
    } finally {
      setHwLoading(false);
    }
  };

  useEffect(() => {
    loadHardwareControls();
  }, []);

  const quickSetBrightness = async (pct: number) => {
    try {
      await invoke<number>("set_display_brightness", { percent: pct });
      await loadHardwareControls();
    } catch {
      // Ignore if external monitor / unsupported
    }
  };

  // Ref-managed AudioContext speaker diagnostics
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioTimerRef = useRef<number | null>(null);
  const freqPollRef = useRef<number | null>(null);
  const [activeAudioLabel, setActiveAudioLabel] = useState<string | null>(null);
  const [liveFreqHz, setLiveFreqHz] = useState<number | null>(null);
  const [testedSpeakerModes, setTestedSpeakerModes] = useState<Set<string>>(new Set());

  const stopAudio = () => {
    if (audioTimerRef.current !== null) {
      window.clearTimeout(audioTimerRef.current);
      audioTimerRef.current = null;
    }
    if (freqPollRef.current !== null) {
      window.clearInterval(freqPollRef.current);
      freqPollRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setActiveAudioLabel(null);
    setLiveFreqHz(null);
  };

  useEffect(() => {
    return () => stopAudio();
  }, []);

  const triggerSpeakerMode = (
    modeKey: string,
    label: string,
    opts: {
      channel: "left" | "right" | "both" | "alternate";
      freqStart: number;
      freqEnd?: number;
      durationSec: number;
    }
  ) => {
    stopAudio();
    setTestedSpeakerModes((prev) => new Set(prev).add(modeKey));
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();

      osc.type = "sine";
      const startTime = ctx.currentTime;
      const endTime = startTime + opts.durationSec;

      if (opts.channel === "alternate") {
        panner.pan.setValueAtTime(-1, startTime);
        panner.pan.linearRampToValueAtTime(1, startTime + opts.durationSec * 0.5);
        panner.pan.linearRampToValueAtTime(-1, endTime);
      } else {
        panner.pan.setValueAtTime(
          opts.channel === "left" ? -1 : opts.channel === "right" ? 1 : 0,
          startTime
        );
      }

      osc.frequency.setValueAtTime(opts.freqStart, startTime);
      if (opts.freqEnd && opts.freqEnd !== opts.freqStart) {
        osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, endTime);
      }

      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.28, startTime + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, endTime);

      osc.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);

      setActiveAudioLabel(label);
      setLiveFreqHz(Math.round(opts.freqStart));

      if (opts.freqEnd && opts.freqEnd !== opts.freqStart) {
        const t0 = performance.now();
        const durMs = opts.durationSec * 1000;
        const ratio = opts.freqEnd / opts.freqStart;
        freqPollRef.current = window.setInterval(() => {
          const frac = Math.min(1, (performance.now() - t0) / durMs);
          setLiveFreqHz(Math.round(opts.freqStart * Math.pow(ratio, frac)));
        }, 60);
      }

      osc.start(startTime);
      osc.stop(endTime + 0.05);
      audioTimerRef.current = window.setTimeout(() => {
        stopAudio();
      }, Math.round(opts.durationSec * 1000) + 120);
    } catch {
      setActiveAudioLabel(null);
      setLiveFreqHz(null);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (usbMonitoring) {
      invoke("start_usb_monitor").catch(() => {});
      listen<UsbHotplugEvent>("usb:event", (ev) => {
        const p = ev.payload;
        setUsbDevices(p.devices);
        if (p.eventKind !== "SNAPSHOT" && p.device) {
          setUsbLog((prev) => [
            {
              ts: p.timestamp,
              kind: p.eventKind,
              name: p.device!.name,
              speed: p.device!.speedClass,
              ss: p.device!.isSuperspeed,
            },
            ...prev.slice(0, 14),
          ]);
        }
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
      if (usbMonitoring) invoke("stop_usb_monitor").catch(() => {});
    };
  }, [usbMonitoring]);

  const togglePort = (item: string) => {
    setCheckedPorts((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      onUpdateSignoff({
        ...signoff,
        portsChecked: next.size > 0,
        portsNotes: Array.from(next).join(", "),
      });
      return next;
    });
  };

  const handleRetestNetwork = async () => {
    if (!onRunNetworkDiagnostics) return;
    setNetRunning(true);
    try {
      await onRunNetworkDiagnostics();
    } finally {
      setNetRunning(false);
    }
  };

  const faultyUsb = usbDevices.filter(
    (d) => d.status.toUpperCase() !== "OK" || (d.errorCode ?? 0) !== 0
  );
  const usb4Count = usbDevices.filter((d) => classifyUsbTier(d) === "usb4").length;
  const usb32Count = usbDevices.filter((d) => classifyUsbTier(d) === "usb32").length;
  const usb30Count = usbDevices.filter((d) => classifyUsbTier(d) === "usb30").length;
  const usb20Count = usbDevices.filter((d) => classifyUsbTier(d) === "usb20").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              Live USB4/3.x Speed Detector, Physical Ports &amp; Speakers
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Inspects USB4 / USB 3.2 / 3.0 / 2.0 controller speeds &amp; error codes, tests L/R/Alternate &amp; 80 Hz–12 kHz speaker sweep, and checks physical I/O ports.
          </p>
        </div>
      </div>

      {/* Optional Network Status Chip */}
      {(networkReport || onRunNetworkDiagnostics) && (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-4 py-2.5 flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2.5 flex-wrap">
            <Wifi className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="font-mono text-[10.5px] font-bold uppercase text-black">
              Wireless &amp; Network Readiness:
            </span>
            {networkReport ? (
              <>
                <StatusBadge status={networkReport.status} compact />
                <span className="font-mono text-[11px] font-bold text-black">
                  {networkReport.verdict}
                </span>
                <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                  {networkReport.interfaceName} •{" "}
                  {networkReport.linkSpeedMbps != null ? `${networkReport.linkSpeedMbps} Mbps` : "—"} • Ping{" "}
                  {networkReport.gatewayPingMs != null ? `${networkReport.gatewayPingMs.toFixed(1)}ms` : "—"} • Loss{" "}
                  {networkReport.packetLossPct.toFixed(0)}%
                </span>
                <span className="text-[11px] text-zinc-700">{networkReport.plainSummary}</span>
              </>
            ) : (
              <span className="font-mono text-[11px] text-zinc-500">Network probe not run yet.</span>
            )}
          </div>
          {onRunNetworkDiagnostics && (
            <button
              onClick={handleRetestNetwork}
              disabled={netRunning}
              className="px-2.5 py-1 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${netRunning ? "animate-spin text-blue-600" : ""}`} />
              {netRunning ? "Testing..." : "Re-test Network"}
            </button>
          )}
        </div>
      )}

      {/* Faulty USB Controller Alert Banner */}
      {faultyUsb.length > 0 && (
        <div className="rounded-[2px] border-2 border-black bg-black text-white p-3.5 space-y-1.5">
          <div className="font-mono text-xs font-bold uppercase flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
            FAULTY USB CONTROLLER / PORT DEVICE ALERT ({faultyUsb.length} DEVICE{faultyUsb.length > 1 ? "S" : ""})
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            {faultyUsb.map((d) => (
              <div key={d.instanceId}>
                <strong className="text-white">{d.name}</strong> — Status: {d.status}
                {d.errorCode != null ? ` (Code ${d.errorCode})` : ""}
                {d.reliabilityNote ? ` • ${d.reliabilityNote}` : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Radios, Brightness & Headphone Jack Hardware Matrix */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="font-mono text-xs font-black uppercase text-black flex items-center gap-1.5">
              <Bluetooth className="w-4 h-4 text-blue-600" />
              Live Brightness, Radios (Wi-Fi / Bluetooth / Airplane Mode) &amp; 3.5mm Headphone Jack
            </div>
            <div className="text-[11px] text-zinc-600">
              Toggle brightness, Wi-Fi, Bluetooth, Airplane Mode hotkey, or plug in 3.5mm headphones, then click Refresh to verify live hardware response.
            </div>
          </div>
          <button
            type="button"
            onClick={loadHardwareControls}
            disabled={hwLoading}
            className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${hwLoading ? "animate-spin text-blue-600" : ""}`} />
            {hwLoading ? "Checking..." : "Refresh Hardware States"}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
          {/* Display Brightness */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Sun className="w-3.5 h-3.5 text-blue-600" /> Display Brightness
              </span>
              <StatusBadge status={hwControls?.displayBrightness?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black tabular-nums">
              {hwControls?.displayBrightness?.currentPct != null
                ? `${hwControls.displayBrightness.currentPct}%`
                : "Manual Fn"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.displayBrightness?.detail || "Probing screen backlight..."}
            </div>
            {hwControls?.displayBrightness?.canSet && (
              <div className="flex gap-1.5 pt-1">
                {[30, 70, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => quickSetBrightness(p)}
                    className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black font-mono text-[10px] font-bold text-black cursor-pointer"
                  >
                    Set {p}%
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Keyboard Backlight Brightness */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Sun className="w-3.5 h-3.5 text-blue-600" /> Keyboard Backlight
              </span>
              <StatusBadge status={hwControls?.keyboardBacklight?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black tabular-nums">
              {hwControls?.keyboardBacklight?.supported === true
                ? hwControls.keyboardBacklight.currentPct != null
                  ? `Equipped (${hwControls.keyboardBacklight.currentPct}%)`
                  : "Equipped (Fn Keys)"
                : hwControls?.keyboardBacklight?.supported === false
                ? "Not Equipped (N/A)"
                : "Verify via Fn Key"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.keyboardBacklight?.detail || "Check keyboard illumination levels using Fn backlight hotkey."}
            </div>
          </div>

          {/* Wi-Fi Radio */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-blue-600" /> Wi-Fi Radio
              </span>
              <StatusBadge status={hwControls?.wifi?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black">
              {hwControls?.wifi?.enabled === true
                ? "RADIO ON"
                : hwControls?.wifi?.present
                ? "RADIO OFF"
                : "NOT DETECTED"}
            </div>
            <div className="text-[10.5px] text-zinc-700 font-medium truncate">
              {hwControls?.wifi?.adapterName || "—"} • {hwControls?.wifi?.connectionDetail || "—"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.wifi?.detail || "Probing wireless adapter..."}
            </div>
          </div>

          {/* Bluetooth Radio */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Bluetooth className="w-3.5 h-3.5 text-blue-600" /> Bluetooth Radio
              </span>
              <StatusBadge status={hwControls?.bluetooth?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black">
              {hwControls?.bluetooth?.enabled === true
                ? "RADIO ON"
                : hwControls?.bluetooth?.present
                ? "RADIO OFF"
                : "NOT DETECTED"}
            </div>
            <div className="text-[10.5px] text-zinc-700 font-medium truncate">
              {hwControls?.bluetooth?.adapterName || "—"} • {hwControls?.bluetooth?.connectionDetail || "—"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.bluetooth?.detail || "Probing Bluetooth radio..."}
            </div>
          </div>

          {/* Airplane Mode */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Plane className="w-3.5 h-3.5 text-blue-600" /> Airplane Mode
              </span>
              <StatusBadge status={hwControls?.airplaneMode?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black">
              {hwControls?.airplaneMode?.active === true
                ? "AIRPLANE MODE ON"
                : hwControls?.airplaneMode?.active === false
                ? "OFF (Radios Active)"
                : "UNKNOWN"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.airplaneMode?.detail || "Probing system radio switch..."}
            </div>
          </div>

          {/* Headphone / 3.5mm Audio Jack */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase text-black flex items-center gap-1.5">
                <Headphones className="w-3.5 h-3.5 text-blue-600" /> 3.5mm Headphone Jack
              </span>
              <StatusBadge status={hwControls?.headphoneJack?.status ?? "pending"} compact />
            </div>
            <div className="font-mono text-sm font-black text-black">
              {hwControls?.headphoneJack?.pluggedIn ? "HEADPHONES PLUGGED IN" : "NOT PLUGGED IN"}
            </div>
            <div className="text-[10.5px] text-zinc-700 font-medium truncate">
              Output: {hwControls?.headphoneJack?.activeOutputName || "—"}
            </div>
            <div className="text-[10.5px] text-zinc-600">
              {hwControls?.headphoneJack?.detail || "Plug 3.5mm headphones & click Refresh, then play L/R tone."}
            </div>
            <div className="flex gap-1.5 pt-1">
              <button
                type="button"
                onClick={() =>
                  triggerSpeakerMode("hp_lr", "Headphone L ↔ R Check", {
                    channel: "alternate",
                    freqStart: 440,
                    durationSec: 2.0,
                  })
                }
                className="px-2 py-0.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[10px] font-bold uppercase cursor-pointer"
              >
                Test Headphone L ↔ R
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Live USB Hot-Plug Speed Detector */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="font-mono text-xs font-black uppercase text-black flex items-center gap-1.5">
              <Usb className="w-4 h-4 text-blue-600" />
              Live USB Hot-Plug &amp; Negotiated Controller Speed Monitor
            </div>
            <div className="text-[11px] text-zinc-600">
              Detects plug/unplug events live — if a USB 3.x drive drops to USB 2.0 (480 Mbps), that port has damaged SuperSpeed pins.
            </div>
          </div>
          <button
            onClick={() => setUsbMonitoring((m) => !m)}
            className={`px-3 py-1.5 rounded-[2px] font-mono text-[11px] font-bold uppercase cursor-pointer ${
              usbMonitoring ? "bg-blue-600 text-white" : "border border-black bg-white text-black"
            }`}
          >
            {usbMonitoring ? "Live USB Detector: ON" : "Start USB Detector"}
          </button>
        </div>

        {/* USB4 / USB 3.2 / 3.0 / 2.0 Bus-Tier Count Pills */}
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] tabular-nums">
          <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black font-bold">
            USB4 / TB4 (40G): <strong className="text-blue-700">{usb4Count}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black font-bold">
            USB 3.2 (10–20G): <strong className="text-blue-700">{usb32Count}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black font-bold">
            USB 3.0 (5G): <strong className="text-blue-700">{usb30Count}</strong>
          </span>
          <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black font-bold">
            USB 2.0 (480M): <strong>{usb20Count}</strong>
          </span>
          <span
            className={`px-2 py-0.5 rounded-[2px] border font-bold ${
              faultyUsb.length > 0
                ? "bg-black text-white border-black"
                : "border-zinc-300 bg-white text-zinc-700"
            }`}
          >
            Controller Faults: {faultyUsb.length}
          </span>
        </div>

        {usbLog.length > 0 && (
          <div className="border border-zinc-300 divide-y divide-zinc-200 font-mono text-[11px]">
            {usbLog.map((e, idx) => (
              <div key={idx} className="px-3 py-1.5 flex items-center justify-between gap-2 bg-[#F8FAFC]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-zinc-500">{e.ts}</span>
                  <span
                    className={`px-1.5 py-0.5 text-[9.5px] font-bold ${
                      e.kind === "CONNECTED" ? "bg-blue-600 text-white" : "bg-black text-white"
                    }`}
                  >
                    {e.kind}
                  </span>
                  <span className="font-sans font-bold text-black truncate">{e.name}</span>
                </div>
                <span className={`shrink-0 font-bold ${e.ss ? "text-blue-700" : "text-zinc-600"}`}>
                  {e.speed}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="max-h-48 overflow-y-auto border border-zinc-200">
          <table className="w-full text-left border-collapse text-[11px] font-mono">
            <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-[9.5px] uppercase text-zinc-500">
              <tr>
                <th className="py-1.5 px-3">Connected USB Device / Controller</th>
                <th className="py-1.5 px-3">Controller</th>
                <th className="py-1.5 px-3">Negotiated Speed</th>
                <th className="py-1.5 px-3 text-right">State / Err</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {usbDevices.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 px-3 text-zinc-500 text-center">
                    Plug any USB flash drive or peripheral into a port to test live speed negotiation...
                  </td>
                </tr>
              ) : (
                usbDevices.map((d) => {
                  const isFault = d.status.toUpperCase() !== "OK" || (d.errorCode ?? 0) !== 0;
                  return (
                    <tr key={d.instanceId} className={isFault ? "bg-zinc-100" : ""}>
                      <td className="py-1.5 px-3">
                        <div className="font-sans font-semibold text-black">{d.name}</div>
                        {d.reliabilityNote && (
                          <div className="text-[10px] text-zinc-600 font-sans mt-0.5">{d.reliabilityNote}</div>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-zinc-700">{d.controllerType || "—"}</td>
                      <td className={`py-1.5 px-3 font-bold ${d.isSuperspeed ? "text-blue-700" : "text-zinc-700"}`}>
                        {d.negotiatedMbps != null ? `${formatMbps(d.negotiatedMbps)} (${d.speedClass})` : d.speedClass}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-bold ${isFault ? "text-black underline" : "text-zinc-600"}`}>
                        {d.errorCode != null && d.errorCode !== 0 ? `${d.status} (Code ${d.errorCode})` : d.status}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Speakers */}
        <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-xs font-black uppercase text-black">
              <Volume2 className="w-4 h-4 text-blue-600" />
              Speaker Channel &amp; Full Frequency Sweep
            </div>
            <span className="font-mono text-[10px] font-bold text-zinc-600">
              {testedSpeakerModes.size} checks run
            </span>
          </div>
          <p className="text-[11px] text-zinc-600">
            Verify Left/Right channel isolation, L ↔ R panning, Bass/Mid/Treble clarity, and the 80 Hz → 12 kHz sweep to catch blown or rattling speakers.
          </p>

          {activeAudioLabel && (
            <div className="rounded-[2px] border border-blue-600 bg-blue-50/40 px-3 py-2 flex items-center justify-between gap-2 font-mono text-[11px]">
              <div>
                <span className="font-bold text-blue-700">{activeAudioLabel}</span>
                {liveFreqHz != null && (
                  <span className="text-black ml-2 tabular-nums">
                    {liveFreqHz} Hz • {freqBandLabel(liveFreqHz)}
                  </span>
                )}
              </div>
              <button
                onClick={stopAudio}
                className="px-2 py-0.5 rounded-[2px] bg-black text-white text-[10px] font-bold uppercase flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-2.5 h-2.5" /> Stop Audio
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() =>
                triggerSpeakerMode("left", "Left Channel (440 Hz)", {
                  channel: "left",
                  freqStart: 440,
                  durationSec: 0.9,
                })
              }
              className="py-2 px-3 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Left (440 Hz)
            </button>
            <button
              onClick={() =>
                triggerSpeakerMode("right", "Right Channel (587 Hz)", {
                  channel: "right",
                  freqStart: 587.33,
                  durationSec: 0.9,
                })
              }
              className="py-2 px-3 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Right (587 Hz)
            </button>
            <button
              onClick={() =>
                triggerSpeakerMode("stereo", "Balanced Stereo (523 Hz)", {
                  channel: "both",
                  freqStart: 523.25,
                  durationSec: 0.9,
                })
              }
              className="py-2 px-3 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Balanced Stereo
            </button>
            <button
              onClick={() =>
                triggerSpeakerMode("alternate", "L ↔ R Alternate Pan", {
                  channel: "alternate",
                  freqStart: 523.25,
                  durationSec: 2.4,
                })
              }
              className="py-2 px-3 rounded-[2px] border border-blue-600 bg-white hover:bg-blue-50/40 text-blue-700 font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              L ↔ R Alternate
            </button>
          </div>

          <button
            onClick={() =>
              triggerSpeakerMode("sweep", "Full Frequency Sweep (80 Hz → 12 kHz)", {
                channel: "both",
                freqStart: 80,
                freqEnd: 12000,
                durationSec: 4.0,
              })
            }
            className="w-full py-2 px-3 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-[11px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Waves className="w-3.5 h-3.5 text-blue-400" />
            Full Frequency Sweep (80 Hz → 12 kHz • 4.0s)
          </button>

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() =>
                triggerSpeakerMode("bass", "Bass Check (100 Hz)", {
                  channel: "both",
                  freqStart: 100,
                  durationSec: 1.0,
                })
              }
              className="py-1.5 px-2 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] hover:border-black text-black font-mono text-[10.5px] font-bold uppercase cursor-pointer"
            >
              Bass (100 Hz)
            </button>
            <button
              onClick={() =>
                triggerSpeakerMode("mid", "Mid Check (1 kHz)", {
                  channel: "both",
                  freqStart: 1000,
                  durationSec: 1.0,
                })
              }
              className="py-1.5 px-2 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] hover:border-black text-black font-mono text-[10.5px] font-bold uppercase cursor-pointer"
            >
              Mid (1 kHz)
            </button>
            <button
              onClick={() =>
                triggerSpeakerMode("treble", "Treble Check (8 kHz)", {
                  channel: "both",
                  freqStart: 8000,
                  durationSec: 1.0,
                })
              }
              className="py-1.5 px-2 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] hover:border-black text-black font-mono text-[10.5px] font-bold uppercase cursor-pointer"
            >
              Treble (8 kHz)
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs font-bold text-black pt-2 border-t border-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={signoff.speakersChecked}
              onChange={(e) => onUpdateSignoff({ ...signoff, speakersChecked: e.target.checked })}
              className="w-4 h-4 accent-blue-600"
            />
            Speakers verified clear (Left, Right, Volume &amp; No Distortion)
          </label>
          <input
            type="text"
            value={signoff.speakersNotes}
            onChange={(e) => onUpdateSignoff({ ...signoff, speakersNotes: e.target.value })}
            placeholder="Optional speaker notes..."
            className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-1.5 text-xs text-black"
          />
        </div>

        {/* Ports Checklist */}
        <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
          <div className="flex items-center gap-2 font-mono text-xs font-black uppercase text-black">
            <PlugZap className="w-4 h-4 text-blue-600" />
            Physical I/O Ports Verification
          </div>
          <div className="space-y-1.5">
            {PORT_ITEMS.map((item) => {
              const checked = checkedPorts.has(item);
              return (
                <label
                  key={item}
                  className={`flex items-center gap-2.5 px-3 py-1.5 rounded-[2px] border text-xs font-medium cursor-pointer transition ${
                    checked
                      ? "bg-blue-50/40 border-blue-600 text-black font-bold"
                      : "bg-[#F8FAFC] border-zinc-300 text-zinc-700 hover:border-black"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePort(item)}
                    className="w-3.5 h-3.5 accent-blue-600"
                  />
                  {item}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Plain-Language Reliability Summary (Collapsible Technical Details) */}
      <TechnicalDetailsDrawer
        title="Technical Details — Port, USB & Audio Reliability Notes"
        subtitle={`${checkedPorts.size}/${PORT_ITEMS.length} port groups • ${faultyUsb.length} USB faults`}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-[11px]">
          <div className="rounded-[2px] border border-zinc-200 bg-white p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">USB Controller &amp; Port Health</div>
            <div className="text-zinc-600 mt-0.5">
              {faultyUsb.length > 0
                ? `${faultyUsb.length} USB device/controller fault(s) flagged — inspect physical ports for bent pins or motherboard controller issues.`
                : `${usb4Count + usb32Count + usb30Count} high-speed USB4/3.x and ${usb20Count} USB 2.0 entries detected with 0 controller error codes.`}
            </div>
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-white p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Speaker &amp; Port Signoff</div>
            <div className="text-zinc-600 mt-0.5">
              {checkedPorts.size}/{PORT_ITEMS.length} physical I/O groups checked; {testedSpeakerModes.size} speaker band/channel diagnostic(s) triggered.
            </div>
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-white p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Network Readiness</div>
            <div className="text-zinc-600 mt-0.5">
              {networkReport
                ? networkReport.plainSummary
                : "Run network diagnostics in Stage 01 or click Re-test Network above to confirm Wi-Fi/LAN stability."}
            </div>
          </div>
        </div>
      </TechnicalDetailsDrawer>

      {/* Verdict */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-600">
          Confirm Ports &amp; Speakers verdict to issue the Swiss Lab Calibration Certificate.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              onUpdateSignoff({
                ...signoff,
                portsChecked: true,
                portsNotes: signoff.portsNotes || Array.from(checkedPorts).join(", "),
                speakersChecked: true,
              });
              onVerdict(
                "pass",
                `Ports (${checkedPorts.size || PORT_ITEMS.length} groups, ${usbLog.filter((l) => l.kind === "CONNECTED").length} hot-plug verified, ${faultyUsb.length} USB faults) & Stereo Speakers (${testedSpeakerModes.size} audio checks) clear.`
              );
            }}
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Pass Ports &amp; Speakers
          </button>
          <button
            onClick={() => onVerdict("fail", `Physical port or speaker defect noted (${faultyUsb.length} USB controller faults).`)}
            className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" /> Fail Ports / Speakers
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        nextLabel="Issue QC Certificate"
        requirementHint="Confirm Ports & Speakers verdict to unlock the Swiss Lab Certificate (or click Skip Step)."
        onNext={onFinish}
        onSkip={onSkip}
      />
    </div>
  );
};
