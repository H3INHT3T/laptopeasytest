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
  Zap,
} from "lucide-react";
import type {
  GpuStressProgress,
  GpuStressResult,
  LiveTelemetrySnapshot,
  PerfBenchProgress,
  PerfBenchResult,
  PowerTortureProgress,
  PowerTortureResult,
  RamTestProgress,
  RamTestResult,
  SystemSpecs,
  VramTestProgress,
  VramTestResult,
} from "../types";
import { LiveChart } from "../components/LiveChart";

type StressTarget = "cpu" | "gpu" | "memory" | "vram" | "power";
type StressDuration = "quick" | "standard" | "burnin";

interface StressHubViewProps {
  specs: SystemSpecs | null;
  telemetry: LiveTelemetrySnapshot | null;
  onRunningChange?: (running: boolean, label: string | null) => void;
  onCpuComplete?: (res: PerfBenchResult) => void;
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
  { id: "cpu", label: "CPU", shortDesc: "Multi-core SIMD & thermal throttle", icon: Cpu },
  { id: "gpu", label: "GPU (3D)", shortDesc: "Native wgpu shader & frame stability", icon: Flame },
  { id: "memory", label: "Memory", shortDesc: "TestMem5 multi-thread RAM verification", icon: MemoryStick },
  { id: "vram", label: "VRAM", shortDesc: "Dedicated GPU memory integrity", icon: ShieldCheck },
  { id: "power", label: "Power", shortDesc: "Combined CPU + GPU + RAM load", icon: Zap },
];

