import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Cpu,
  Flame,
  MemoryStick,
  Play,
  ShieldCheck,
  Square,
  ThermometerSnowflake,
  Zap,
} from "lucide-react";
import type {
  CpuStressProgress,
  CpuStressResult,
  GpuStressProgress,
  GpuStressResult,
  LiveTelemetrySnapshot,
  PowerTortureProgress,
  PowerTortureResult,
  RamTestProgress,
  RamTestResult,
  SystemSpecs,
  VramTestProgress,
  VramTestResult,
} from "../types";
import { LiveChart } from "../components/LiveChart";
import { NovabenchScoreBar } from "../components/NovabenchScoreBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

type StressTarget = "cpu" | "gpu" | "memory" | "vram" | "power";
type StressDuration = "quick" | "standard" | "burnin";
type CpuDataSet = "small" | "medium" | "large";
type CpuLoadType = "steady" | "variable";
type CpuThreadsMode = "all" | "physical";

interface StressHubViewProps {
  specs: SystemSpecs | null;
  telemetry: LiveTelemetrySnapshot | null;
  lastCpuStress?: CpuStressResult | null;
  onRunningChange?: (running: boolean, label: string | null) => void;
  onCpuStressComplete?: (res: CpuStressResult) => void;
  onGpuComplete?: (res: GpuStressResult) => void;
  onRamComplete?: (res: RamTestResult) => void;
  onVramComplete?: (res: VramTestResult) => void;
  onPowerComplete?: (res: PowerTortureResult) => void;
}

const TARGETS: Array<{
  id: StressTarget;
  label: string;
  shortDesc: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "cpu", label: "CPU", shortDesc: "OCCT steady/variable + WHEA", icon: Cpu },
  { id: "gpu", label: "GPU (3D)", shortDesc: "Native wgpu 3D shader load", icon: Flame },
  { id: "memory", label: "Memory", shortDesc: "TestMem5 RAM error sweep", icon: MemoryStick },
  { id: "vram", label: "VRAM", shortDesc: "GPU memory integrity check", icon: ShieldCheck },
  { id: "power", label: "Power", shortDesc: "Full CPU + GPU + RAM load", icon: Zap },
];

