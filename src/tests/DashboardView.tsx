import React from "react";
import {
  FileCheck2,
  Flame,
  Laptop,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ModuleRecord, SystemSpecs, TestModuleId } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface DashboardViewProps {
  specs: SystemSpecs | null;
  modules: Record<Exclude<TestModuleId, "dashboard">, ModuleRecord>;
  autoRunning: boolean;
  onRunAutoChecks: () => void;
  onStartGuided: () => void;
  onSelectModule: (id: TestModuleId) => void;
  onOpenReport: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  specs,
  modules,
  autoRunning,
  onRunAutoChecks,
  onStartGuided,
  onSelectModule,
  onOpenReport,
}) => {
  const list = Object.values(modules);
  const passed = list.filter((m) => m.status === "pass").length;
  const warned = list.filter((m) => m.status === "warn").length;
  const failed = list.filter((m) => m.status === "fail").length;
  const pending = list.filter((m) => m.status === "pending" || m.status === "running").length;

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950/30 p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-cyan-400">
            <Laptop className="w-4 h-4" />
            {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop Hardware..."}
            {specs?.isGamingCapable && (
              <span className="px-2 py-0.5 rounded-full bg-orange-500/20 border border-orange-500/40 text-orange-300 text-[10px] font-bold flex items-center gap-1">
                <Flame className="w-3 h-3" /> Gaming / Pro dGPU
              </span>
            )}
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">
            Laptop Quality Control Overview
          </h1>
          <p className="text-xs text-slate-400 font-mono">
            {specs
              ? `${specs.cpuBrand} • ${specs.totalRamGb.toFixed(0)} GB RAM • S/N: ${specs.serialNumber} • ${specs.osName}`
              : "Automated diagnostics (Specs, MDM/Lock, Battery, Error Logs, SMART) run automatically on launch."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={onRunAutoChecks}
            disabled={autoRunning}
            className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${autoRunning ? "animate-spin" : ""}`} />
            Re-run Auto Checks
          </button>
          <button
            onClick={onStartGuided}
            className="px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-2 shadow-lg shadow-cyan-500/20"
          >
            <Play className="w-4 h-4" />
            Start Guided QC Walkthrough
          </button>
          <button
            onClick={onOpenReport}
            className="px-4 py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-bold flex items-center gap-2"
          >
            <FileCheck2 className="w-4 h-4" />
            Export Certificate
          </button>
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-xs text-emerald-300/80 font-medium">Passed Modules</div>
          <div className="text-3xl font-black font-mono text-emerald-400 mt-1">{passed}</div>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-xs text-amber-300/80 font-medium">Warnings</div>
          <div className="text-3xl font-black font-mono text-amber-400 mt-1">{warned}</div>
        </div>
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <div className="text-xs text-rose-300/80 font-medium">Failures</div>
          <div className="text-3xl font-black font-mono text-rose-400 mt-1">{failed}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <div className="text-xs text-slate-400 font-medium">Remaining / Pending</div>
          <div className="text-3xl font-black font-mono text-slate-200 mt-1">{pending}</div>
        </div>
      </div>

      {/* Module Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {list.map((mod) => (
          <button
            key={mod.id}
            onClick={() => onSelectModule(mod.id)}
            className="text-left rounded-xl border border-slate-800 hover:border-cyan-500/50 bg-slate-900/70 hover:bg-slate-900 p-4 transition flex flex-col justify-between gap-3 group"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
                  {mod.category}
                </div>
                <div className="text-sm font-bold text-white group-hover:text-cyan-300 mt-0.5">
                  {mod.name}
                </div>
              </div>
              <StatusBadge status={mod.status} />
            </div>
            <div className="text-xs text-slate-400 line-clamp-2 min-h-[2rem]">
              {mod.summary || "Click to open and execute this diagnostic test."}
            </div>
          </button>
        ))}
      </div>

      {/* Footer note */}
      <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 px-4 py-3 flex items-center gap-2.5 text-xs text-slate-400">
        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
        <span>
          All diagnostics execute 100% natively offline in Rust. Before exporting the final certificate, you will be prompted with a Ports &amp; Speaker check reminder and shop branding sign-off.
        </span>
      </div>
    </div>
  );
};
