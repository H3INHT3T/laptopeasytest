import React from "react";
import { ArrowRight, FileCheck2, Flame, Laptop, Lock, RefreshCw, Send } from "lucide-react";
import type { ModuleRecord, StepModuleId, SystemSpecs, TestModuleId } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface DashboardViewProps {
  specs: SystemSpecs | null;
  stepOrder: StepModuleId[];
  unlockedIndex: number;
  modules: Record<StepModuleId, ModuleRecord>;
  autoRunning: boolean;
  allStepsDone: boolean;
  onRunAutoChecks: () => void;
  onStartOrResume: () => void;
  onSelectModule: (id: TestModuleId) => void;
  onOpenReport: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  specs,
  stepOrder,
  unlockedIndex,
  modules,
  autoRunning,
  allStepsDone,
  onRunAutoChecks,
  onStartOrResume,
  onSelectModule,
  onOpenReport,
}) => {
  const list = stepOrder.map((id) => modules[id]);
  const passed = list.filter((m) => m.status === "pass").length;
  const warned = list.filter((m) => m.status === "warn").length;
  const failed = list.filter((m) => m.status === "fail").length;
  const skipped = list.filter((m) => m.status === "skipped").length;

  return (
    <div className="space-y-6">
      {/* Crisp Black + Blue Hero Banner */}
      <div className="rounded-2xl bg-black text-white p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border border-zinc-800">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-bold text-blue-400">
            <Laptop className="w-4 h-4" />
            {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop Hardware..."}
            {specs?.isGamingCapable && (
              <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] font-bold flex items-center gap-1">
                <Flame className="w-3 h-3" /> Gaming / Pro dGPU
              </span>
            )}
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">
            Advanced Step-by-Step Laptop QC
          </h1>
          <p className="text-xs text-zinc-400 font-mono">
            {specs
              ? `${specs.cpuBrand} • ${specs.totalRamGb.toFixed(0)} GB RAM • S/N: ${specs.serialNumber} • ${specs.osName}`
              : "Scanning full hardware specifications, security locks, battery, error logs & SMART..."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={onRunAutoChecks}
            disabled={autoRunning}
            className="px-3.5 py-2.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-bold text-white flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${autoRunning ? "animate-spin text-blue-400" : ""}`} />
            Re-scan System
          </button>
          <button
            onClick={onStartOrResume}
            className="px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-2 cursor-pointer"
          >
            {unlockedIndex === 0 ? "Start Step 1: Specifications" : `Resume Step ${Math.min(unlockedIndex + 1, stepOrder.length)}`}
            <ArrowRight className="w-4 h-4" />
          </button>
          {allStepsDone && (
            <button
              onClick={onOpenReport}
              className="px-4 py-2.5 rounded-lg bg-white hover:bg-zinc-200 text-black text-xs font-bold flex items-center gap-2 cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 text-blue-600" />
              Export Certificate
            </button>
          )}
        </div>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="rounded-xl border border-blue-600 bg-blue-50 p-4">
          <div className="text-xs text-blue-900 font-bold">Passed</div>
          <div className="text-3xl font-black font-mono text-blue-600 mt-1">{passed}</div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="text-xs text-zinc-600 font-bold">Warnings</div>
          <div className="text-3xl font-black font-mono text-black mt-1">{warned}</div>
        </div>
        <div className="rounded-xl border border-black bg-black text-white p-4">
          <div className="text-xs text-zinc-400 font-bold">Failures</div>
          <div className="text-3xl font-black font-mono text-white mt-1">{failed}</div>
        </div>
        <div className="rounded-xl border border-dashed border-zinc-400 bg-zinc-50 p-4">
          <div className="text-xs text-zinc-600 font-bold">Explicitly Skipped</div>
          <div className="text-3xl font-black font-mono text-zinc-700 mt-1">{skipped}</div>
        </div>
      </div>

      {/* Sequential Pipeline Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {list.map((mod, idx) => {
          const isUnlocked = idx <= unlockedIndex;
          return (
            <button
              key={mod.id}
              disabled={!isUnlocked}
              onClick={() => isUnlocked && onSelectModule(mod.id)}
              className={`text-left rounded-xl border p-4 transition flex flex-col justify-between gap-3 ${
                isUnlocked
                  ? "border-zinc-200 hover:border-blue-600 bg-white cursor-pointer"
                  : "border-zinc-200 bg-zinc-50 opacity-65 cursor-not-allowed"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-6 h-6 rounded font-mono text-xs font-bold flex items-center justify-center ${
                      isUnlocked ? "bg-black text-white" : "bg-zinc-200 text-zinc-500"
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">
                      {mod.category}
                    </div>
                    <div className="text-sm font-bold text-black">{mod.name}</div>
                  </div>
                </div>
                {!isUnlocked ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-200 text-zinc-600 text-[10px] font-bold">
                    <Lock className="w-3 h-3" /> LOCKED
                  </span>
                ) : (
                  <StatusBadge status={mod.status} />
                )}
              </div>
              <div className="text-xs text-zinc-600 line-clamp-2 min-h-[2rem]">
                {!isUnlocked
                  ? `Complete or explicitly skip Step ${idx} to unlock this deep test.`
                  : mod.summary || "Ready to execute this deep diagnostic step."}
              </div>
            </button>
          );
        })}
      </div>

      {/* Creator Credit Footer */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-zinc-600">
          Steps progress sequentially one by one — cannot be skipped by default; use each step's explicit <strong>Skip Step</strong> button when needed.
        </span>
        <span className="font-bold text-black inline-flex items-center gap-1.5">
          Created by Hein Htet Zaw
          <span className="text-blue-600 font-mono inline-flex items-center gap-1">
            • <Send className="w-3 h-3" /> @ich8g92
          </span>
        </span>
      </div>
    </div>
  );
};