export const StressHubView: React.FC<StressHubViewProps> = ({
  specs,
  telemetry,
  onRunningChange,
  onCpuComplete,
  onGpuComplete,
  onRamComplete,
  onVramComplete,
  onPowerComplete,
}) => {
  const [target, setTarget] = useState<StressTarget>("cpu");
  const [durationPreset, setDurationPreset] = useState<StressDuration>("standard");
  const [thermalCutoff, setThermalCutoff] = useState<number>(92);
  const [ramPct, setRamPct] = useState<number>(60);

  const [running, setRunning] = useState(false);
  const [phaseText, setPhaseText] = useState("Ready");
  const [progressPct, setProgressPct] = useState(0);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [errorsCount, setErrorsCount] = useState(0);
  const [liveMetricLabel, setLiveMetricLabel] = useState("Throughput");
  const [liveMetricValue, setLiveMetricValue] = useState("—");
  const [peakTemp, setPeakTemp] = useState<number | null>(null);
  const [chartPoints, setChartPoints] = useState<number[]>([]);
  const [chartUnit, setChartUnit] = useState("MHz");
  const [summaryBanner, setSummaryBanner] = useState<{
    status: "pass" | "warn" | "fail";
    headline: string;
    detail: string;
  } | null>(null);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(p.phase);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setLiveMetricLabel("CPU Clock");
      setLiveMetricValue(p.cpuClockMhz ? `${p.cpuClockMhz} MHz` : `${p.cpuUsagePct.toFixed(0)}%`);
      if (p.cpuTempC != null) setPeakTemp((prev) => Math.max(prev ?? 0, p.cpuTempC!));
      setChartUnit("MHz");
      setChartPoints((prev) => [...prev.slice(-80), p.cpuClockMhz || p.cpuUsagePct]);
    }).then((fn) => unsubs.push(fn));

    listen<GpuStressProgress>("gpu:progress", (ev) => {
      const p = ev.payload;
      setPhaseText("3D Shader Load");
      const pct = p.durationSecs > 0 ? Math.min(100, Math.round((p.elapsedSecs / p.durationSecs) * 100)) : 0;
      setProgressPct(pct);
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.artifactErrors ?? 0);
      setLiveMetricLabel("Frame Rate");
      setLiveMetricValue(`${p.fps.toFixed(1)} FPS`);
      if (p.gpuTempC != null) setPeakTemp((prev) => Math.max(prev ?? 0, p.gpuTempC!));
      setChartUnit("FPS");
      setChartPoints((prev) => [...prev.slice(-80), p.fps]);
    }).then((fn) => unsubs.push(fn));

    listen<RamTestProgress>("ram:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(p.patternName);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.errorsFound);
      setLiveMetricLabel("RAM Speed");
      setLiveMetricValue(`${p.bandwidthGbS.toFixed(1)} GB/s`);
      setChartUnit("GB/s");
      setChartPoints((prev) => [...prev.slice(-80), p.bandwidthGbS]);
    }).then((fn) => unsubs.push(fn));

    listen<VramTestProgress>("vram:progress", (ev) => {
      const p = ev.payload;
      setPhaseText(`VRAM Pass ${p.passNumber}`);
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.errorsFound);
      setLiveMetricLabel("VRAM Speed");
      setLiveMetricValue(`${p.bandwidthGbS.toFixed(1)} GB/s`);
      if (p.gpuTempC != null) setPeakTemp((prev) => Math.max(prev ?? 0, p.gpuTempC!));
      setChartUnit("GB/s");
      setChartPoints((prev) => [...prev.slice(-80), p.bandwidthGbS]);
    }).then((fn) => unsubs.push(fn));

    listen<PowerTortureProgress>("torture:progress", (ev) => {
      const p = ev.payload;
      setPhaseText("CPU + GPU + RAM");
      setProgressPct(Math.round(p.percent));
      setElapsedSecs(p.elapsedSecs);
      setErrorsCount(p.artifactErrors ?? 0);
      setLiveMetricLabel("Combined FPS");
      setLiveMetricValue(`${p.gpuFps.toFixed(1)} FPS`);
      const t = Math.max(p.telemetry?.cpuTempC ?? 0, p.telemetry?.gpuTempC ?? 0);
      if (t > 0) setPeakTemp((prev) => Math.max(prev ?? 0, t));
      setChartUnit("FPS");
      setChartPoints((prev) => [...prev.slice(-80), p.gpuFps]);
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
    setErrorsCount(0);
    setProgressPct(0);
    setElapsedSecs(0);
    setPeakTemp(null);
    setChartPoints([]);
    onRunningChange?.(true, `Stress Lab: ${target.toUpperCase()}`);

    try {
      if (target === "cpu") {
        setPhaseText("Starting CPU SIMD & Multi-Core Load...");
        const res = await invoke<PerfBenchResult>("run_performance_benchmark", {
          preset: durationPreset,
          manufacturer: specs?.manufacturer ?? null,
          model: specs?.model ?? null,
        });
        onCpuComplete?.(res);
        setSummaryBanner({
          status: res.status === "fail" ? "fail" : res.status === "warn" ? "warn" : "pass",
          headline: `CPU Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — Composite ${res.compositeScore}`,
          detail: res.plainSummary || res.summary,
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
          headline: `GPU Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — Avg ${res.avgFps.toFixed(1)} FPS`,
          detail: res.plainSummary || res.summary,
        });
      } else if (target === "memory") {
        setPhaseText("Starting TestMem5 Multi-Thread RAM Stress...");
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
          headline: `Memory Stress ${res.cancelled ? "Stopped" : res.status.toUpperCase()} — ${res.errorsFound} Errors (${res.totalGbVerified.toFixed(1)} GB verified)`,
          detail: res.plainSummary || res.summary,
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
        });
      } else {
        setPhaseText("Starting Combined CPU + GPU + RAM Power Stress...");
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
        });
      }
    } catch (e) {
      setSummaryBanner({
        status: "fail",
        headline: "Stress Test Error",
        detail: String(e),
      });
    } finally {
      setRunning(false);
      onRunningChange?.(false, null);
    }
  };

  const stopStress = async () => {
    const map: Record<StressTarget, string> = {
      cpu: "cancel_performance_benchmark",
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
          <h1 className="text-2xl font-bold text-black tracking-tight">Stress Tests</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Hardware-safe CPU, GPU, Memory &amp; Power stability testing with automatic thermal cutoff.
          </p>
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-zinc-200 bg-white text-xs font-medium text-zinc-700">
          <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
          Thermal Guard: {thermalCutoff}°C
        </div>
      </div>

      {/* OCCT-Style Target Selector Pills */}
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
              className={`rounded-lg border p-3.5 text-left transition cursor-pointer disabled:opacity-50 ${
                active
                  ? "border-blue-600 bg-blue-50/50 shadow-xs"
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

      {/* Focused Control Card */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Duration */}
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-zinc-500">Duration</div>
              <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
                {(
                  [
                    ["quick", "Quick (1m)"],
                    ["standard", "Standard (2-3m)"],
                    ["burnin", "Long (5m+)"],
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
              <div className="text-[11px] font-semibold text-zinc-500">Max Temp Cutoff</div>
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

            {/* RAM % (only when Memory selected) */}
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

          {/* Big Primary Action Button */}
          <div>
            {running ? (
              <button
                type="button"
                onClick={stopStress}
                className="px-7 py-3 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-sm flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-4 h-4 fill-white" />
                Stop Test
              </button>
            ) : (
              <button
                type="button"
                onClick={startStress}
                className="px-7 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center gap-2 shadow-sm cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" />
                Start {TARGETS.find((t) => t.id === target)?.label} Stress
              </button>
            )}
          </div>
        </div>

        {/* Clean Progress Bar when running */}
        {(running || progressPct > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-black">{phaseText}</span>
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

        {/* 4 Clean Big Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Errors Found</div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1 ${errorsCount > 0 ? "text-black underline" : "text-blue-600"}`}>
              {errorsCount}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Elapsed</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {elapsedSecs.toFixed(0)}s
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">{liveMetricLabel}</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {liveMetricValue}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-3.5">
            <div className="text-[11px] font-medium text-zinc-500">Temperature</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {peakTemp != null
                ? `${peakTemp.toFixed(0)}°C`
                : currentTemp != null
                ? `${currentTemp.toFixed(0)}°C`
                : "—"}
            </div>
          </div>
        </div>

        {/* Live Chart */}
        {chartPoints.length > 1 && (
          <div className="pt-1">
            <LiveChart
              title={`${TARGETS.find((t) => t.id === target)?.label} Stability`}
              data={chartPoints}
              unit={chartUnit}
              height={165}
            />
          </div>
        )}

        {/* Single Plain-English Result Banner */}
        {summaryBanner && (
          <div
            className={`rounded-lg border p-4 flex items-center justify-between gap-3 ${
              summaryBanner.status === "fail"
                ? "border-black bg-black text-white"
                : "border-blue-200 bg-blue-50/50 text-black"
            }`}
          >
            <div>
              <div className="text-sm font-bold">{summaryBanner.headline}</div>
              <div className={`text-xs mt-0.5 ${summaryBanner.status === "fail" ? "text-zinc-200" : "text-zinc-600"}`}>
                {summaryBanner.detail}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
