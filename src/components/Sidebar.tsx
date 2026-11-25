import React from "react";
import { Activity, FileCheck2, Lock, Send } from "lucide-react";
import type { ModuleRecord, StepModuleId, TestModuleId } from "../types";
import { StatusBadge } from "./StatusBadge";

interface SidebarProps {
  activeTab: TestModuleId;
  onSelect: (id: TestModuleId) => void;
  stepOrder: StepModuleId[];
  unlockedIndex: number;
  modules: Record<StepModuleId, ModuleRecord>;
  isGamingCapable: boolean;
  allStepsDone: boolean;
  onOpenReportModal: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelect,
  stepOrder,
  unlockedIndex,
  modules,
  isGamingCapable,
  allStepsDone,
  onOpenReportModal,
}) => {
  const completedCount = stepOrder.filter((id) => {
    const st = modules[id].status;
    return st !== "pending" && st !== "running";
  }).length;
  const pct = Math.round((completedCount / stepOrder.length) * 100);

  return (
    <aside className="w-64 shrink-0 bg-[#F8FAFC] text-black border-r border-zinc-300 flex flex-col h-full select-none">
      {/* Instrument Nameplate */}
      <div className="px-4 py-3.5 border-b border-zinc-300 bg-white flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[2px] bg-black flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-blue-500 stroke-[2.5]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-black text-xs tracking-wider uppercase text-black flex items-center justify-between">
            <span>LaptopBench QC</span>
            <span className="font-mono text-[9px] font-bold px-1 py-0.5 bg-blue-600 text-white rounded-[2px]">
              v2.1
            </span>
          </div>
          <div className="font-mono text-[10px] text-zinc-500 tracking-tight truncate">
            PRECISION LAB INSTRUMENT
          </div>
        </div>
      </div>

      {/* Overview Manifest Link */}
      <div className="border-b border-zinc-300">
        <button
          onClick={() => onSelect("dashboard")}
          className={`w-full flex items-center justify-between px-4 py-2.5 text-xs transition cursor-pointer border-l-[3px] ${
            activeTab === "dashboard"
              ? "bg-white border-l-blue-600 text-black font-bold"
              : "bg-transparent border-l-transparent text-zinc-700 hover:bg-white hover:text-black font-medium"
          }`}
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-blue-600 font-bold">00</span>
            <span className="tracking-tight">Inspection Manifest</span>
          </span>
          <span className="font-mono text-[10px] text-zinc-600 tabular-nums">
            {completedCount}/{stepOrder.length}
          </span>
        </button>
      </div>

      {/* Sequential Pipeline Rail */}
      <div className="px-4 pt-3 pb-1.5 text-[9px] font-mono font-bold uppercase tracking-[0.14em] text-zinc-500 flex items-center justify-between">
        <span>Sequential Protocol</span>
        <span>LOCKED BY DEFAULT</span>
      </div>

      <nav className="flex-1 overflow-y-auto divide-y divide-zinc-200/80 border-t border-zinc-200">
        {stepOrder.map((id, idx) => {
          const mod = modules[id];
          const isUnlocked = idx <= unlockedIndex;
          const isActive = activeTab === id;
          const num = String(idx + 1).padStart(2, "0");

          return (
            <button
              key={id}
              disabled={!isUnlocked}
              onClick={() => isUnlocked && onSelect(id)}
              title={!isUnlocked ? `Complete or skip Step ${idx} first to unlock` : mod.name}
              className={`w-full flex items-center justify-between gap-2 px-3.5 py-2 text-xs transition border-l-[3px] ${
                isActive
                  ? "bg-white border-l-blue-600 text-black font-bold"
                  : isUnlocked
                  ? "bg-transparent border-l-transparent text-zinc-900 hover:bg-white cursor-pointer font-medium"
                  : "bg-transparent border-l-transparent text-zinc-500 cursor-not-allowed"
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`font-mono text-[10px] tabular-nums font-bold shrink-0 ${
                    isActive
                      ? "text-blue-600"
                      : isUnlocked
                      ? "text-black"
                      : "text-zinc-400"
                  }`}
                >
                  {num}
                </span>
                <span className="truncate tracking-tight">{mod.name}</span>
                {id === "gpu" && isGamingCapable && (
                  <span className="px-1 py-0.2 bg-blue-600 text-white font-mono text-[8px] font-bold rounded-[2px] shrink-0">
                    dGPU
                  </span>
                )}
              </span>

              {!isUnlocked ? (
                <Lock className="w-3 h-3 text-zinc-400 shrink-0" />
              ) : (
                <StatusBadge status={mod.status} compact />
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Progress, Certificate Trigger & Creator Plate */}
      <div className="p-3.5 border-t border-zinc-300 bg-white space-y-2.5">
        <div>
          <div className="flex items-center justify-between font-mono text-[10px] text-zinc-600 mb-1 tabular-nums">
            <span className="uppercase tracking-wider">Completion</span>
            <span className="font-bold text-black">{pct}%</span>
          </div>
          <div className="h-1 bg-zinc-200 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <button
          onClick={onOpenReportModal}
          disabled={!allStepsDone}
          title={allStepsDone ? "Open Swiss Lab Certificate & Export" : "Complete or explicitly skip all 13 steps to unlock Certificate"}
          className={`w-full py-2 px-3 rounded-[2px] font-mono font-bold text-[11px] uppercase tracking-wider flex items-center justify-center gap-1.5 transition border ${
            allStepsDone
              ? "bg-blue-600 hover:bg-blue-700 border-blue-600 text-white cursor-pointer"
              : "bg-zinc-100 text-zinc-500 border-zinc-300 cursor-not-allowed"
          }`}
        >
          {allStepsDone ? <FileCheck2 className="w-3.5 h-3.5" /> : <Lock className="w-3 h-3" />}
          {allStepsDone ? "Issue QC Certificate" : `Locked (${completedCount}/${stepOrder.length})`}
        </button>

        {/* Creator Attribution Plate */}
        <div className="pt-2 border-t border-zinc-200 flex items-center justify-between text-[10px]">
          <span className="font-semibold text-black truncate">Hein Htet Zaw</span>
          <span className="font-mono text-blue-700 font-bold inline-flex items-center gap-1 shrink-0">
            <Send className="w-2.5 h-2.5" /> @ich8g92
          </span>
        </div>
      </div>
    </aside>
  );
};
