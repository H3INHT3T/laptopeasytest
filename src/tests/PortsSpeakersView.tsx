import React, { useState } from "react";
import { CheckCircle2, PlugZap, Volume2, Waves, XCircle } from "lucide-react";
import type { PortsSpeakerSignoff, TestStatus } from "../types";
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
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Physical Ports &amp; Speaker Audio Verification
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Interactive Left / Right / Stereo &amp; Frequency-Sweep speaker distortion check plus physical I/O port sign-off.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Speakers */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-black">
            <Volume2 className="w-4 h-4 text-blue-600" />
            Speaker Channel &amp; Rattle Sweep Test
          </div>
          <p className="text-xs text-zinc-600">
            Test Left-only, Right-only, Stereo balance, and the 120 Hz → 6.5 kHz sweep to catch blown or rattling speakers.
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => playTone("left")}
              className="py-2.5 px-3 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black text-xs font-bold cursor-pointer"
            >
              Play Left Channel (L)
            </button>
            <button
              onClick={() => playTone("right")}
              className="py-2.5 px-3 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black text-xs font-bold cursor-pointer"
            >
              Play Right Channel (R)
            </button>
            <button
              onClick={() => playTone("both")}
              className="py-2.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer"
            >
              Play Balanced Stereo
            </button>
            <button
              onClick={() => playTone("both", true)}
              className="py-2.5 px-3 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Waves className="w-3.5 h-3.5 text-blue-400" />
              Frequency Sweep (2.3s)
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs font-bold text-black pt-2 border-t border-zinc-100 cursor-pointer">
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
            className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
          />
        </div>

        {/* Ports Checklist */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-black">
            <PlugZap className="w-4 h-4 text-blue-600" />
            Physical I/O Ports Verification
          </div>
          <div className="space-y-2">
            {PORT_ITEMS.map((item) => {
              const checked = checkedPorts.has(item);
              return (
                <label
                  key={item}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-xs font-medium cursor-pointer transition ${
                    checked
                      ? "bg-blue-50 border-blue-600 text-black font-bold"
                      : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:border-black"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePort(item)}
                    className="w-4 h-4 accent-blue-600"
                  />
                  {item}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Verdict */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-600">
          Confirm Ports &amp; Speakers verdict to unlock the Final Branded QC Certificate.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              onUpdateSignoff({ ...signoff, portsChecked: true, speakersChecked: true });
              onVerdict(
                "pass",
                `Ports (${checkedPorts.size || PORT_ITEMS.length} groups) & Stereo Speakers verified clear.`
              );
            }}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" /> Pass Ports &amp; Speakers
          </button>
          <button
            onClick={() => onVerdict("fail", "Physical port or speaker defect noted.")}
            className="px-4 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-4 h-4" /> Fail Ports / Speakers
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        nextLabel="Open Final QC Certificate"
        requirementHint="Confirm Ports & Speakers verdict to unlock the Final QC Report (or click Skip Step)."
        onNext={onFinish}
        onSkip={onSkip}
      />
    </div>
  );
};
