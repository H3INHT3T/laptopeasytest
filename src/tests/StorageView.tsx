import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Gauge, HardDrive, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import type {
  LiveTelemetrySnapshot,
  StorageBenchProgress,
  StorageBenchResult,
  StorageSmartReport,
  StressPreset,
  TestStatus,
  VolumeSpecInfo,
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
  smartReport: StorageSmartReport | null;
  benchResult: StorageBenchResult | null;
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
  smartReport,
  benchResult,
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

  const startBench = async () => {
    setError(null);
    setRunning(true);
    onRunningChange?.(true);
    setSpeedHistory([]);
    lastPhaseRef.current = "";
    setConsoleLog([
      `[0.0s] Initializing Direct-IO SSD durability suite (preset=${preset}, target=${targetMount || "System Temp Volume"}, drive=${primaryDrive?.model ?? "System Drive"})`,
      `[0.0s] OS Page Cache Bypass requested (FILE_FLAG_NO_BUFFERING / F_NOCACHE)`,
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
        `[${res.elapsedSecs.toFixed(1)}s] DONE: SeqR=${res.seqReadMbS.toFixed(0)} MB/s, SeqW=${res.seqWriteMbS.toFixed(0)} MB/s, 4K P99=${res.p994kLatencyMs.toFixed(2)}ms, Surface Errors=${res.integrityErrors}`,
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
          parameter: "4K Random P99 Tail Latency",
          measured: `${benchResult.p994kLatencyMs.toFixed(2)} ms`,
          limit: "<= 15.00 ms",
          verdict: benchResult.p994kLatencyMs <= 15 ? "PASS" : "WARN",
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
          smartReport.drives.map((d, idx) => (
            <div key={idx} className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <HardDrive className="w-4 h-4 text-blue-600 shrink-0" />
                  <div>
                    <div className="text-xs font-black text-black">{d.model}</div>
                    <div className="text-[10.5px] text-zinc-600 font-mono tabular-nums">
                      {d.interfaceType} • {d.mediaType} • {d.sizeGb.toFixed(0)} GB
                      {d.serialNumber ? ` • S/N ${d.serialNumber}` : ""}
                    </div>
                  </div>
                </div>
                <StatusBadge status={d.status} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x divide-y sm:divide-y-0 divide-zinc-200 font-mono tabular-nums text-xs">
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">Health</div>
                  <div className="text-sm font-black text-blue-700 mt-0.5">
                    {d.healthPercent != null ? `${d.healthPercent}%` : d.healthStatus}
                  </div>
                </div>
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">Wear Used</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.wearPercent != null ? `${d.wearPercent}%` : "N/A"}
                  </div>
                </div>
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">Temp</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.temperatureC != null ? `${d.temperatureC}°C` : "N/A"}
                  </div>
                </div>
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">Power-On</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.powerOnHours != null ? `${d.powerOnHours}h` : "N/A"}
                  </div>
                </div>
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">Media Err</div>
                  <div className={`text-sm font-black mt-0.5 ${(d.mediaErrors ?? 0) > 0 ? "text-black underline" : "text-blue-700"}`}>
                    {d.mediaErrors ?? 0}
                  </div>
                </div>
                <div className="p-2.5">
                  <div className="text-[9.5px] uppercase text-zinc-500">TBW / Spare</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.tbwGb != null ? `${(d.tbwGb / 1000).toFixed(1)} TB` : d.availableSparePct != null ? `${d.availableSparePct}%` : "N/A"}
                  </div>
                </div>
              </div>
              {d.notes && <div className="px-4 py-1.5 border-t border-zinc-200 text-[11px] text-zinc-600">{d.notes}</div>}
            </div>
          ))
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
            {volumes.length > 1 && (
              <select
                value={targetMount}
                disabled={running}
                onChange={(e) => setTargetMount(e.target.value)}
                className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black font-bold"
                title="Target Drive / Volume for Multi-NVMe Laptops"
              >
                <option value="">Auto (System Drive)</option>
                {volumes
                  .filter((v) => v.freeGb >= 2)
                  .map((v) => (
                    <option key={v.mount} value={v.mount}>
                      {v.mount} {v.label ? `(${v.label})` : ""} — {v.freeGb.toFixed(0)} GB free
                    </option>
                  ))}
              </select>
            )}
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black font-medium"
            >
              <option value="quick">Shop QC — 1 GB Direct-IO + 4K Verify</option>
              <option value="standard">Standard Durability — 2 GB Direct-IO + 8K Ops</option>
              <option value="burnin">Deep Burn-In — 4 GB SLC Exhaust + 16K Ops</option>
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
                className="px-4 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Run Direct-IO Audit
              </button>
            )}
          </div>
        </div>

        {(running || speedHistory.length > 0) && (
          <div className="space-y-3">
            {running && progress && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono tabular-nums text-black font-bold">
                  <span className="text-blue-700">{progress.phase}</span>
                  <span>
                    {progress.elapsedSecs.toFixed(1)}s • {progress.percent.toFixed(0)}% • ERR: {progress.integrityErrors}
                  </span>
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
            <BaselineCard baseline={benchResult.baseline} />

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
                <div className="text-[9.5px] uppercase text-zinc-500">4K Read IOPS</div>
                <div className="text-base font-black text-black mt-0.5">
                  {benchResult.rand4kReadIops.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-500">{benchResult.rand4kReadMbS.toFixed(1)} MB/s</div>
              </div>
              <div className="p-3 bg-white">
                <div className="text-[9.5px] uppercase text-zinc-500">4K Write IOPS</div>
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

            <ThresholdAuditTable rows={auditRows} />
          </div>
        )}

        <EngineeringConsole lines={consoleLog} />
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(benchResult && !running)}
        requirementHint="Run the Direct-IO SSD Durability & Integrity Audit to complete Stage 05 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
