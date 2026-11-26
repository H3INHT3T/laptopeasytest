import React from "react";
import {
  Activity,
  Archive,
  Battery,
  Camera,
  Cpu,
  FileCheck2,
  FileWarning,
  Fingerprint,
  Flame,
  Gauge,
  Hand,
  HardDrive,
  Home,
  Keyboard,
  Lock,
  MemoryStick,
  Monitor,
  Send,
  ShieldCheck,
  Usb,
} from "lucide-react";
import type { ModuleRecord, StepModuleId, TestModuleId } from "../types";
import { StatusBadge } from "./StatusBadge";

const STEP_ICONS: Record<StepModuleId, React.ComponentType<{ className?: string }>> = {
  specs: Cpu,
  security: ShieldCheck,
  battery: Battery,
  logs: FileWarning,
  storage: HardDrive,
  display: Monitor,
  touchscreen: Hand,
  keyboard: Keyboard,
  biometrics: Fingerprint,
  media: Camera,
  ram: MemoryStick,
  performance: Gauge,
  gpu: Flame,
  ports_speakers: Usb,
};

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

  const isStressActive = activeTab === "stress_hub";
  const isArchiveActive = activeTab === "archive";
  const isQcActive = !isStressActive && !isArchiveActive;

  return (
    <aside className="flex h-full shrink-0 bg-white border-r border-zinc-200 select-none">
      {/* Novabench-Style Slim Primary Icon Rail */}
      <div className="w-16 shrink-0 bg-[#F8FAFC] border-r border-zinc-200 flex flex-col items-center py-3 gap-2">
        <button
          type="button"
          onClick={() => onSelect("dashboard")}
          title="LaptopBench QC Home"
          className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs mb-2 cursor-pointer"
        >
          <Activity className="w-5 h-5 stroke-[2.5]" />
        </button>

        <button
          type="button"
          onClick={() => onSelect("dashboard")}
          className={`w-14 py-2 rounded-lg flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
            isQcActive
              ? "bg-white text-blue-700 border border-blue-200 shadow-2xs"
              : "text-zinc-500 hover:text-black hover:bg-white/70"
          }`}
        >
          <Home className="w-4 h-4" />
          <span>QC Tests</span>
        </button>

        <button
          type="button"
          onClick={() => onSelect("stress_hub")}
          className={`w-14 py-2 rounded-lg flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
            isStressActive
              ? "bg-white text-blue-700 border border-blue-200 shadow-2xs"
              : "text-zinc-500 hover:text-black hover:bg-white/70"
          }`}
        >
          <Flame className="w-4 h-4" />
          <span>Stress</span>
        </button>

        <button
          type="button"
          onClick={() => onSelect("archive")}
          className={`w-14 py-2 rounded-lg flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
            isArchiveActive
              ? "bg-white text-blue-700 border border-blue-200 shadow-2xs"
              : "text-zinc-500 hover:text-black hover:bg-white/70"
          }`}
        >
          <Archive className="w-4 h-4" />
          <span>Archive</span>
        </button>

        <button
          type="button"
          onClick={onOpenReportModal}
          disabled={!allStepsDone}
          title={allStepsDone ? "Open QC Certificate" : `Complete or skip all ${stepOrder.length} steps`}
          className={`w-14 py-2 rounded-lg flex flex-col items-center gap-1 text-[10px] font-semibold transition ${
            allStepsDone
              ? "text-zinc-700 hover:text-blue-700 hover:bg-white cursor-pointer"
              : "text-zinc-300 cursor-not-allowed"
          }`}
        >
          <FileCheck2 className="w-4 h-4" />
          <span>Report</span>
        </button>

        <div className="mt-auto text-center px-1">
          <div className="font-mono text-[9px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded">
            v2.9.0
          </div>
        </div>
      </div>

      {/* Clean Secondary Step List */}
      <div className="w-52 shrink-0 flex flex-col h-full bg-white">
        <div className="h-12 px-4 border-b border-zinc-200 flex items-center justify-between">
          <span className="font-bold text-sm text-black tracking-tight">LaptopBench QC</span>
          <span className="font-mono text-[11px] font-semibold text-zinc-500 tabular-nums">
            {completedCount}/{stepOrder.length}
          </span>
        </div>

        <div className="px-4 pt-4 pb-1.5 text-[11px] font-medium text-zinc-400">
          Inspection steps
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-0.5">
          {stepOrder.map((id, idx) => {
            const mod = modules[id];
            const isUnlocked = idx <= unlockedIndex;
            const isActive = activeTab === id;
            const num = String(idx + 1).padStart(2, "0");
            const StepIcon = STEP_ICONS[id];

            return (
              <button
                key={id}
                type="button"
                disabled={!isUnlocked}
                onClick={() => isUnlocked && onSelect(id)}
                title={!isUnlocked ? `Complete or skip Step ${idx} first to unlock` : mod.name}
                className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition ${
                  isActive
                    ? "bg-blue-50 text-blue-700 font-bold"
                    : isUnlocked
                    ? "text-zinc-800 hover:bg-zinc-100 cursor-pointer font-medium"
                    : "text-zinc-400 cursor-not-allowed"
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`font-mono text-[10px] tabular-nums w-4 shrink-0 ${
                      isActive ? "text-blue-600 font-bold" : isUnlocked ? "text-zinc-500" : "text-zinc-300"
                    }`}
                  >
                    {num}
                  </span>
                  <StepIcon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? "text-blue-600" : isUnlocked ? "text-zinc-500" : "text-zinc-300"
                    }`}
                  />
                  <span className="truncate">{mod.name}</span>
                  {id === "gpu" && isGamingCapable && (
                    <span className="px-1 py-0.2 bg-blue-600 text-white font-mono text-[8px] font-bold rounded shrink-0">
                      dGPU
                    </span>
                  )}
                </span>

                {!isUnlocked ? (
                  <Lock className="w-3 h-3 text-zinc-300 shrink-0" />
                ) : (
                  <StatusBadge status={mod.status} compact />
                )}
              </button>
            );
          })}
        </nav>

        {/* Clean Bottom Footer */}
        <div className="p-3 border-t border-zinc-200 space-y-2.5 bg-[#FAFAFA]">
          <div className="h-1.5 rounded-full bg-zinc-200 overflow-hidden">
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          <button
            type="button"
            onClick={onOpenReportModal}
            disabled={!allStepsDone}
            className={`w-full py-2 px-3 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition ${
              allStepsDone
                ? "bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer"
                : "bg-white text-zinc-400 border border-zinc-200 cursor-not-allowed"
            }`}
          >
            {allStepsDone ? <FileCheck2 className="w-3.5 h-3.5" /> : <Lock className="w-3 h-3" />}
            {allStepsDone ? "Issue QC Certificate" : `Locked (${completedCount}/${stepOrder.length})`}
          </button>

          <div className="flex items-center justify-between text-[10px] pt-1">
            <span className="font-semibold text-black truncate">Hein Htet Zaw</span>
            <span className="font-mono text-blue-700 font-bold inline-flex items-center gap-1 shrink-0">
              <Send className="w-2.5 h-2.5" /> @ich8g92
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
};