export const StressHubView: React.FC<StressHubViewProps> = ({
  specs,
  telemetry,
  lastCpuStress = null,
  onRunningChange,
  onCpuStressComplete,
  onGpuComplete,
  onRamComplete,
  onVramComplete,
  onPowerComplete,
}) => {
  const [target, setTarget] = useState<StressTarget>("cpu");
  const [durationPreset, setDurationPreset] = useState<StressDuration>("standard");
  const [thermalCutoff, setThermalCutoff] = useState<number>(92);
  const [ramPct, setRamPct] = useState<number>(60);

  // OCCT CPU Stress controls
  const [cpuDataSet, setCpuDataSet] = useState<CpuDataSet>("medium");
  const [cpuLoadType, setCpuLoadType] = useState<CpuLoadType>("steady");
  const [cpuThreadsMode, setCpuThreadsMode] = useState<CpuThreadsMode>("all");
  const [stopOnError, setStopOnError] = useState<boolean>(true);
  const [cooldownSecs, setCooldownSecs] = useState<number>(15);

  const [running, setRunning] = useState(false);
  const [phaseText, setPhaseText] = useState("Ready");
  const [inCooldown, setInCooldown] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [errorsCount, setErrorsCount] = useState(0);
  const [liveMetricLabel, setLiveMetricLabel] = useState("Clock / Speed");
  const [liveMetricValue, setLiveMetricValue] = useState("—");
  const [peakTemp, setPeakTemp] = useState<number | null>(null);
  const [perfPoints, setPerfPoints] = useState<number[]>([]);
  const [tempPoints, setTempPoints] = useState<number[]>([]);
  const [chartUnit, setChartUnit] = useState("MHz");
  const [cpuResult, setCpuResult] = useState<CpuStressResult | null>(lastCpuStress);
  const [summaryBanner, setSummaryBanner] = useState<{
    status: "pass" | "warn" | "fail";
    headline: string;
    detail: string;
    scorePct: number;
    badge?: string;
  } | null>(null);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen<CpuStressProgress>("cpu_stress:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(p.phase);
      setInCooldown(Boolean(p.inCooldown));
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.calcErrors + p.wheaErrors);
      setLiveMetricLabel("CPU Clock");
      setLiveMetricValue(p.cpuClockMhz ? `${p.cpuClockMhz} MHz` : `${p.cpuUsagePct.toFixed(0)}%`);
      if (p.cpuTempC != null) {
        setPeakTemp((prev) => Math.max(prev ?? 0, p.cpuTempC!));
        setTempPoints((prev) => [...prev.slice(-80), p.cpuTempC!]);
      }
      setChartUnit("MHz");
      setPerfPoints((prev) => [...prev.slice(-80), p.cpuClockMhz || p.cpuUsagePct]);
    }).then((fn) => unsubs.push(fn));

    listen<GpuStressProgress>("gpu:progress", (ev) => {
      const p = ev.payload;
      setPhaseText("3D Shader Load");
      setInCooldown(false);
      const pct = p.durationSecs > 0 ? Math.min(100, Math.round((p.elapsedSecs / p.durationSecs) * 100)) : 0;
      setProgressPct(pct);
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.artifactErrors ?? 0);
      setLiveMetricLabel("Frame Rate");
      setLiveMetricValue(`${p.fps.toFixed(1)} FPS`);
      if (p.gpuTempC != null) {
        setPeakTemp((prev) => Math.max(prev ?? 0, p.gpuTempC!));
        setTempPoints((prev) => [...prev.slice(-80), p.gpuTempC!]);
      }
      setChartUnit("FPS");
      setPerfPoints((prev) => [...prev.slice(-80), p.fps]);
    }).then((fn) => unsubs.push(fn));

    listen<RamTestProgress>("ram:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(p.patternName);
      setInCooldown(false);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.errorsFound);
      setLiveMetricLabel("RAM Speed");
      setLiveMetricValue(`${p.bandwidthGbS.toFixed(1)} GB/s`);
      if (p.cpuTempC != null) {
        setPeakTemp((prev) => Math.max(prev ?? 0, p.cpuTempC!));
        setTempPoints((prev) => [...prev.slice(-80), p.cpuTempC!]);
      }
      setChartUnit("GB/s");
      setPerfPoints((prev) => [...prev.slice(-80), p.bandwidthGbS]);
    }).then((fn) => unsubs.push(fn));

    listen<VramTestProgress>("vram:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(`VRAM Pass ${p.passNumber}`);
      setInCooldown(false);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.errorsFound);
      setLiveMetricLabel("VRAM Speed");
      setLiveMetricValue(`${p.bandwidthGbS.toFixed(1)} GB/s`);
      if (p.gpuTempC != null) {
        setPeakTemp((prev) => Math.max(prev ?? 0, p.gpuTempC!));
        setTempPoints((prev) => [...prev.slice(-80), p.gpuTempC!]);
      }
      setChartUnit("GB/s");
      setPerfPoints((prev) => [...prev.slice(-80), p.bandwidthGbS]);
    }).then((fn) => unsubs.push(fn));

    listen<PowerTortureProgress>("torture:progress", (ev) => {
      const p = ev.payload;
      setPhaseText("CPU + GPU + RAM");
      setInCooldown(false);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.artifactErrors ?? 0);
      setLiveMetricLabel("Combined FPS");
      setLiveMetricValue(`${p.gpuFps.toFixed(1)} FPS`);
      const t = Math.max(p.telemetry?.cpuTempC ?? 0, p.telemetry?.gpuTempC ?? 0);
      if (t > 0) {
        setPeakTemp((prev) => Math.max(prev ?? 0, t));
        setTempPoints((prev) => [...prev.slice(-80), t]);
      }
      setChartUnit("FPS");
      setPerfPoints((prev) => [...prev.slice(-80), p.gpuFps]);
    }).then((fn) => unsubs.push(fn));

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, []);

  const durationSecsForTarget = (): number => {
    if (durationPreset === "quick") return 45;
    if (durationPreset === "standard") return 120;
    return 300;
  };

  const startStress = async () => {
    setRunning(true);
    setSummaryBanner(null);
    setInCooldown(false);
    setErrorsCount(0);
    setProgressPct(0);
    setElapsedSecs(0);
    setPeakTemp(null);
    setPerfPoints([]);
    setTempPoints([]);
    onRunningChange?.(true, `Stress Lab: ${target.toUpperCase()}`);

    try {
      if (target === "cpu") {
        setPhaseText("Starting OCCT CPU Stability Loop...");
        const res = await invoke<CpuStressResult>("run_cpu_stress", {
          dataSet: cpuDataSet,
          loadType: cpuLoadType,
          threadsMode: cpuThreadsMode,
          durationSecs: durationSecsForTarget(),
          thermalCutoffC: thermalCutoff,
          stopOnError,
          cooldownSecs,
        });
        setCpuResult(res);
        setErrorsCount(res.totalErrors);
        onCpuStressComplete?.(res);
        const stabilityPct = res.totalErrors > 0 || res.thermalCutoffTriggered
          ? 25
          : Math.max(40, Math.round(100 - res.throttleDropPct));
        setSummaryBanner({
          status: res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `CPU Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — ${res.totalErrors} Errors`,
          detail: res.plainSummary || res.summary,
          scorePct: stabilityPct,
          badge: `Cool-Down: ${res.cooldownVerdict}`,
        });
      } else if (target === "gpu") {
        setPhaseText("Starting Native wgpu 3D GPU Stress...");
        const res = await invoke<GpuStressResult>("run_gpu_stress", {
          adapterIndex: null,
          preset: durationPreset,
          resolution: "1080p",
          extremeMode: durationPreset === "burnin",
          thermalCutoffC: Math.min(92, thermalCutoff),
        });
        onGpuComplete?.(res);
        setErrorsCount(res.artifactErrors ?? 0);
        setSummaryBanner({
          status: res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `GPU Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — ${res.avgFps.toFixed(1)} FPS`,
          detail: res.plainSummary || res.summary,
          scorePct: Math.max(25, Math.min(100, Math.round(100 - res.fpsDropPct))),
          badge: `${res.artifactErrors ?? 0} Artifacts`,
        });
      } else if (target === "memory") {
        setPhaseText("Starting TestMem5 RAM Stress...");
        const res = await invoke<RamTestResult>("run_ram_stress", {
          preset: durationPreset,
          memoryPercent: ramPct,
          customDurationSecs: durationSecsForTarget(),
          memoryTypeHint: specs?.ramModules[0]?.memoryType ?? "DDR4",
        });
        onRamComplete?.(res);
        setErrorsCount(res.errorsFound);
        setSummaryBanner({
          status: res.errorsFound > 0 || res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `Memory Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — ${res.errorsFound} Errors`,
          detail: res.plainSummary || res.summary,
          scorePct: res.errorsFound > 0 ? 15 : 100,
          badge: `${res.totalGbVerified.toFixed(1)} GB Verified`,
        });
      } else if (target === "vram") {
        setPhaseText("Starting GPU VRAM Integrity Stress...");
        const res = await invoke<VramTestResult>("run_vram_test", {
          adapterIndex: null,
          targetVramMb: null,
          durationSecs: durationSecsForTarget(),
          thermalCutoffC: Math.min(92, thermalCutoff),
        });
        onVramComplete?.(res);
        setErrorsCount(res.errorsFound);
        setSummaryBanner({
          status: res.errorsFound > 0 || res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `VRAM Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — ${res.errorsFound} Errors`,
          detail: res.plainSummary || res.summary,
          scorePct: res.errorsFound > 0 ? 15 : 100,
          badge: `${res.totalGbVerified.toFixed(1)} GB VRAM`,
        });
      } else {
        setPhaseText("Starting Combined Power Stress...");
        const res = await invoke<PowerTortureResult>("run_power_torture", {
          adapterIndex: null,
          durationSecs: durationSecsForTarget(),
          thermalCutoffC: thermalCutoff,
        });
        onPowerComplete?.(res);
        setSummaryBanner({
          status: res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `Power Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — Grade ${res.durabilityGrade}`,
          detail: res.plainSummary || res.summary,
          scorePct: res.thermalCutoffTriggered || res.batteryDrainWhilePlugged ? 35 : 95,
          badge: res.batteryDrainWhilePlugged ? "AC Drain Alert" : "AC Stable",
        });
      }
    } catch (e) {
      setSummaryBanner({
        status: "fail",
        headline: "Stress Test Error",
        detail: String(e),
        scorePct: 10,
      });
    } finally {
      setRunning(false);
      setInCooldown(false);
      onRunningChange?.(false, null);
    }
  };

  const stopStress = async () => {
    const map: Record<StressTarget, string> = {
      cpu: "cancel_cpu_stress",
      gpu: "cancel_gpu_stress",
      memory: "cancel_ram_stress",
      vram: "cancel_vram_test",
      power: "cancel_power_torture",
    };
    await invoke(map[target]).catch(() => {});
  };

  const currentTemp =
    target === "gpu" || target === "vram"
      ? telemetry?.gpuTempC ?? telemetry?.cpuTempC
      : telemetry?.cpuTempC;

  return (
    <div className="space-y-5">
      {/* Clean Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-black tracking-tight">Stress Lab</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            OCCT-style CPU, GPU, Memory &amp; Power stability testing with automatic thermal guard and cool-down check.
          </p>
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-zinc-200 bg-white text-xs font-medium text-zinc-700">
          <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
          Thermal Cutoff: {thermalCutoff}°C
        </div>
      </div>

      {/* 5 Clean Target Pills */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        {TARGETS.map((t) => {
          const Icon = t.icon;
          const active = target === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={running}
              onClick={() => setTarget(t.id)}
              className={`rounded-xl border p-3.5 text-left transition cursor-pointer disabled:opacity-50 ${
                active
                  ? "border-blue-600 bg-blue-50/50 shadow-2xs"
                  : "border-zinc-200 bg-white hover:border-zinc-400"
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-4 h-4 ${active ? "text-blue-600" : "text-zinc-500"}`} />
                {active && <span className="w-2 h-2 rounded-full bg-blue-600" />}
              </div>
              <div className="mt-2 text-sm font-bold text-black">{t.label}</div>
              <div className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{t.shortDesc}</div>
            </button>
          );
        })}
      </div>

      {/* Main OCCT Control Panel */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3.5">
            {/* Duration */}
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-zinc-500">Duration</div>
              <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
                {(
                  [
                    ["quick", "Quick (45s)"],
                    ["standard", "Standard (2m)"],
                    ["burnin", "Long (5m)"],
                  ] as [StressDuration, string][]
                ).map(([id, lbl]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={running}
                    onClick={() => setDurationPreset(id)}
                    className={`px-3 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                      durationPreset === id ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Thermal Cutoff */}
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-zinc-500">Thermal Limit</div>
              <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs font-mono">
                {[85, 90, 92, 95].map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={running}
                    onClick={() => setThermalCutoff(c)}
                    className={`px-2.5 py-1.5 rounded-md font-bold transition cursor-pointer ${
                      thermalCutoff === c ? "bg-black text-white" : "text-zinc-600 hover:text-black"
                    }`}
                  >
                    {c}°C
                  </button>
                ))}
              </div>
            </div>

            {/* CPU-Specific OCCT Controls */}
            {target === "cpu" && (
              <>
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-zinc-500">Data Set</div>
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
                    {(
                      [
                        ["small", "Small"],
                        ["medium", "Medium"],
                        ["large", "Large"],
                      ] as [CpuDataSet, string][]
                    ).map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        disabled={running}
                        onClick={() => setCpuDataSet(id)}
                        className={`px-2.5 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                          cpuDataSet === id ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-zinc-500">Load Mode</div>
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
                    {(
                      [
                        ["steady", "Steady"],
                        ["variable", "Variable Spikes"],
                      ] as [CpuLoadType, string][]
                    ).map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        disabled={running}
                        onClick={() => setCpuLoadType(id)}
                        className={`px-2.5 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                          cpuLoadType === id ? "bg-black text-white" : "text-zinc-600 hover:text-black"
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-zinc-500">Threads</div>
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
                    {(
                      [
                        ["all", "All Cores"],
                        ["physical", "Physical Only"],
                      ] as [CpuThreadsMode, string][]
                    ).map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        disabled={running}
                        onClick={() => setCpuThreadsMode(id)}
                        className={`px-2.5 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                          cpuThreadsMode === id ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* RAM % */}
            {target === "memory" && (
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-zinc-500">Memory Allocation</div>
                <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs font-mono">
                  {[50, 60, 75].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      disabled={running}
                      onClick={() => setRamPct(pct)}
                      className={`px-2.5 py-1.5 rounded-md font-bold transition cursor-pointer ${
                        ramPct === pct ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Primary Action Button */}
          <div>
            {running ? (
              <button
                type="button"
                onClick={stopStress}
                className="px-7 py-3 rounded-xl bg-black hover:bg-zinc-800 text-white font-bold text-sm flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-4 h-4 fill-white" />
                Stop Test
              </button>
            ) : (
              <button
                type="button"
                onClick={startStress}
                className="px-7 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center gap-2 shadow-sm cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" />
                Start {TARGETS.find((t) => t.id === target)?.label} Stress
              </button>
            )}
          </div>
        </div>

        {/* Clean Safety Toggles Row for CPU */}
        {target === "cpu" && (
          <div className="flex flex-wrap items-center gap-5 pt-2 border-t border-zinc-100 text-xs text-zinc-700">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                disabled={running}
                checked={stopOnError}
                onChange={(e) => setStopOnError(e.target.checked)}
                className="w-3.5 h-3.5 accent-blue-600"
              />
              <span className="font-medium">Stop immediately on first checksum or WHEA error</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <ThermometerSnowflake className="w-3.5 h-3.5 text-blue-600" />
              <span className="font-medium">Cool-down recovery check:</span>
              <select
                disabled={running}
                value={cooldownSecs}
                onChange={(e) => setCooldownSecs(Number(e.target.value))}
                className="rounded-md border border-zinc-200 bg-[#F8FAFC] px-2 py-0.5 font-mono text-xs font-bold text-black"
              >
                <option value={0}>Off</option>
                <option value={15}>15s</option>
                <option value={30}>30s</option>
              </select>
            </label>
          </div>
        )}

        {/* Progress Bar */}
        {(running || progressPct > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-black inline-flex items-center gap-1.5">
                {inCooldown && <ThermometerSnowflake className="w-3.5 h-3.5 text-blue-600" />}
                {phaseText}
              </span>
              <span className="font-mono text-zinc-500 tabular-nums">{progressPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
              />
            </div>
          </div>
        )}

        {/* 4 Clean Key Numbers */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Errors Found</div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1 ${errorsCount > 0 ? "text-black underline" : "text-blue-600"}`}>
              {errorsCount}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Elapsed</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {elapsedSecs.toFixed(0)}s
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">{liveMetricLabel}</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {liveMetricValue}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Peak Temp</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {peakTemp != null
                ? `${peakTemp.toFixed(0)}°C`
                : currentTemp != null
                ? `${currentTemp.toFixed(0)}°C`
                : "—"}
            </div>
          </div>
        </div>

        {/* Per-Core Live Temperature Pill Strip */}
        {(telemetry?.perCoreTempsC?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-3.5 py-2 flex items-center gap-1.5 flex-wrap font-mono text-[11px] tabular-nums">
            <span className="text-[10px] font-bold uppercase text-zinc-500 mr-1">Per-Core °C:</span>
            {telemetry!.perCoreTempsC!.map((t, i) => (
              <span
                key={i}
                className={`px-2 py-0.5 rounded-md border ${
                  t >= thermalCutoff
                    ? "bg-black border-black text-white font-bold"
                    : t >= 82
                    ? "bg-blue-50 border-blue-600 text-blue-700 font-bold"
                    : "bg-white border-zinc-200 text-black"
                }`}
              >
                C{i}: {t.toFixed(0)}°
              </span>
            ))}
          </div>
        )}

        {/* Dual Live Oscilloscope Graphs (Performance + Thermal) */}
        {(perfPoints.length > 1 || tempPoints.length > 1) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-1">
            {perfPoints.length > 1 && (
              <LiveChart
                title={`${TARGETS.find((t) => t.id === target)?.label} Output`}
                data={perfPoints}
                unit={chartUnit}
                height={145}
              />
            )}
            {tempPoints.length > 1 && (
              <LiveChart
                title="Thermal Curve"
                data={tempPoints}
                unit="°C"
                maxSuggested={100}
                baselineValue={thermalCutoff}
                baselineLabel={`Cutoff ${thermalCutoff}°C`}
                higherIsBetter={false}
                height={145}
              />
            )}
          </div>
        )}
      </div>

      {/* Novabench-Style Summary Score Bar */}
      {summaryBanner && (
        <NovabenchScoreBar
          scoreLabel={target.toUpperCase()}
          scoreValue={summaryBanner.status === "pass" ? "PASS" : summaryBanner.status === "warn" ? "WARN" : "FAIL"}
          title={summaryBanner.headline}
          takeaway={summaryBanner.detail}
          percent={summaryBanner.scorePct}
          medianLabel="Expected Shop Stability"
          medianPercent={85}
          badge={summaryBanner.badge}
          monochrome={summaryBanner.status !== "pass"}
        />
      )}

      {/* Cool-Down, NVML & Error Proof Details Drawer */}
      {(cpuResult || (telemetry?.gpuThrottleReasons?.length ?? 0) > 0 || perfPoints.length > 1) && (
        <TechnicalDetailsDrawer
          title="Details"
          subtitle="Stress telemetry proof, cool-down delta, NVML hardware throttle flags & error counters"
        >
          <div className="space-y-3">
            {cpuResult && target === "cpu" && (
              <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                <span>
                  Threads: <strong>{cpuResult.threadsUsed}</strong> • Avg Clock: <strong>{cpuResult.avgClockMhz} MHz</strong> • Throttle: <strong>{cpuResult.throttleDropPct.toFixed(1)}%</strong>
                </span>
                <span>
                  Calc Err: <strong>{cpuResult.calcErrors}</strong> • WHEA Err: <strong>{cpuResult.wheaErrors}</strong>
                  {cpuResult.cooldownDropC != null && (
                    <> • Cool-Down: <strong className="text-blue-700">-{cpuResult.cooldownDropC.toFixed(1)}°C ({cpuResult.cooldownVerdict})</strong></>
                  )}
                </span>
              </div>
            )}
            {telemetry && (telemetry.gpuClockMhz != null || (telemetry.gpuThrottleReasons?.length ?? 0) > 0) && (
              <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                <span>
                  NVML GPU Clock: <strong>{telemetry.gpuClockMhz ?? "—"} MHz</strong> • VRAM:{" "}
                  <strong>{telemetry.gpuMemClockMhz ?? "—"} MHz</strong> • Fan:{" "}
                  <strong>{telemetry.gpuFanPct != null ? `${telemetry.gpuFanPct}%` : "—"}</strong>
                </span>
                <span>
                  HW Throttle:{" "}
                  <strong className={(telemetry.gpuThrottleReasons?.length ?? 0) > 0 ? "text-black underline" : "text-blue-700"}>
                    {(telemetry.gpuThrottleReasons?.length ?? 0) > 0
                      ? telemetry.gpuThrottleReasons!.join(", ")
                      : "None"}
                  </strong>
                </span>
              </div>
            )}
          </div>
        </TechnicalDetailsDrawer>
      )}
    </div>
  );
};
