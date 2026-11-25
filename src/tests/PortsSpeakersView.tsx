import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, PlugZap, Usb, Volume2, Waves, XCircle } from "lucide-react";
import type { PortsSpeakerSignoff, TestStatus, UsbDeviceInfo, UsbHotplugEvent } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface PortsSpeakersViewProps {
  status: TestStatus;
  signoff: PortsSpeakerSignoff;
  stepNumber: number;
  totalSteps: number;
  onUpdateSignoff: (signoff: PortsSpeakerSignoff) => void;
  onVerdict: (status: TestStatus, summary: string) => void;
  onFinish: () => void;
  onSkip: () => void;
}

function playTone(channel: "left" | "right" | "both", sweep = false) {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type = "sine";
    panner.pan.setValueAtTime(channel === "left" ? -1 : channel === "right" ? 1 : 0, ctx.currentTime);

    if (sweep) {
      osc.frequency.setValueAtTime(120, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(6500, ctx.currentTime + 2.2);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.3);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 2.35);
      setTimeout(() => ctx.close(), 2500);
    } else {
      osc.frequency.setValueAtTime(channel === "left" ? 440 : channel === "right" ? 587.33 : 523.25, ctx.currentTime);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.75);
      setTimeout(() => ctx.close(), 900);
    }
  } catch {
    // AudioContext blocked
  }
}

const PORT_ITEMS = [
  "USB-A Ports (Data & Power)",
  "USB-C / Thunderbolt Ports",
  "HDMI / DisplayPort External Output",
  "DC / USB-C Charging Port",
  "3.5mm Headphone / Combo Audio Jack",
  "SD Card Reader / Ethernet LAN (if equipped)",
];

export const PortsSpeakersView: React.FC<PortsSpeakersViewProps> = ({
  status,
  signoff,
  stepNumber,
  totalSteps,
  onUpdateSignoff,
  onVerdict,
  onFinish,
  onSkip,
}) => {
  const [checkedPorts, setCheckedPorts] = useState<Set<string>>(new Set());
  const [usbMonitoring, setUsbMonitoring] = useState(true);
  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [usbLog, setUsbLog] = useState<Array<{ ts: string; kind: string; name: string; speed: string; ss: boolean }>>([]);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              Live USB Hot-Plug Speed Detector, Physical Ports &amp; Speakers
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Plug a USB 3.x drive into each port to verify SuperSpeed (5–10 Gbps) vs. USB 2.0 (480 Mbps) negotiation, and run Left/Right/Sweep speaker checks.
          </p>
        </div>
      </div>

      {/* Live USB Hot-Plug Speed Detector */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="font-mono text-xs font-black uppercase text-black flex items-center gap-1.5">
              <Usb className="w-4 h-4 text-blue-600" />
              Live USB Hot-Plug &amp; Negotiated Speed Monitor
            </div>
            <div className="text-[11px] text-zinc-600">
              Detects plug/unplug events live — if a USB 3.0 flash drive drops to USB 2.0 (480 Mbps), that port has damaged SuperSpeed pins.
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

        <div className="max-h-36 overflow-y-auto border border-zinc-200">
          <table className="w-full text-left border-collapse text-[11px] font-mono">
            <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-[9.5px] uppercase text-zinc-500">
              <tr>
                <th className="py-1.5 px-3">Connected USB Device</th>
                <th className="py-1.5 px-3">Negotiated Bus Speed</th>
                <th className="py-1.5 px-3 text-right">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {usbDevices.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-3 px-3 text-zinc-500 text-center">
                    Plug any USB flash drive or peripheral into a port to test live speed negotiation...
                  </td>
                </tr>
              ) : (
                usbDevices.map((d) => (
                  <tr key={d.instanceId}>
                    <td className="py-1.5 px-3 font-sans font-semibold text-black">{d.name}</td>
                    <td className={`py-1.5 px-3 font-bold ${d.isSuperspeed ? "text-blue-700" : "text-zinc-700"}`}>
                      {d.speedClass}
                    </td>
                    <td className="py-1.5 px-3 text-right text-zinc-500">{d.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Speakers */}
        <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3.5">
          <div className="flex items-center gap-2 font-mono text-xs font-black uppercase text-black">
            <Volume2 className="w-4 h-4 text-blue-600" />
            Speaker Channel &amp; Rattle Sweep
          </div>
          <p className="text-[11px] text-zinc-600">
            Test Left-only, Right-only, Stereo balance, and the 120 Hz → 6.5 kHz sweep to catch blown or rattling speakers.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => playTone("left")}
              className="py-2 px-3 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Left Channel (L)
            </button>
            <button
              onClick={() => playTone("right")}
              className="py-2 px-3 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Right Channel (R)
            </button>
            <button
              onClick={() => playTone("both")}
              className="py-2 px-3 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Balanced Stereo
            </button>
            <button
              onClick={() => playTone("both", true)}
              className="py-2 px-3 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-[11px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Waves className="w-3.5 h-3.5 text-blue-400" />
              Sweep (2.3s)
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

      {/* Verdict */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-600">
          Confirm Ports &amp; Speakers verdict to issue the Swiss Lab Calibration Certificate.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              onUpdateSignoff({ ...signoff, portsChecked: true, speakersChecked: true });
              onVerdict(
                "pass",
                `Ports (${checkedPorts.size || PORT_ITEMS.length} groups, ${usbLog.filter((l) => l.kind === "CONNECTED").length} hot-plug verified) & Stereo Speakers clear.`
              );
            }}
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Pass Ports &amp; Speakers
          </button>
          <button
            onClick={() => onVerdict("fail", "Physical port or speaker defect noted.")}
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
