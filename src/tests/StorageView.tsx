import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Gauge, HardDrive, Play, RefreshCw, Square } from "lucide-react";
import type {
  StorageBenchProgress,
  StorageBenchResult,
  StorageSmartReport,
  StressPreset,
  TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface StorageViewProps {
  smartReport: StorageSmartReport | null;
  benchResult: StorageBenchResult | null;
  loadingSmart: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefreshSmart: () => void;
  onBenchComplete: (res: StorageBenchResult) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const StorageView: React.FC<StorageViewProps> = ({
  smartReport,
  benchResult,
  loadingSmart,
  status,
  stepNumber,
  totalSteps,
  onRefreshSmart,
  onBenchComplete,
  onNext,
  onSkip,
}) => {
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StorageBenchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<StorageBenchProgress>("storage:progress", (ev) => {
      setProgress(ev.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startBench = async () => {
    setError(null);
    setRunning(true);
    setProgress({ phase: "Preparing temporary benchmark file...", percent: 2, currentMbS: 0 });
    try {
      const res = await invoke<StorageBenchResult>("run_storage_benchmark", { preset });
      onBenchComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              SSD Health (SMART) &amp; Deep Speed Benchmark
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            DriveDx-inspired NVMe/SATA SMART diagnostics plus non-destructive Sequential &amp; Random 4K Read/Write speed test.
          </p>
        </div>
        <button
          onClick={onRefreshSmart}
          disabled={loadingSmart}
          className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingSmart ? "animate-spin text-blue-600" : ""}`} />
          Re-scan SMART
        </button>
      </div>

      {/* SMART Cards */}
      <div className="space-y-3">
        {!smartReport ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center text-sm text-zinc-600">
            {loadingSmart ? "Reading NVMe/SATA SMART reliability counters..." : "Click Re-scan SMART to read drive health."}
          </div>
        ) : smartReport.drives.length === 0 ? (
          <div className="rounded-xl border border-blue-600 bg-blue-50 p-4 text-xs text-black">
            {smartReport.summary}
          </div>
        ) : (
          smartReport.drives.map((d, idx) => (
            <div key={idx} className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center">
                    <HardDrive className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-black">{d.model}</div>
                    <div className="text-xs text-zinc-500 font-mono">
                      {d.interfaceType} • {d.mediaType} • {d.sizeGb.toFixed(0)} GB
                      {d.serialNumber ? ` • S/N: ${d.serialNumber}` : ""}
                    </div>
                  </div>
                </div>
                <StatusBadge status={d.status} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 font-mono text-xs">
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">Health</div>
                  <div className="text-sm font-black text-blue-600 mt-0.5">
                    {d.healthPercent != null ? `${d.healthPercent}%` : d.healthStatus}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">Wear Used</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.wearPercent != null ? `${d.wearPercent}%` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">Temp</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.temperatureC != null ? `${d.temperatureC}°C` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">Power-On Hours</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.powerOnHours != null ? `${d.powerOnHours}h` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">Media Errors</div>
                  <div className={`text-sm font-black mt-0.5 ${(d.mediaErrors ?? 0) > 0 ? "text-black underline" : "text-blue-600"}`}>
                    {d.mediaErrors ?? 0}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-2.5">
                  <div className="text-[10px] text-zinc-500">TBW / Spare</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {d.tbwGb != null ? `${(d.tbwGb / 1000).toFixed(1)} TB` : d.availableSparePct != null ? `${d.availableSparePct}%` : "N/A"}
                  </div>
                </div>
              </div>
              <div className="text-xs text-zinc-600">{d.notes}</div>
            </div>
          ))
        )}
      </div>

      {/* Non-Destructive SSD Speed Benchmark */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-black flex items-center gap-2">
              <Gauge className="w-4 h-4 text-blue-600" />
              Non-Destructive SSD Speed Benchmark (Required Deep Test)
            </h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              Measures real Sequential &amp; Random 4K Read/Write using an auto-deleted temp file.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Quick QC (256 MB)</option>
              <option value="standard">Standard (512 MB)</option>
              <option value="burnin">Deep Burn-in (1 GB)</option>
            </select>
            {running ? (
              <button
                onClick={() => invoke("cancel_storage_benchmark").catch(() => {})}
                className="px-4 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" /> Cancel
              </button>
            ) : (
              <button
                onClick={startBench}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Run SSD Speed Test
              </button>
            )}
          </div>
        </div>

        {running && progress && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-mono text-black font-semibold">
              <span>{progress.phase}</span>
              <span>
                {progress.currentMbS.toFixed(0)} MB/s • {progress.percent.toFixed(0)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-zinc-200 overflow-hidden">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>
        )}

        {benchResult && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-[11px] text-zinc-500">Sequential Read</div>
              <div className="text-xl font-black text-blue-600 mt-1">
                {benchResult.seqReadMbS.toFixed(0)} <span className="text-xs">MB/s</span>
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-[11px] text-zinc-500">Sequential Write</div>
              <div className="text-xl font-black text-black mt-1">
                {benchResult.seqWriteMbS.toFixed(0)} <span className="text-xs">MB/s</span>
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-[11px] text-zinc-500">Random 4K Read</div>
              <div className="text-xl font-black text-black mt-1">
                {benchResult.rand4kReadIops.toLocaleString()} <span className="text-xs">IOPS</span>
              </div>
              <div className="text-[10px] text-zinc-500">{benchResult.rand4kReadMbS.toFixed(1)} MB/s</div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-[11px] text-zinc-500">Random 4K Write</div>
              <div className="text-xl font-black text-black mt-1">
                {benchResult.rand4kWriteIops.toLocaleString()} <span className="text-xs">IOPS</span>
              </div>
              <div className="text-[10px] text-zinc-500">{benchResult.rand4kWriteMbS.toFixed(1)} MB/s</div>
            </div>
          </div>
        )}
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(benchResult)}
        requirementHint="Run the non-destructive SSD Speed Benchmark to complete Step 5 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
