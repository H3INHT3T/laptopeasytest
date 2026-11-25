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

interface StorageViewProps {
  smartReport: StorageSmartReport | null;
  benchResult: StorageBenchResult | null;
  loadingSmart: boolean;
  status: TestStatus;
  onRefreshSmart: () => void;
  onBenchComplete: (res: StorageBenchResult) => void;
  onNext?: () => void;
}

export const StorageView: React.FC<StorageViewProps> = ({
  smartReport,
  benchResult,
  loadingSmart,
  status,
  onRefreshSmart,
  onBenchComplete,
  onNext,
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
    setProgress({ phase: "Preparing temporary file...", percent: 2, currentMbS: 0 });
    try {
      const res = await invoke<StorageBenchResult>("run_storage_benchmark", { preset });
      onBenchComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const stopBench = () => {
    invoke("cancel_storage_benchmark").catch(() => {});
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">SSD Health (SMART) &amp; Speed Test</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            DriveDx-inspired NVMe/SATA SMART wear, errors &amp; temperature diagnostics plus non-destructive sequential &amp; 4K speed benchmark.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshSmart}
            disabled={loadingSmart}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingSmart ? "animate-spin" : ""}`} />
            Re-scan SMART
          </button>
          {onNext && (
            <button
              onClick={onNext}
              className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
            >
              Next Test →
            </button>
          )}
        </div>
      </div>

      {/* SMART Cards */}
      <div className="space-y-3">
        {!smartReport ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
            {loadingSmart ? "Reading NVMe/SATA SMART reliability counters..." : "Click Re-scan SMART to read drive health."}
          </div>
        ) : smartReport.drives.length === 0 ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
            {smartReport.summary}
          </div>
        ) : (
          smartReport.drives.map((d, idx) => (
            <div key={idx} className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
                    <HardDrive className="w-5 h-5 text-sky-400" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">{d.model}</div>
                    <div className="text-xs text-slate-400 font-mono">
                      {d.interfaceType} • {d.mediaType} • {d.sizeGb.toFixed(0)} GB
                      {d.serialNumber ? ` • S/N: ${d.serialNumber}` : ""}
                    </div>
                  </div>
                </div>
                <StatusBadge status={d.status} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2.5 font-mono text-xs">
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">Health</div>
                  <div className="text-sm font-bold text-emerald-400 mt-0.5">
                    {d.healthPercent != null ? `${d.healthPercent}%` : d.healthStatus}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">Wear Used</div>
                  <div className="text-sm font-bold text-white mt-0.5">
                    {d.wearPercent != null ? `${d.wearPercent}%` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">Temp</div>
                  <div className="text-sm font-bold text-cyan-300 mt-0.5">
                    {d.temperatureC != null ? `${d.temperatureC}°C` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">Power-On Hours</div>
                  <div className="text-sm font-bold text-white mt-0.5">
                    {d.powerOnHours != null ? `${d.powerOnHours}h` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">Media Errors</div>
                  <div className={`text-sm font-bold mt-0.5 ${(d.mediaErrors ?? 0) > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                    {d.mediaErrors ?? 0}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/70 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-400">TBW / Spare</div>
                  <div className="text-sm font-bold text-slate-200 mt-0.5">
                    {d.tbwGb != null ? `${(d.tbwGb / 1000).toFixed(1)} TB` : d.availableSparePct != null ? `${d.availableSparePct}%` : "N/A"}
                  </div>
                </div>
              </div>
              <div className="text-xs text-slate-400">{d.notes}</div>
            </div>
          ))
        )}
      </div>

      {/* Non-Destructive SSD Speed Benchmark */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-cyan-400" />
              Non-Destructive SSD Speed Benchmark
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Measures real Sequential &amp; Random 4K Read/Write using an automatically deleted temporary file (safe for OS &amp; user data).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
            >
              <option value="quick">Quick QC (256 MB)</option>
              <option value="standard">Standard (512 MB)</option>
              <option value="burnin">Deep (1 GB)</option>
            </select>
            {running ? (
              <button
                onClick={stopBench}
                className="px-4 py-2 rounded-lg bg-rose-500/20 border border-rose-500/50 text-rose-200 text-xs font-bold flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5" /> Cancel
              </button>
            ) : (
              <button
                onClick={startBench}
                className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" /> Run Speed Test
              </button>
            )}
          </div>
        </div>

        {running && progress && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-mono text-slate-300">
              <span>{progress.phase}</span>
              <span>
                {progress.currentMbS.toFixed(0)} MB/s • {progress.percent.toFixed(0)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-950 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-500/15 border border-rose-500/40 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}

        {benchResult && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Sequential Read</div>
              <div className="text-xl font-bold text-emerald-400 mt-1">
                {benchResult.seqReadMbS.toFixed(0)} <span className="text-xs">MB/s</span>
              </div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Sequential Write</div>
              <div className="text-xl font-bold text-cyan-400 mt-1">
                {benchResult.seqWriteMbS.toFixed(0)} <span className="text-xs">MB/s</span>
              </div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Random 4K Read</div>
              <div className="text-xl font-bold text-white mt-1">
                {benchResult.rand4kReadIops.toLocaleString()} <span className="text-xs">IOPS</span>
              </div>
              <div className="text-[10px] text-slate-500">{benchResult.rand4kReadMbS.toFixed(1)} MB/s</div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Random 4K Write</div>
              <div className="text-xl font-bold text-white mt-1">
                {benchResult.rand4kWriteIops.toLocaleString()} <span className="text-xs">IOPS</span>
              </div>
              <div className="text-[10px] text-slate-500">{benchResult.rand4kWriteMbS.toFixed(1)} MB/s</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
