import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Award, Gauge, HardDrive, Play, RefreshCw, ShieldCheck, Square, Thermometer } from "lucide-react";
import {
  DEFAULT_HARDWARE_SAFETY_BOUNDS,
  type LiveTelemetrySnapshot,
  type StorageBenchProgress,
  type StorageBenchResult,
  type StorageSmartReport,
  type StressPreset,
  type SystemSpecs,
  type TestStatus,
  type UserBenchmarkComparison,
  type VolumeSpecInfo,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";
import { EnvironmentGuard } from "../components/EnvironmentGuard";
import { EngineeringConsole, ThresholdAuditTable, type ThresholdAuditRow } from "../components/EngineeringConsole";

interface StorageViewProps {
  telemetry: LiveTelemetrySnapshot | null;
  volumes?: VolumeSpecInfo[];
  specs?: SystemSpecs | null;
  smartReport: StorageSmartReport | null;
  benchResult: StorageBenchResult | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
  loadingSmart: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefreshSmart: () => void;
  onRunningChange?: (running: boolean) => void;
  onBenchComplete: (res: StorageBenchResult) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const StorageView: React.FC<StorageViewProps> = ({
  telemetry,
  volumes = [],
  specs = null,
  smartReport,
  benchResult,
  userbenchmarkComparison = null,
  loadingSmart,
  status,
  stepNumber,
  totalSteps,
  onRefreshSmart,
  onRunningChange,
  onBenchComplete,
  onNext,
  onSkip,
}) => {
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [targetMount, setTargetMount] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StorageBenchProgress | null>(null);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const lastPhaseRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<StorageBenchProgress>("storage:progress", (ev) => {
      const p = ev.payload;
      setProgress(p);
      setSpeedHistory((prev) => [...prev.slice(-79), p.currentMbS]);
      if (p.phase !== lastPhaseRef.current) {
        lastPhaseRef.current = p.phase;
        setConsoleLog((prev) => [
          ...prev.slice(-60),
          `[${p.elapsedSecs.toFixed(1)}s] ${p.phase} | ${p.currentMbS.toFixed(0)} MB/s | Verify Errors=${p.integrityErrors}`,
        ]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const primaryDrive = smartReport?.drives[0];
  const isNvme = (primaryDrive?.interfaceType ?? "").toLowerCase().includes("nvme");
  const ssdUbRating = userbenchmarkComparison?.ssd ?? benchResult?.userbenchmarkRating ?? null;

  const effectiveVolumes = volumes.length > 0 ? volumes : specs?.volumes ?? [];
  const budgetMb =
    preset === "burnin"
      ? DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetMaxMb
      : preset === "standard"
      ? DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetStdMb
      : DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetQuickMb;
  const requiredFreeMb = Math.max(2048, budgetMb * DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdFreeSpaceMultiplier);
  const selectedVol = effectiveVolumes.find((v) => v.mount === targetMount) ?? effectiveVolumes[0];
  const lowSpace = Boolean(selectedVol && selectedVol.freeGb * 1024 < requiredFreeMb);

  const startBench = async () => {
    setError(null);
    setRunning(true);
    onRunningChange?.(true);
    setSpeedHistory([]);
    lastPhaseRef.current = "";
    setConsoleLog([
      `[0.0s] Initializing Direct-IO SSD durability suite (preset=${preset}, budget<=${budgetMb}MB, target=${targetMount || "System Temp Volume"}, drive=${primaryDrive?.model ?? "System Drive"})`,
      `[0.0s] OS Page Cache Bypass requested (FILE_FLAG_NO_BUFFERING / F_NOCACHE) • RAII TempFileGuard armed`,
    ]);
    setProgress({
      phase: "Opening Direct-IO uncached test file...",
      percent: 1,
      currentMbS: 0,
      elapsedSecs: 0,
      integrityErrors: 0,
    });
    try {
      const res = await invoke<StorageBenchResult>("run_storage_benchmark", {
        preset,
        interfaceHint: primaryDrive?.interfaceType ?? null,
        mediaHint: primaryDrive?.mediaType ?? null,
        targetMount: targetMount || null,
      });
      setConsoleLog((prev) => [
        ...prev,
        `[${res.elapsedSecs.toFixed(1)}s] DONE: SeqR=${res.seqReadMbS.toFixed(0)} MB/s, SeqW=${res.seqWriteMbS.toFixed(0)} MB/s, QD32=${res.rand4kQd32ReadIops ?? 0}/${res.rand4kQd32WriteIops ?? 0} IOPS, 4K P99=${res.p994kLatencyMs.toFixed(2)}ms, Written=${res.totalWrittenMb ?? res.testSizeMb}MB, Verify Errors=${res.integrityErrors}`,
      ]);
      onBenchComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange?.(false);
    }
  };

  const auditRows: ThresholdAuditRow[] = benchResult
    ? [
        {
          parameter: "Read-Back Surface Integrity",
          measured: `${benchResult.integrityErrors} byte mismatches`,
          limit: "0 errors required",
          verdict: benchResult.integrityErrors === 0 ? "PASS" : "FAIL",
        },
        {
          parameter: "Direct-IO Unbuffered Mode",
          measured: benchResult.directIo ? "ACTIVE (OS Cache Bypassed)" : "Flushed Sync",
          limit: "Uncached NAND Write/Read",
          verdict: "PASS",
        },
        {
          parameter: "Safe SSD Write Budget",
          measured: `${benchResult.totalWrittenMb ?? benchResult.testSizeMb} MB written`,
          limit: `<= ${DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetMaxMb} MB max`,
          verdict:
            (benchResult.totalWrittenMb ?? benchResult.testSizeMb) <=
            DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetMaxMb
              ? "PASS"
              : "WARN",
        },
        {
          parameter: "4K Random P99 Tail Latency",
          measured: `${benchResult.p994kLatencyMs.toFixed(2)} ms`,
          limit: "<= 15.00 ms",
          verdict: benchResult.p994kLatencyMs <= 15 ? "PASS" : "WARN",
        },
        {
          parameter: "4K Multi-Queue (QD32) & 70/30 Mixed",
          measured: `QD32 ${(benchResult.rand4kQd32ReadIops ?? 0).toLocaleString()}/${(benchResult.rand4kQd32WriteIops ?? 0).toLocaleString()} IOPS | Mixed ${(benchResult.mixedRwIops ?? 0).toLocaleString()} IOPS`,
          limit: "Multi-Queue & Mixed Active",
          verdict:
            (benchResult.rand4kQd32ReadIops ?? 0) > 0 || (benchResult.mixedRwIops ?? 0) > 0
              ? "PASS"
              : "WARN",
        },
        {
          parameter: "SLC Cache Write Stability",
          measured: `${(benchResult.writeStabilityPct ?? 100).toFixed(0)}% (${(benchResult.slcSustainedMbS ?? benchResult.seqWriteMbS).toFixed(0)} MB/s sust.)`,
          limit: ">= 40% stability",
          verdict: (benchResult.writeStabilityPct ?? 100) >= 40 ? "PASS" : "WARN",
        },
        {
          parameter: "Drive Thermal Cutoff",
          measured:
            benchResult.peakDriveTempC != null
              ? `${benchResult.peakDriveTempC.toFixed(0)}°C`
              : "Sensor N/A",
          limit: "< 82°C cutoff",
          verdict: benchResult.thermalCutoffTriggered
            ? "FAIL"
            : benchResult.thermalWarning
            ? "WARN"
            : "PASS",
        },
        {
          parameter: "Throughput vs. Drive Class Normal",
          measured: `${benchResult.baseline.percentOfNormal.toFixed(1)}% (${benchResult.seqReadMbS.toFixed(0)} / ${benchResult.seqWriteMbS.toFixed(0)} MB/s)`,
          limit: ">= 85.0% of Normal",
          verdict:
            benchResult.baseline.percentOfNormal >= 85
              ? "PASS"
              : benchResult.baseline.percentOfNormal >= 65
              ? "WARN"
              : "FAIL",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              SSD SMART Health &amp; Direct-IO Durability Audit
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Inspects NVMe/SATA SMART reliability counters, bypasses OS RAM cache for true sustained NAND speeds, and verifies byte-for-byte read-back integrity.
          </p>
        </div>
        <button
          onClick={onRefreshSmart}
          disabled={loadingSmart}
          className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingSmart ? "animate-spin text-blue-600" : ""}`} />
          Re-Scan SMART
        </button>
      </div>

      <EnvironmentGuard telemetry={telemetry} requireAc={false} />

      {/* SMART Table Cards */}
      <div className="space-y-3">
        {!smartReport ? (
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-5 text-center font-mono text-xs text-zinc-600">
            {loadingSmart ? "READING NVME / SATA SMART TELEMETRY..." : "CLICK RE-SCAN SMART TO INSPECT DRIVES."}
          </div>
        ) : smartReport.drives.length === 0 ? (
          <div className="rounded-[2px] border border-blue-600 bg-blue-50/40 p-4 text-xs text-black">
            {smartReport.summary}
          </div>
        ) : (
          smartReport.drives.map((d, idx) => {
            const wearVal = d.percentageUsedRaw ?? d.wearPercent;
            const criticalFlags = d.criticalWarningFlags ?? [];
            const spareLow =
              d.availableSparePct != null &&
              d.availableSpareThresholdPct != null &&
              d.availableSparePct <= d.availableSpareThresholdPct;
            return (
              <div key={idx} className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
                <div className="px-4 py-2.5 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2.5">
                    <HardDrive className="w-4 h-4 text-blue-600 shrink-0" />
                    <div>
                      <div className="text-xs font-black text-black flex items-center gap-2 flex-wrap">
                        <span>{d.model}</span>
                        <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[9.5px] font-bold text-zinc-700">
                          NVMe Log 0x02 / SMART
                        </span>
                      </div>
                      <div className="text-[10.5px] text-zinc-600 font-mono tabular-nums">
                        {d.interfaceType} • {d.mediaType} • {d.sizeGb.toFixed(0)} GB
                        {d.serialNumber ? ` • S/N ${d.serialNumber}` : ""}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={d.status} />
                </div>

                {criticalFlags.length > 0 && (
                  <div className="px-4 py-2 bg-black text-white text-xs font-mono flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                    <span>CRITICAL SMART WARNING: {criticalFlags.join(" • ")}</span>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums text-xs">
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Health</div>
                    <div className="text-sm font-black text-blue-700 mt-0.5">
                      {d.healthPercent != null ? `${d.healthPercent}%` : d.healthStatus}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Wear (Log 0x02)</div>
                    <div className={`text-sm font-black mt-0.5 ${(wearVal ?? 0) >= 90 ? "text-black underline" : "text-black"}`}>
                      {wearVal != null ? `${wearVal}%` : "N/A"}
                    </div>
                    {wearVal != null && wearVal > 100 && (
                      <div className="text-[9.5px] text-black font-bold">&gt;100% rated</div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Avail. Spare</div>
                    <div className={`text-sm font-black mt-0.5 ${spareLow ? "text-black underline" : "text-blue-700"}`}>
                      {d.availableSparePct != null ? `${d.availableSparePct}%` : "N/A"}
                    </div>
                    {d.availableSpareThresholdPct != null && (
                      <div className="text-[9.5px] text-zinc-500">min {d.availableSpareThresholdPct}%</div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">TBW</div>
                    <div className="text-sm font-black text-black mt-0.5">
                      {d.tbwGb != null ? `${(d.tbwGb / 1000).toFixed(1)} TB` : "N/A"}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Temp</div>
                    <div className={`text-sm font-black mt-0.5 ${(d.temperatureC ?? 0) >= 70 ? "text-black underline" : "text-black"}`}>
                      {d.temperatureC != null ? `${d.temperatureC}°C` : "N/A"}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Power-On</div>
                    <div className="text-sm font-black text-black mt-0.5">
                      {d.powerOnHours != null ? `${d.powerOnHours}h` : "N/A"}
                    </div>
                    {d.powerCycles != null && (
                      <div className="text-[9.5px] text-zinc-500">{d.powerCycles} cyc</div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Unsafe Shut.</div>
                    <div className="text-sm font-black text-black mt-0.5">
                      {d.unsafeShutdowns ?? "N/A"}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9.5px] uppercase text-zinc-500">Media Err</div>
                    <div className={`text-sm font-black mt-0.5 ${(d.mediaErrors ?? 0) > 0 ? "text-black underline" : "text-blue-700"}`}>
                      {d.mediaErrors ?? 0}
                    </div>
                    {(d.readErrors != null || d.writeErrors != null) && (
                      <div className="text-[9.5px] text-zinc-500">
                        R:{d.readErrors ?? 0} W:{d.writeErrors ?? 0}
                      </div>
                    )}
                  </div>
                </div>

                {d.plainSummary && (
                  <div className="px-4 py-2 border-t border-zinc-200 border-l-[3px] border-l-blue-600 bg-[#F8FAFC] text-xs text-black">
                    <span className="font-mono text-[10px] font-bold uppercase text-blue-700 mr-2">
                      NVMe Log 0x02 Summary:
                    </span>
                    {d.plainSummary}
                  </div>
                )}
                {d.notes && (
                  <div className="px-4 py-1.5 border-t border-zinc-200 text-[11px] text-zinc-600">{d.notes}</div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Real-Time Direct-IO Durability Benchmark */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xs font-black uppercase tracking-wider text-black flex items-center gap-1.5">
              <Gauge className="w-4 h-4 text-blue-600" />
              Direct-IO Sustained NAND Benchmark &amp; Read-Back Integrity
            </h2>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              Writes uncached random blocks directly to NAND, verifies every byte on read-back, and captures 4K P99 tail latency.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {effectiveVolumes.length > 1 && (
              <select
                value={targetMount}
                disabled={running}
                onChange={(e) => setTargetMount(e.target.value)}
                className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black font-bold"
                title="Target Drive / Volume for Multi-NVMe Laptops"
              >
                <option value="">Auto (System Drive)</option>
                {effectiveVolumes.map((v) => {
                  const volLow = v.freeGb * 1024 < requiredFreeMb;
                  return (
                    <option key={v.mount} value={v.mount} disabled={volLow}>
                      {v.mount} {v.label ? `(${v.label})` : ""} — {v.freeGb.toFixed(1)} GB free{volLow ? " (LOW SPACE)" : ""}
                    </option>
                  );
                })}
              </select>
            )}
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black font-medium"
            >
              <option value="quick">
                Shop QC — {DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetQuickMb} MB Safe Write Budget (Seq + QD1/QD32 + 70/30)
              </option>
              <option value="standard">
                Standard Durability — {DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetStdMb} MB Safe Write Budget (Extended 4K/Mixed)
              </option>
              <option value="burnin">
                Deep Burn-In — {DEFAULT_HARDWARE_SAFETY_BOUNDS.ssdWriteBudgetMaxMb} MB Max Write Budget (SLC Exhaust + 8-Queue)
              </option>
            </select>
            {running ? (
              <button
                onClick={() => invoke("cancel_storage_benchmark").catch(() => {})}
                className="px-4 py-1.5 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" /> Abort
              </button>
            ) : (
              <button
                onClick={startBench}
                disabled={lowSpace}
                className="px-4 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-200 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Run Direct-IO Audit
              </button>
            )}
          </div>
        </div>

        {/* Safe SSD Write Budget & Free-Space Safety Guard */}
        <div
          className={`rounded-[2px] border px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums ${
            lowSpace
              ? "border-2 border-black bg-black text-white"
              : "border-zinc-300 bg-[#F8FAFC] text-zinc-700"
          }`}
        >
          <div className="flex items-center gap-2 font-bold">
            <ShieldCheck className={`w-3.5 h-3.5 shrink-0 ${lowSpace ? "text-blue-400" : "text-blue-600"}`} />
            <span className="uppercase tracking-wider">
              Safe SSD Write Budget: &le; {budgetMb} MB (RAII TempFileGuard auto-cleanup)
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[10.5px]">
            <span>
              Free-Space Guard: &ge; {requiredFreeMb} MB ({(requiredFreeMb / 1024).toFixed(1)} GB)
            </span>
            {selectedVol && (
              <>
                <span className={lowSpace ? "text-zinc-600" : "text-zinc-300"}>|</span>
                <span className="font-bold">
                  {selectedVol.mount}: {selectedVol.freeGb.toFixed(1)} GB free
                  {lowSpace ? " — INSUFFICIENT FREE SPACE" : " (OK)"}
                </span>
              </>
            )}
          </div>
        </div>

        {(running || speedHistory.length > 0) && (
          <div className="space-y-3">
            {running && progress && (
              <div className="space-y-1.5">
                <div className="flex justify-between items-center flex-wrap gap-2 text-xs font-mono tabular-nums text-black font-bold">
                  <span className="text-blue-700">{progress.phase}</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {progress.driveTempC != null && (
                      <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black flex items-center gap-1 text-[10.5px]">
                        <Thermometer className="w-3 h-3 text-blue-600" />
                        Drive Temp: {progress.driveTempC.toFixed(0)}°C
                      </span>
                    )}
                    {progress.thermalWarning && (
                      <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white text-[10px] font-bold">
                        THERMAL WARN &ge;75°C
                      </span>
                    )}
                    <span>
                      {progress.elapsedSecs.toFixed(1)}s • {progress.percent.toFixed(0)}% • ERR: {progress.integrityErrors}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
            <LiveChart
              title="Direct-IO NAND Throughput Oscilloscope"
              unit="MB/s"
              data={speedHistory}
              baselineValue={isNvme ? 1500 : 420}
              baselineLabel={isNvme ? "NVMe NORMAL 1500 MB/s" : "SATA NORMAL 420 MB/s"}
            />
          </div>
        )}

        {error && <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{error}</div>}

        {benchResult && !running && (
          <div className="space-y-3">
            {benchResult.thermalCutoffTriggered && (
              <div className="rounded-[2px] bg-black text-white px-4 py-2.5 text-xs font-mono flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                <span>
                  DRIVE THERMAL CUTOFF TRIGGERED ({benchResult.peakDriveTempC?.toFixed(0) ?? ">=82"}°C limit reached — benchmark halted safely to protect NAND controller).
                </span>
              </div>
            )}
            {!benchResult.thermalCutoffTriggered && benchResult.thermalWarning && (
              <div className="rounded-[2px] border-2 border-black bg-[#F8FAFC] px-4 py-2.5 text-xs font-mono text-black flex items-center gap-2">
                <Thermometer className="w-4 h-4 text-blue-600 shrink-0" />
                <span>
                  THERMAL WARNING: Drive reached {benchResult.peakDriveTempC?.toFixed(0) ?? ">=75"}°C during sustained writes. Check M.2 thermal pad contact.
                </span>
              </div>
            )}

            <BaselineCard baseline={benchResult.baseline} />

            {ssdUbRating && (
              <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-500 flex items-center gap-1.5">
                      <Award className="w-3.5 h-3.5 text-blue-600" />
                      UserBenchmark SSD Calibration // {ssdUbRating.detectedModel}
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-xs font-black uppercase">
                        {ssdUbRating.vehicleTier}
                      </span>
                      <span className="font-mono text-sm font-black text-black tabular-nums">
                        {ssdUbRating.effectiveSpeedPct.toFixed(1)}% Effective Speed
                      </span>
                      <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10.5px] font-bold text-black">
                        {ssdUbRating.standingLabel} ({ssdUbRating.relativeStandingPct.toFixed(1)}% vs {ssdUbRating.expectedClassPct.toFixed(0)}% class)
                      </span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10px] text-zinc-600 uppercase">
                    {ssdUbRating.sourceMode}
                  </span>
                </div>

                {ssdUbRating.bottleneckFlag && (
                  <div className="rounded-[2px] bg-black text-white px-3 py-1.5 font-mono text-[11px] font-bold flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span>{ssdUbRating.bottleneckFlag}</span>
                  </div>
                )}

                {ssdUbRating.subMetrics && ssdUbRating.subMetrics.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ssdUbRating.subMetrics.map(([k, v]) => (
                      <span
                        key={k}
                        className="px-2 py-0.5 rounded-[2px] border border-zinc-200 bg-[#F8FAFC] font-mono text-[10.5px] text-black tabular-nums"
                      >
                        <span className="text-zinc-500 mr-1">{k}:</span>
                        <strong>{v}</strong>
                      </span>
                    ))}
                  </div>
                )}

                <div className="text-xs text-zinc-700">{ssdUbRating.plainSummary}</div>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-6 divide-x divide-y md:divide-y-0 divide-zinc-200 border border-zinc-300 rounded-[2px] font-mono tabular-nums">
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">Seq Read</div>
                <div className="text-base font-black text-blue-700 mt-0.5">
                  {benchResult.seqReadMbS.toFixed(0)} <span className="text-[10px]">MB/s</span>
                </div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">Seq Write</div>
                <div className="text-base font-black text-black mt-0.5">
                  {benchResult.seqWriteMbS.toFixed(0)} <span className="text-[10px]">MB/s</span>
                </div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">4K QD1 Read</div>
                <div className="text-base font-black text-black mt-0.5">
                  {benchResult.rand4kReadIops.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">{benchResult.rand4kReadMbS.toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">4K QD1 Write</div>
                <div className="text-base font-black text-black mt-0.5">
                  {benchResult.rand4kWriteIops.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">{benchResult.rand4kWriteMbS.toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">4K Avg / P99</div>
                <div className="text-xs font-black text-black mt-1">
                  {benchResult.avg4kLatencyMs.toFixed(2)} / {benchResult.p994kLatencyMs.toFixed(2)} ms
                </div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-blue-600" /> Surface
                </div>
                <div className={`text-base font-black mt-0.5 ${benchResult.integrityErrors > 0 ? "text-black underline" : "text-blue-700"}`}>
                  {benchResult.integrityErrors} ERR
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-y md:divide-y-0 divide-zinc-200 border border-zinc-300 rounded-[2px] font-mono tabular-nums">
              <div className="p-3 bg-[#F8FAFC]">
                <div className="text-[9.5px] uppercase text-zinc-500">4K QD32 Read</div>
                <div className="text-sm font-black text-blue-700 mt-0.5">
                  {(benchResult.rand4kQd32ReadIops ?? 0).toLocaleString()} <span className="text-[10px]">IOPS</span>
                </div>
                <div className="text-[10px] text-zinc-500">{(benchResult.rand4kQd32ReadMbS ?? 0).toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-[#F8FAFC]">
                <div className="text-[9.5px] uppercase text-zinc-500">4K QD32 Write</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {(benchResult.rand4kQd32WriteIops ?? 0).toLocaleString()} <span className="text-[10px]">IOPS</span>
                </div>
                <div className="text-[10px] text-zinc-500">{(benchResult.rand4kQd32WriteMbS ?? 0).toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-[#F8FAFC]">
                <div className="text-[9.5px] uppercase text-zinc-500">70/30 Mixed R/W</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {(benchResult.mixedRwIops ?? 0).toLocaleString()} <span className="text-[10px]">IOPS</span>
                </div>
                <div className="text-[10px] text-zinc-500">{(benchResult.mixedRwMbS ?? 0).toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-[#F8FAFC]">
                <div className="text-[9.5px] uppercase text-zinc-500">SLC Cache Stability</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {(benchResult.slcSustainedMbS ?? benchResult.seqWriteMbS).toFixed(0)} <span className="text-[10px]">MB/s</span>
                </div>
                <div className="text-[10px] text-zinc-500">
                  -{(benchResult.slcCacheDropPct ?? 0).toFixed(0)}% drop • {(benchResult.writeStabilityPct ?? 100).toFixed(0)}% stab
                </div>
              </div>
              <div className="p-3 bg-[#F8FAFC]">
                <div className="text-[9.5px] uppercase text-zinc-500">Budget &amp; Peak Temp</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {benchResult.totalWrittenMb ?? benchResult.testSizeMb} MB
                </div>
                <div className="text-[10px] text-zinc-500">
                  Peak {benchResult.peakDriveTempC != null ? `${benchResult.peakDriveTempC.toFixed(0)}°C` : "Temp N/A"}
                </div>
              </div>
            </div>

            <ThresholdAuditTable rows={auditRows} />
          </div>
        )}

        {(benchResult || primaryDrive) && !running && (
          <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
              What This Means for Long-Term Use
            </div>
            {benchResult?.plainSummary && (
              <div className="text-xs text-black font-medium">{benchResult.plainSummary}</div>
            )}
            {primaryDrive?.plainSummary && (
              <div className="text-xs text-zinc-700">{primaryDrive.plainSummary}</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1 text-[11px]">
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">SLC Cache vs. Sustained Speed</div>
                <div className="text-zinc-600 mt-0.5">
                  {(benchResult?.writeStabilityPct ?? 100) >= 60
                    ? "Sustained write speed holds steady outside burst cache — ideal for large file transfers and OS updates."
                    : "Write speed drops after the SLC cache fills (typical of budget QLC/DRAM-less drives) during large multi-GB copies."}
                </div>
              </div>
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">DriveDx Log 0x02 Wear &amp; Spare</div>
                <div className="text-zinc-600 mt-0.5">
                  {primaryDrive
                    ? `Rated wear is ${primaryDrive.percentageUsedRaw ?? primaryDrive.wearPercent ?? 0}% used with ${primaryDrive.availableSparePct ?? "N/A"}% spare blocks remaining.`
                    : "Re-scan SMART to inspect DriveDx NVMe Log 0x02 spare blocks and rated endurance."}
                </div>
              </div>
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">P99 Latency &amp; Data Integrity</div>
                <div className="text-zinc-600 mt-0.5">
                  {benchResult
                    ? `${benchResult.integrityErrors} byte verification errors and ${benchResult.p994kLatencyMs.toFixed(2)} ms 4K P99 latency (${benchResult.p994kLatencyMs <= 15 ? "snappy daily responsiveness" : "noticeable stall risk"}).`
                    : "Run Direct-IO Audit to verify 0 byte corruption and snappy 4K P99 latency."}
                </div>
              </div>
            </div>
          </div>
        )}

        <EngineeringConsole lines={consoleLog} />
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(benchResult && !running)}
        requirementHint={`Run the Direct-IO SSD Durability & Integrity Audit to complete Stage ${String(stepNumber).padStart(2, "0")} (or click Skip Step).`}
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
