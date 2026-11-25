import React from "react";
import {
  Activity,
  BatteryCharging,
  Camera,
  Cpu,
  FileCheck2,
  FileWarning,
  Fingerprint,
  Flame,
  Gauge,
  HardDrive,
  Keyboard,
  LayoutDashboard,
  Lock,
  MemoryStick,
  Monitor,
  PlugZap,
  Send,
  ShieldCheck,
} from "lucide-react";
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

const ICONS: Record<TestModuleId, React.ReactNode> = {
  dashboard: <LayoutDashboard className="w-4 h-4" />,
  specs: <Cpu className="w-4 h-4" />,
  security: <ShieldCheck className="w-4 h-4" />,
  battery: <BatteryCharging className="w-4 h-4" />,
  logs: <FileWarning className="w-4 h-4" />,
  storage: <HardDrive className="w-4 h-4" />,
  display: <Monitor className="w-4 h-4" />,
  keyboard: <Keyboard className="w-4 h-4" />,
  biometrics: <Fingerprint className="w-4 h-4" />,
  media: <Camera className="w-4 h-4" />,
  ram: <MemoryStick className="w-4 h-4" />,
  performance: <Gauge className="w-4 h-4" />,
  gpu: <Flame className="w-4 h-4" />,
  ports_speakers: <PlugZap className="w-4 h-4" />,
};

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
    <aside className="w-72 shrink-0 bg-black text-white border-r border-zinc-800 flex flex-col h-full select-none">
      {/* Brand Header */}
      <div className="px-4 py-4 border-b border-zinc-800 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Activity className="w-5 h-5 text-white stroke-[2.5]" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-sm tracking-tight text-white flex items-center gap-1.5">
            LaptopBench QC
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-blue-400 border border-zinc-700">
              PRO
            </span>
          </div>
          <div className="text-[11px] text-zinc-400 truncate">
            Strict Step-by-Step Deep QC
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        <button
          onClick={() => onSelect("dashboard")}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
            activeTab === "dashboard"
              ? "bg-blue-600 text-white"
              : "text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          <span className="flex items-center gap-2.5">
            {ICONS.dashboard}
            Overview Dashboard
          </span>
          <span className="font-mono text-[10px] opacity-80">
            {completedCount}/{stepOrder.length}
          </span>
        </button>

        <div className="pt-2 pb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
          Sequential QC Pipeline
        </div>

        {stepOrder.map((id, idx) => {
          const mod = modules[id];
          const isUnlocked = idx <= unlockedIndex;
          const isActive = activeTab === id;

          return (
            <button
              key={id}
              disabled={!isUnlocked}
              onClick={() => isUnlocked && onSelect(id)}
              title={!isUnlocked ? `Complete or skip Step ${idx} first to unlock` : mod.name}
              className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition ${
                isActive
                  ? "bg-white text-black font-bold"
                  : isUnlocked
                  ? "text-zinc-200 hover:bg-zinc-900 cursor-pointer"
                  : "text-zinc-600 cursor-not-allowed opacity-65"
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-5 h-5 rounded text-[10px] font-mono font-bold flex items-center justify-center shrink-0 ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : isUnlocked
                      ? "bg-zinc-800 text-zinc-200"
                      : "bg-zinc-900 text-zinc-600"
                  }`}
                >
                  {idx + 1}
                </span>
                <span className="truncate">{mod.name}</span>
                {id === "gpu" && isGamingCapable && (
                  <span
                    className={`px-1 py-0.5 text-[9px] rounded font-bold ${
                      isActive ? "bg-blue-600 text-white" : "bg-blue-950 text-blue-300 border border-blue-700"
                    }`}
                  >
                    dGPU
                  </span>
                )}
              </span>

              {!isUnlocked ? (
                <Lock className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
              ) : (
                <StatusBadge status={mod.status} compact darkSurface={!isActive} />
              )}
            </button>
          );
        })}
      </nav>

      {/* Progress, Final Report & Creator Credit */}
      <div className="p-3 border-t border-zinc-800 bg-zinc-950 space-y-2.5">
        <div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
            <span>Pipeline Progress</span>
            <span className="font-mono text-white font-bold">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <button
          onClick={onOpenReportModal}
          disabled={!allStepsDone}
          title={allStepsDone ? "Export QC Certificate" : "Finish or skip all 13 steps to unlock Final Report"}
          className={`w-full py-2.5 px-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition ${
            allStepsDone
              ? "bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              : "bg-zinc-900 text-zinc-500 border border-zinc-800 cursor-not-allowed"
          }`}
        >
          {allStepsDone ? <FileCheck2 className="w-4 h-4" /> : <Lock className="w-3.5 h-3.5" />}
          {allStepsDone ? "Generate Final QC Report" : `Complete All Steps (${completedCount}/${stepOrder.length})`}
        </button>

        {/* Creator Credit Tag */}
        <div className="pt-2 border-t border-zinc-800/90 text-center space-y-0.5">
          <div className="text-[11px] font-semibold text-white">
            Created by Hein Htet Zaw
          </div>
          <div className="inline-flex items-center justify-center gap-1 text-[11px] font-mono text-blue-400">
            <Send className="w-3 h-3" />
            <span>Telegram: @ich8g92</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
