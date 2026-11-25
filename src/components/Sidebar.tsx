import React from "react";
import {
  Activity,
  BatteryCharging,
  Camera,
  CheckCircle2,
  Cpu,
  FileCheck2,
  FileWarning,
  Flame,
  Fingerprint,
  Gauge,
  HardDrive,
  Keyboard,
  LayoutDashboard,
  MemoryStick,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import type { ModuleRecord, TestModuleId } from "../types";
import { StatusBadge } from "./StatusBadge";

interface SidebarProps {
  activeTab: TestModuleId;
  onSelect: (id: TestModuleId) => void;
  modules: Record<Exclude<TestModuleId, "dashboard">, ModuleRecord>;
  isGamingCapable: boolean;
  guidedMode: boolean;
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
};

const GROUPS: Array<{ title: string; ids: Exclude<TestModuleId, "dashboard">[] }> = [
  {
    title: "Automated Diagnostics",
    ids: ["specs", "security", "battery", "logs", "storage"],
  },
  {
    title: "Interactive Hardware",
    ids: ["display", "keyboard", "biometrics", "media"],
  },
  {
    title: "Stress & Benchmarks",
    ids: ["ram", "performance", "gpu"],
  },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelect,
  modules,
  isGamingCapable,
  guidedMode,
  onOpenReportModal,
}) => {
  const allList = Object.values(modules);
  const completedCount = allList.filter(
    (m) => m.status !== "pending" && m.status !== "running"
  ).length;
  const pct = Math.round((completedCount / allList.length) * 100);

  return (
    <aside className="w-72 shrink-0 bg-slate-900/90 border-r border-slate-800 flex flex-col h-full">
      {/* Brand Header */}
      <div className="px-4 py-4 border-b border-slate-800 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
          <Activity className="w-5 h-5 text-slate-950 stroke-[2.5]" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-sm tracking-tight text-white flex items-center gap-1.5">
            LaptopBench QC
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700">
              v1.0
            </span>
          </div>
          <div className="text-[11px] text-slate-400 truncate">
            {guidedMode ? "Guided QC Mode Active" : "Offline Diagnostics Suite"}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        <button
          onClick={() => onSelect("dashboard")}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === "dashboard"
              ? "bg-cyan-500/15 text-cyan-200 border border-cyan-500/30"
              : "text-slate-300 hover:bg-slate-800/80 border border-transparent"
          }`}
        >
          <span className="flex items-center gap-2.5">
            {ICONS.dashboard}
            QC Dashboard
          </span>
          <span className="text-[11px] text-slate-400 font-mono">
            {completedCount}/{allList.length}
          </span>
        </button>

        {GROUPS.map((group) => (
          <div key={group.title}>
            <div className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {group.title}
            </div>
            <div className="space-y-1">
              {group.ids.map((id) => {
                const mod = modules[id];
                const isActive = activeTab === id;
                return (
                  <button
                    key={id}
                    onClick={() => onSelect(id)}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition ${
                      isActive
                        ? "bg-slate-800 text-white border border-slate-700 shadow-sm"
                        : "text-slate-300 hover:bg-slate-800/50 border border-transparent"
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className={isActive ? "text-cyan-400" : "text-slate-400"}>
                        {ICONS[id]}
                      </span>
                      <span className="truncate">{mod.name}</span>
                      {id === "gpu" && isGamingCapable && (
                        <span className="px-1 py-0.5 text-[9px] rounded bg-orange-500/20 text-orange-300 border border-orange-500/40 font-bold">
                          dGPU
                        </span>
                      )}
                    </span>
                    <StatusBadge status={mod.status} compact />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Progress & Final Report CTA */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 space-y-2.5">
        <div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
            <span>QC Completion</span>
            <span className="font-mono text-slate-200">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <button
          onClick={onOpenReportModal}
          className="w-full py-2.5 px-3 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/15 transition cursor-pointer"
        >
          <FileCheck2 className="w-4 h-4" />
          Generate Final QC Report
        </button>
        <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-500">
          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
          <span>100% Offline • PDF + HTML + JSON</span>
        </div>
      </div>
    </aside>
  );
};
