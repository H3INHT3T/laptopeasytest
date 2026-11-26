import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Bluetooth,
  CheckCircle2,
  Headphones,
  Monitor,
  Network,
  Plane,
  PlugZap,
  RefreshCw,
  Square,
  Sun,
  Usb,
  Volume2,
  Waves,
  Wifi,
  XCircle,
} from "lucide-react";
import type {
  HardwareControlsReport,
  NetworkDiagnosticsReport,
  PortDiagnosticsReport,
  PortsSpeakerSignoff,
  RemovableDriveBenchResult,
  RemovableDriveInfo,
  TestStatus,
  UsbDeviceInfo,
  UsbHotplugEvent,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface PortsSpeakersViewProps {
  status: TestStatus;
  signoff: PortsSpeakerSignoff;
  networkReport?: NetworkDiagnosticsReport | null;
  onRunNetworkDiagnostics?: () => Promise<NetworkDiagnosticsReport | null>;
  removableDriveBench?: RemovableDriveBenchResult | null;
  onRemovableBenchComplete?: (res: RemovableDriveBenchResult) => void;
  stepNumber: number;
  totalSteps: number;
  onUpdateSignoff: (signoff: PortsSpeakerSignoff) => void;
  onVerdict: (status: TestStatus, summary: string) => void;
  onFinish: () => void;
  onSkip: () => void;
}

interface AcousticAutoResult {
  status: TestStatus;
  leftDb: number;
  rightDb: number;
  balanceDiffDb: number;
  thdPct: number;
  summary: string;
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

export const PortsSpeakersView: React.FC<PortsSpeakersViewProps> = ({
  status,
  signoff,
  removableDriveBench = null,
  onRemovableBenchComplete,
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

  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [usbLog, setUsbLog] = useState<Array<{ ts: string; kind: string; name: string; speed: string }>>([]);
  const [portDiag, setPortDiag] = useState<PortDiagnosticsReport | null>(null);
  const [portLoading, setPortLoading] = useState(false);
  const [hwControls, setHwControls] = useState<HardwareControlsReport | null>(null);

  // USB-C Reversible Charger Flip Tracker (Side A -> Flip 180° -> Side B)
  const [usbCSideA, setUsbCSideA] = useState<string | null>(null);
  const [usbCSideB, setUsbCSideB] = useState<string | null>(null);

  // Auto Mic-Verified Speaker L/R & THD Analyzer
  const [acousticRunning, setAcousticRunning] = useState(false);
  const [acousticPhase, setAcousticPhase] = useState<string | null>(null);
  const [acousticResult, setAcousticResult] = useState<AcousticAutoResult | null>(null);
  const [acousticError, setAcousticError] = useState<string | null>(null);

  // USB / SD-Card Removable Drive Real Speed Test (v3.0.0)
  const [removableDrives, setRemovableDrives] = useState<RemovableDriveInfo[]>([]);
  const [selectedRemovable, setSelectedRemovable] = useState<string>("");
  const [remTesting, setRemTesting] = useState(false);
  const [remResult, setRemResult] = useState<RemovableDriveBenchResult | null>(removableDriveBench);
  const [remError, setRemError] = useState<string | null>(null);

  // Manual stereo fallback
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioTimerRef = useRef<number | null>(null);
  const [activeAudioLabel, setActiveAudioLabel] = useState<string | null>(null);

  const loadPortDiagnostics = async () => {
    setPortLoading(true);
    try {
      const [pd, hc, remList] = await Promise.all([
        invoke<PortDiagnosticsReport>("scan_port_diagnostics").catch(() => null),
        invoke<HardwareControlsReport>("get_hardware_controls_status").catch(() => null),
        invoke<RemovableDriveInfo[]>("list_removable_drives").catch(() => [] as RemovableDriveInfo[]),
      ]);
      setRemovableDrives(Array.isArray(remList) ? remList : []);
      if (Array.isArray(remList) && remList.length > 0 && !selectedRemovable) {
        setSelectedRemovable(remList[0].mountPath);
      }
      if (pd) {
        setPortDiag(pd);
        if (pd.externalDisplayCount > 0) {
          setCheckedPorts((prev) => new Set(prev).add("HDMI / DisplayPort External Output"));
        }
        if (pd.ethernet?.connected) {
          setCheckedPorts((prev) => new Set(prev).add("SD Card Reader / Ethernet LAN (if equipped)"));
        }
      }
      if (hc) {
        setHwControls(hc);
        if (hc.headphoneJack?.pluggedIn) {
          setCheckedPorts((prev) => new Set(prev).add("3.5mm Headphone / Combo Audio Jack"));
        }
      }
    } finally {
      setPortLoading(false);
    }
  };

  useEffect(() => {
    loadPortDiagnostics();
    let unlisten: (() => void) | null = null;
    listen<UsbHotplugEvent>("usb:event", (ev) => {
      const p = ev.payload;
      setUsbDevices(p.devices || []);
      if (p.eventKind !== "SNAPSHOT" && p.device) {
        setUsbLog((prev) => [
          {
            ts: p.timestamp,
            kind: p.eventKind,
            name: p.device!.name,
            speed: p.device!.negotiatedMbps ? formatMbps(p.device!.negotiatedMbps) : p.device!.speedClass,
          },
          ...prev.slice(0, 14),
        ]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    invoke("start_usb_monitor").catch(() => {});
    invoke<UsbDeviceInfo[]>("list_usb_devices")
      .then((d) => setUsbDevices(d || []))
      .catch(() => {});

    return () => {
      stopAudio();
      if (unlisten) unlisten();
      invoke("stop_usb_monitor").catch(() => {});
    };
  }, []);

  const stopAudio = () => {
    if (audioTimerRef.current !== null) {
      window.clearTimeout(audioTimerRef.current);
      audioTimerRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setActiveAudioLabel(null);
  };

  const playManualTone = (panVal: number, label: string, freqHz = 520, durMs = 1500) => {
    stopAudio();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    osc.type = "sine";
    osc.frequency.value = freqHz;
    pan.pan.value = panVal;
    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durMs / 1000);
    osc.connect(gain).connect(pan).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durMs / 1000);
    setActiveAudioLabel(label);
    audioTimerRef.current = window.setTimeout(() => stopAudio(), durMs + 100);
  };

  // Automated 3-Second Mic-Verified Left/Right + 180Hz Blown-Cone Distortion (THD) Test
  const runAutoAcousticTest = async () => {
    stopAudio();
    setAcousticError(null);
    setAcousticResult(null);
    setAcousticRunning(true);
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);

      const sampleFreqBand = async (targetHz: number, ms: number): Promise<{ fundDb: number; thdPct: number }> => {
        const bins = new Float32Array(analyser.frequencyBinCount);
        const binHz = ctx!.sampleRate / analyser.fftSize;
        const idxAt = (hz: number) => Math.max(1, Math.min(bins.length - 2, Math.round(hz / binHz)));
        const peakNear = (hz: number) => {
          const i = idxAt(hz);
          return Math.max(bins[i - 1], bins[i], bins[i + 1]);
        };
        let bestFund = -100;
        let harmonicPowerSum = 0;
        let fundPowerSum = 0;
        const steps = Math.max(4, Math.floor(ms / 80));
        for (let s = 0; s < steps; s++) {
          await new Promise((r) => setTimeout(r, 80));
          analyser.getFloatFrequencyData(bins);
          const fDb = peakNear(targetHz);
          if (fDb > bestFund) bestFund = fDb;
          const fLin = Math.pow(10, fDb / 10);
          const h2 = Math.pow(10, peakNear(targetHz * 2) / 10);
          const h3 = Math.pow(10, peakNear(targetHz * 3) / 10);
          const h4 = Math.pow(10, peakNear(targetHz * 4) / 10);
          fundPowerSum += fLin;
          harmonicPowerSum += h2 + h3 + h4;
        }
        const thd = fundPowerSum > 0 ? Math.min(100, Math.sqrt(harmonicPowerSum / fundPowerSum) * 100) : 0;
        return { fundDb: bestFund, thdPct: Math.round(thd * 10) / 10 };
      };

      const playToneAndMeasure = async (panVal: number, hz: number, label: string) => {
        setAcousticPhase(label);
        const osc = ctx!.createOscillator();
        const gain = ctx!.createGain();
        const pan = ctx!.createStereoPanner();
        osc.type = "sine";
        osc.frequency.value = hz;
        pan.pan.value = panVal;
        gain.gain.value = 0.35;
        osc.connect(gain).connect(pan).connect(ctx!.destination);
        osc.start();
        await new Promise((r) => setTimeout(r, 150));
        const res = await sampleFreqBand(hz, 750);
        osc.stop();
        osc.disconnect();
        await new Promise((r) => setTimeout(r, 120));
        return res;
      };

      const left = await playToneAndMeasure(-1, 880, "Testing Left speaker (880 Hz)...");
      const right = await playToneAndMeasure(1, 880, "Testing Right speaker (880 Hz)...");
      const bass = await playToneAndMeasure(0, 180, "Checking bass cone distortion (180 Hz)...");

      const balanceDiff = Math.round(Math.abs(left.fundDb - right.fundDb) * 10) / 10;
      const deadLeft = left.fundDb < -72;
      const deadRight = right.fundDb < -72;
      const highDistortion = bass.thdPct > 18;
      const imbalanced = balanceDiff > 14;

      const st: TestStatus = deadLeft || deadRight ? "fail" : highDistortion || imbalanced ? "warn" : "pass";
      const sum =
        deadLeft && deadRight
          ? "No speaker output heard by mic — verify volume isn't muted."
          : deadLeft
          ? "Left speaker silent or very weak."
          : deadRight
          ? "Right speaker silent or very weak."
          : highDistortion
          ? `Both speakers working, but elevated bass distortion (${bass.thdPct}% THD) — listen for rattle.`
          : imbalanced
          ? `L/R channel imbalance (${balanceDiff} dB delta) detected.`
          : `Left & Right speakers verified clean (delta ${balanceDiff} dB, ${bass.thdPct}% THD).`;

      setAcousticResult({
        status: st,
        leftDb: Math.round(left.fundDb),
        rightDb: Math.round(right.fundDb),
        balanceDiffDb: balanceDiff,
        thdPct: bass.thdPct,
        summary: sum,
      });
    } catch (e) {
      setAcousticError(
        `Microphone unavailable (${String(e)}) — use manual Left / Right buttons below.`
      );
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      setAcousticRunning(false);
      setAcousticPhase(null);
    }
  };

  const captureUsbCSide = async (side: "A" | "B") => {
    const pd = await invoke<PortDiagnosticsReport>("scan_port_diagnostics").catch(() => null);
    if (pd) {
      setPortDiag(pd);
      const text = pd.charger.acPlugged
        ? pd.charger.watts != null
          ? `OK (${pd.charger.watts.toFixed(0)}W)`
          : "OK (AC)"
        : "Not charging";
      if (side === "A") setUsbCSideA(text);
      else setUsbCSideB(text);
      if (pd.charger.acPlugged) {
        setCheckedPorts((prev) => new Set(prev).add("DC / USB-C Charging Port"));
      }
    }
  };

  const runRemovableSpeedTest = async () => {
    const target = selectedRemovable || removableDrives[0]?.mountPath;
    if (!target) return;
    setRemError(null);
    setRemTesting(true);
    try {
      const res = await invoke<RemovableDriveBenchResult>("run_removable_drive_speed_test", {
        targetMount: target,
      });
      setRemResult(res);
      onRemovableBenchComplete?.(res);
      setCheckedPorts((prev) => new Set(prev).add("USB-A Ports (Data & Power)"));
      if (res.mediaKind.toLowerCase().includes("sd")) {
        setCheckedPorts((prev) => new Set(prev).add("SD Card Reader / Ethernet LAN (if equipped)"));
      }
    } catch (e) {
      setRemError(String(e));
    } finally {
      setRemTesting(false);
    }
  };

  const togglePort = (label: string) => {
    setCheckedPorts((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const handleSignOff = (st: TestStatus) => {
    const portsList = Array.from(checkedPorts).join(", ");
    const extStr = portDiag ? `Ext displays: ${portDiag.externalDisplayCount}` : "";
    const btStr = portDiag ? `BT: ${portDiag.bluetooth.radioEnabled ? "ON" : "OFF"} (${portDiag.bluetooth.pairedOrNearbyCount} dev)` : "";
    const flipStr = usbCSideA || usbCSideB ? `USB-C flip A=${usbCSideA ?? "—"} / B=${usbCSideB ?? "—"}` : "";
    const spkStr = acousticResult
      ? `Auto-Acoustic ${acousticResult.status.toUpperCase()} (L ${acousticResult.leftDb}dB / R ${acousticResult.rightDb}dB, THD ${acousticResult.thdPct}%)`
      : "Speakers checked";

    onUpdateSignoff({
      portsChecked: st === "pass",
      portsNotes: [portsList, extStr, btStr, flipStr].filter(Boolean).join(" | "),
      speakersChecked: st === "pass",
      speakersNotes: spkStr,
    });
    onVerdict(
      st,
      st === "pass"
        ? `Ports & Speakers passed (${[extStr, btStr, spkStr].filter(Boolean).join(" • ")}).`
        : `Port or Speaker defect reported (${[extStr, spkStr].filter(Boolean).join(" • ")}).`
    );
  };

  const usb3Count = usbDevices.filter((d) => d.isSuperspeed || (d.negotiatedMbps ?? 0) >= 5000).length;

  return (
    <div className="space-y-6">
      {/* BLOCK 1: Minimal Header + 1 Primary Button */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Ports &amp; Speakers
              <span className="sr-only"> — Live USB4/3.x Speed Detector</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • Live HDMI/USB-C, Bluetooth, Ethernet &amp; auto mic-verified audio
          </div>
        </div>

        <button
          type="button"
          onClick={runAutoAcousticTest}
          disabled={acousticRunning}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 transition cursor-pointer"
        >
          <Waves className="w-3.5 h-3.5" />
          {acousticRunning ? acousticPhase || "Testing audio..." : "Auto speaker test (3s)"}
        </button>
      </div>

      {/* BLOCK 2: 1 Clean Live Hardware & Audio Result Block */}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-5">
        {/* 4 Live Port & Audio Tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* External Display Hot-Plug */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Monitor className="w-3.5 h-3.5 text-blue-600" />
                External display
              </span>
              <button
                type="button"
                onClick={loadPortDiagnostics}
                disabled={portLoading}
                className="text-zinc-400 hover:text-black cursor-pointer"
                title="Refresh port detection"
              >
                <RefreshCw className={`w-3 h-3 ${portLoading ? "animate-spin text-blue-600" : ""}`} />
              </button>
            </div>
            <div className="text-base font-bold text-black">
              {portDiag
                ? portDiag.externalDisplayCount > 0
                  ? `${portDiag.externalDisplayCount} Connected`
                  : "None plugged"
                : "Scanning..."}
            </div>
            <div className="text-xs text-zinc-500 truncate">
              {portDiag?.displays.find((d) => !d.isInternal)
                ? `${portDiag.displays.find((d) => !d.isInternal)!.connector} • ${portDiag.displays.find((d) => !d.isInternal)!.resolution}`
                : "Plug HDMI / USB-C to verify"}
            </div>
          </div>

          {/* USB-C Reversible Charger Flip */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
              <PlugZap className="w-3.5 h-3.5 text-blue-600" />
              USB-C charger flip
            </div>
            <div className="text-sm font-bold text-black truncate">
              {portDiag?.charger.acPlugged
                ? portDiag.charger.watts != null
                  ? `AC ${portDiag.charger.watts.toFixed(0)} W`
                  : "AC plugged"
                : "On battery"}
            </div>
            <div className="flex items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => captureUsbCSide("A")}
                className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold cursor-pointer ${
                  usbCSideA?.startsWith("OK")
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-zinc-200 text-black hover:border-black"
                }`}
              >
                Side A{usbCSideA ? `: ${usbCSideA}` : ""}
              </button>
              <button
                type="button"
                onClick={() => captureUsbCSide("B")}
                className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold cursor-pointer ${
                  usbCSideB?.startsWith("OK")
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-zinc-200 text-black hover:border-black"
                }`}
              >
                Flip B{usbCSideB ? `: ${usbCSideB}` : ""}
              </button>
            </div>
          </div>

          {/* Bluetooth Active & Ethernet 1Gbps */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
              <Bluetooth className="w-3.5 h-3.5 text-blue-600" />
              Bluetooth &amp; LAN
            </div>
            <div className="text-base font-bold text-black">
              {portDiag?.bluetooth.radioEnabled
                ? `BT ON (${portDiag.bluetooth.pairedOrNearbyCount})`
                : portDiag
                ? "BT Off"
                : "Checking..."}
            </div>
            <div className="text-xs text-zinc-500 truncate">
              {portDiag?.ethernet?.connected
                ? `LAN ${portDiag.ethernet.linkSpeedMbps ?? "—"} Mbps`
                : "Ethernet optional"}
            </div>
          </div>

          {/* Auto Mic-Verified Speaker L/R + THD */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
              <Volume2 className="w-3.5 h-3.5 text-blue-600" />
              Speakers &amp; THD
            </div>
            <div className="text-base font-bold text-black">
              {acousticResult
                ? `${acousticResult.thdPct}% THD`
                : activeAudioLabel || "Ready"}
            </div>
            <div className="text-xs text-zinc-500 truncate">
              {acousticResult
                ? `L ${acousticResult.leftDb} dB • R ${acousticResult.rightDb} dB`
                : "Click Auto speaker test"}
            </div>
          </div>
        </div>

        {/* Optional USB / SD-Card 64 MB Real Speed Test (v3.0.0) */}
        <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-2.5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Usb className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="font-bold text-black">USB / SD-Card Real Speed Test (64 MB)</span>
              <span className="text-zinc-500">
                {removableDrives.length > 0
                  ? `${removableDrives.length} removable drive(s) ready`
                  : "Optional — plug a USB flash drive or SD card to verify USB 3.x / SD throughput"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {removableDrives.length > 0 && (
                <>
                  <select
                    value={selectedRemovable}
                    disabled={remTesting}
                    onChange={(e) => setSelectedRemovable(e.target.value)}
                    className="bg-white border border-zinc-200 rounded-lg px-2.5 py-1 font-mono text-xs text-black"
                  >
                    {removableDrives.map((d) => (
                      <option key={d.mountPath} value={d.mountPath}>
                        {d.mountPath} {d.label} ({d.mediaKind})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={runRemovableSpeedTest}
                    disabled={remTesting}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                  >
                    {remTesting ? "Testing 64 MB..." : "Test Speed (64 MB)"}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={loadPortDiagnostics}
                disabled={portLoading || remTesting}
                className="px-2.5 py-1 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black cursor-pointer"
              >
                Scan Drives
              </button>
            </div>
          </div>
          {remError && (
            <div className="rounded-lg bg-black text-white px-3 py-2 font-mono text-xs">{remError}</div>
          )}
          {remResult && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs flex items-center justify-between gap-2 flex-wrap ${
                remResult.status === "pass"
                  ? "border-blue-600 bg-white text-black"
                  : "border-black bg-black text-white"
              }`}
            >
              <span>{remResult.plainSummary}</span>
              <StatusBadge status={remResult.status} darkSurface={remResult.status !== "pass"} compact />
            </div>
          )}
        </div>

        {/* Acoustic Result or Manual Stereo Controls */}
        {acousticError && (
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-4 py-2.5 text-xs text-black">
            {acousticError}
          </div>
        )}
        {acousticResult && (
          <div
            className={`rounded-xl border px-4 py-3 text-xs flex items-center justify-between gap-3 ${
              acousticResult.status === "fail"
                ? "border-black bg-black text-white"
                : "border-zinc-200 bg-[#F8FAFC] text-black"
            }`}
          >
            <span className="font-medium">{acousticResult.summary}</span>
            <StatusBadge status={acousticResult.status} compact />
          </div>
        )}

        {/* Quick Manual Audio + Pass / Fail Verdict Row */}
        <div className="flex items-center justify-between flex-wrap gap-3 pt-2 border-t border-zinc-100">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => playManualTone(-1, "Left")}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black cursor-pointer"
            >
              Left tone
            </button>
            <button
              type="button"
              onClick={() => playManualTone(1, "Right")}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black cursor-pointer"
            >
              Right tone
            </button>
            <button
              type="button"
              onClick={() => playManualTone(0, "Bass 180Hz", 180, 1800)}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black cursor-pointer"
            >
              Bass 180 Hz
            </button>
            {activeAudioLabel && (
              <button
                type="button"
                onClick={stopAudio}
                className="px-2.5 py-1.5 rounded-lg bg-black text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSignOff("pass")}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Pass ports &amp; speakers
            </button>
            <button
              type="button"
              onClick={() => handleSignOff("fail")}
              className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <XCircle className="w-3.5 h-3.5" />
              Fail
            </button>
          </div>
        </div>
      </div>

      {/* BLOCK 3: 1 Collapsed "Details" Toggle (USB Hot-Plug, Hardware Controls, Manual Checklist) */}
      <TechnicalDetailsDrawer
        title="Details"
        subtitle={`${usbDevices.length} USB (${usb3Count} SuperSpeed) • Radios & headphone jack • Port checklist`}
      >
        <div className="space-y-4">
          {/* Live USB Hot-Plug Speed Monitor */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-black inline-flex items-center gap-1.5">
                <Usb className="w-4 h-4 text-blue-600" />
                Live USB bus speed ({usbDevices.length} device{usbDevices.length === 1 ? "" : "s"})
              </span>
              <span className="font-mono text-[11px] text-zinc-500">
                {usb3Count} SuperSpeed (5–40 Gbps)
              </span>
            </div>
            {usbDevices.length > 0 && (
              <div className="divide-y divide-zinc-100 text-xs">
                {usbDevices.slice(0, 8).map((d, i) => (
                  <div key={i} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="text-black truncate">{d.name}</span>
                    <span className="font-mono text-[11px] font-semibold text-blue-700 shrink-0">
                      {d.negotiatedMbps ? formatMbps(d.negotiatedMbps) : d.speedClass}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {usbLog.length > 0 && (
              <div className="pt-2 border-t border-zinc-100 text-[11px] font-mono text-zinc-500 space-y-0.5">
                {usbLog.slice(0, 4).map((ev, i) => (
                  <div key={i}>
                    [{ev.ts}] {ev.kind}: {ev.name} ({ev.speed})
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hardware Controls & Radios */}
          {hwControls && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-zinc-500 inline-flex items-center gap-1">
                  <Sun className="w-3.5 h-3.5 text-blue-600" /> Display
                </div>
                <div className="font-bold text-black mt-0.5">
                  {hwControls.displayBrightness.currentPct != null
                    ? `${hwControls.displayBrightness.currentPct}%`
                    : "N/A"}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-zinc-500 inline-flex items-center gap-1">
                  <Wifi className="w-3.5 h-3.5 text-blue-600" /> Wi-Fi
                </div>
                <div className="font-bold text-black mt-0.5">
                  {hwControls.wifi.enabled ? "On" : "Off"}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-zinc-500 inline-flex items-center gap-1">
                  <Bluetooth className="w-3.5 h-3.5 text-blue-600" /> Bluetooth
                </div>
                <div className="font-bold text-black mt-0.5">
                  {hwControls.bluetooth.enabled ? "On" : "Off"}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-zinc-500 inline-flex items-center gap-1">
                  <Plane className="w-3.5 h-3.5 text-blue-600" /> Airplane
                </div>
                <div className="font-bold text-black mt-0.5">
                  {hwControls.airplaneMode.active ? "On" : "Off"}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-zinc-500 inline-flex items-center gap-1">
                  <Headphones className="w-3.5 h-3.5 text-blue-600" /> 3.5mm jack
                </div>
                <div className="font-bold text-black mt-0.5">
                  {hwControls.headphoneJack.pluggedIn ? "Plugged" : "Unplugged"}
                </div>
              </div>
            </div>
          )}

          {/* Ethernet & Bluetooth Device Details */}
          {portDiag && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2 text-xs">
              <div className="font-bold text-black inline-flex items-center gap-1.5">
                <Network className="w-4 h-4 text-blue-600" />
                Live port readout ({portDiag.platform})
              </div>
              <div className="text-zinc-600">{portDiag.bluetooth.detail}</div>
              {portDiag.bluetooth.deviceNames.length > 0 && (
                <div className="font-mono text-[11px] text-zinc-500">
                  BT devices: {portDiag.bluetooth.deviceNames.join(", ")}
                </div>
              )}
              {portDiag.ethernet && (
                <div className="text-zinc-600">
                  {portDiag.ethernet.adapterName}: {portDiag.ethernet.detail}
                </div>
              )}
            </div>
          )}

          {/* Optional Physical Port Checklist */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2">
            <div className="text-xs font-bold text-black">Physical port checklist (optional)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {PORT_ITEMS.map((item) => (
                <label
                  key={item}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 bg-[#F8FAFC] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checkedPorts.has(item)}
                    onChange={() => togglePort(item)}
                    className="w-3.5 h-3.5 accent-blue-600"
                  />
                  <span className="text-black">{item}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </TechnicalDetailsDrawer>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Run speaker check and click Pass or Fail to complete inspection."
        nextLabel="Issue QC Certificate"
        onNext={onFinish}
        onSkip={onSkip}
      />
    </div>
  );
};
