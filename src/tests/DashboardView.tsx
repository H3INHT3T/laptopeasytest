import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  Database,
  Download,
  FileCheck2,
  Flame,
  Laptop,
  Lock,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  Square,
  Timer,
  Upload,
  X,
} from "lucide-react";
import type {
  BurnInProgress,
  BurnInResult,
  ModuleRecord,
  ShopModelBenchmarkAvg,
  StepModuleId,
  SystemSpecs,
  TestModuleId,
} from "../types";
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

  // Shelf Burn-In Marathon modal state
  const [burnInOpen, setBurnInOpen] = useState(false);
  const [burnInMins, setBurnInMins] = useState<number>(5);
  const [burnInCutoff, setBurnInCutoff] = useState<number>(95);
  const [burnInRunning, setBurnInRunning] = useState(false);
  const [burnInProg, setBurnInProg] = useState<BurnInProgress | null>(null);
  const [burnInRes, setBurnInRes] = useState<BurnInResult | null>(null);
  const [burnInErr, setBurnInErr] = useState<string | null>(null);

  // Shop Model History modal state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<ShopModelBenchmarkAvg[]>([]);
  const [historyMsg, setHistoryMsg] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<BurnInProgress>("burnin:progress", (ev) => {
      setBurnInProg(ev.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const openHistoryModal = async () => {
    setHistoryMsg(null);
    setHistoryOpen(true);
    try {
      const items = await invoke<ShopModelBenchmarkAvg[]>("list_shop_history");
      setHistoryList(items);
    } catch {
      setHistoryList([]);
    }
  };

  const startShelfBurnIn = async () => {
    setBurnInErr(null);
    setBurnInRes(null);
    setBurnInRunning(true);
    setBurnInProg(null);
    try {
      const res = await invoke<BurnInResult>("run_shelf_burnin", {
        totalMinutes: burnInMins,
        thermalCutoffC: burnInCutoff,
        memoryTypeHint: specs?.ramModules[0]?.memoryType ?? "DDR4",
      });
      setBurnInRes(res);
    } catch (e) {
      setBurnInErr(String(e));
    } finally {
      setBurnInRunning(false);
    }
  };

  const exportHistory = async () => {
    const path = await saveDialog({
      title: "Export Shop Model History JSON",
      defaultPath: "shop_model_history.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) {
      const n = await invoke<number>("export_shop_history", { targetPath: path });
      setHistoryMsg(`Exported ${n} laptop model average(s) to ${path}`);
    }
  };

  const importHistory = async () => {
    const path = await openDialog({
      title: "Import Shop Model History JSON",
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (typeof path === "string") {
      const n = await invoke<number>("import_shop_history", { sourcePath: path });
      setHistoryMsg(`Imported ${n} laptop model baseline(s).`);
      const items = await invoke<ShopModelBenchmarkAvg[]>("list_shop_history");
      setHistoryList(items);
    }
  };

  return (
    <div className="space-y-6">
      {/* Crisp Black + Blue Hero Banner */}
      <div className="rounded-2xl bg-black text-white p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border border-zinc-800">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-bold text-blue-400">
            <Laptop className="w-4 h-4" />
            {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop Hardware..."}
            <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono">
              v2.0
            </span>
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

      {/* v2.0 Shop Durability & Database Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-black text-black flex items-center gap-1.5">
              <Timer className="w-4 h-4 text-blue-600" />
              1-Click Unattended Shelf Burn-In Marathon
            </div>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              Hands-free 5m / 15m / 30m shop stress: TM5 RAM + Dedicated VRAM + Combined CPU+GPU Power Torture with A+–FAIL grade.
            </p>
          </div>
          <button
            onClick={() => setBurnInOpen(true)}
            className="px-3.5 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-bold shrink-0 cursor-pointer"
          >
            Open Marathon
          </button>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-black text-black flex items-center gap-1.5">
              <Database className="w-4 h-4 text-blue-600" />
              Auto-Learning Shop Model History Database
            </div>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              Compare every incoming laptop against your shop's own historical average per model. Export/Import JSON across benches.
            </p>
          </div>
          <button
            onClick={openHistoryModal}
            className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black text-xs font-bold shrink-0 cursor-pointer"
          >
            View Shop DB
          </button>
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

      {/* ===================== SHELF BURN-IN MARATHON MODAL ===================== */}
      {burnInOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div>
                <h2 className="text-lg font-black text-black flex items-center gap-2">
                  <Timer className="w-5 h-5 text-blue-600" />
                  Unattended Shelf Burn-In Marathon (v2.0)
                </h2>
                <p className="text-xs text-zinc-600">
                  Sequential hands-free durability audit: Stage 1 RAM (30%) → Stage 2 GPU VRAM (25%) → Stage 3 CPU+GPU+RAM Power Torture (45%).
                </p>
              </div>
              {!burnInRunning && (
                <button
                  onClick={() => setBurnInOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-zinc-100 text-black cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">Total Marathon Time</label>
                <select
                  value={burnInMins}
                  disabled={burnInRunning}
                  onChange={(e) => setBurnInMins(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs font-bold text-black"
                >
                  <option value={5}>5 Minutes (Fast Shelf Check)</option>
                  <option value={15}>15 Minutes (Shop Standard)</option>
                  <option value={30}>30 Minutes (Heavy Durability)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">Safety Thermal Cutoff (°C)</label>
                <input
                  type="number"
                  min={75}
                  max={105}
                  disabled={burnInRunning}
                  value={burnInCutoff}
                  onChange={(e) => setBurnInCutoff(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs font-mono font-bold text-blue-700"
                />
              </div>
              <div>
                {burnInRunning ? (
                  <button
                    onClick={() => invoke("cancel_shelf_burnin").catch(() => {})}
                    className="w-full py-2 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-4 h-4" /> Cancel Marathon
                  </button>
                ) : (
                  <button
                    onClick={startShelfBurnIn}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-4 h-4" /> Start {burnInMins}m Burn-In
                  </button>
                )}
              </div>
            </div>

            {burnInErr && (
              <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{burnInErr}</div>
            )}

            {burnInProg && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="font-bold text-blue-700">{burnInProg.stageName}</span>
                  <span className="font-bold text-black">{burnInProg.overallPercent.toFixed(0)}%</span>
                </div>
                <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${burnInProg.overallPercent}%` }} />
                </div>
                <div className="text-xs text-zinc-600">{burnInProg.stageDetail}</div>
                <div className="grid grid-cols-3 gap-2 pt-1 font-mono text-xs">
                  <div className="rounded bg-white border border-zinc-200 p-2">
                    RAM Errors: <strong className="text-black">{burnInProg.ramErrors}</strong>
                  </div>
                  <div className="rounded bg-white border border-zinc-200 p-2">
                    VRAM Errors: <strong className="text-black">{burnInProg.vramErrors}</strong>
                  </div>
                  <div className="rounded bg-white border border-zinc-200 p-2">
                    AC Drain:{" "}
                    <strong className={burnInProg.batteryDrainAlert ? "text-blue-700" : "text-black"}>
                      {burnInProg.batteryDrainAlert ? "ALERT" : "OK"}
                    </strong>
                  </div>
                </div>
              </div>
            )}

            {burnInRes && !burnInRunning && (
              <div className="rounded-xl bg-black text-white p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-blue-400">
                    Shelf Burn-In Final Verdict
                  </span>
                  <span className="px-3 py-1 rounded bg-blue-600 text-white font-mono text-sm font-black">
                    GRADE: {burnInRes.durabilityGrade}
                  </span>
                </div>
                <div className="text-xs text-zinc-200">{burnInRes.summary}</div>
                {burnInRes.tortureResult?.batteryDrainWhilePlugged && (
                  <div className="text-xs text-blue-300 font-bold flex items-center gap-1.5 pt-1">
                    <ShieldAlert className="w-4 h-4" /> AC Charger Drain Detected During Combined Torture!
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================== SHOP MODEL HISTORY MODAL ===================== */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-2xl max-w-3xl w-full p-6 space-y-4 shadow-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div>
                <h2 className="text-lg font-black text-black flex items-center gap-2">
                  <Database className="w-5 h-5 text-blue-600" />
                  Shop Model History Database
                </h2>
                <p className="text-xs text-zinc-600">
                  Rolling averages learned automatically from every laptop tested in your shop.
                </p>
              </div>
              <button
                onClick={() => setHistoryOpen(false)}
                className="p-1.5 rounded-lg hover:bg-zinc-100 text-black cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={exportHistory}
                className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export Shop DB (JSON)
              </button>
              <button
                onClick={importHistory}
                className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-blue-600" /> Import &amp; Merge JSON
              </button>
            </div>

            {historyMsg && (
              <div className="rounded-lg bg-blue-50 border border-blue-600 text-blue-900 px-3 py-2 text-xs font-semibold">
                {historyMsg}
              </div>
            )}

            <div className="overflow-y-auto flex-1 border border-zinc-200 rounded-xl">
              {historyList.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">
                  No laptop models recorded yet. Run Step 11 (360° Performance Suite) on any laptop and its model average will be saved here automatically!
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-100 border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-600">
                    <tr>
                      <th className="px-3 py-2.5">Laptop Model &amp; CPU</th>
                      <th className="px-3 py-2.5 text-right">Units</th>
                      <th className="px-3 py-2.5 text-right">Avg Mark</th>
                      <th className="px-3 py-2.5 text-right">Office</th>
                      <th className="px-3 py-2.5 text-right">Creator</th>
                      <th className="px-3 py-2.5 text-right">Last Tested</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 font-mono">
                    {historyList.map((item) => (
                      <tr key={item.modelKey} className="hover:bg-zinc-50">
                        <td className="px-3 py-2.5 font-sans font-bold text-black">{item.displayLabel}</td>
                        <td className="px-3 py-2.5 text-right font-bold text-blue-700">{item.unitsTested}</td>
                        <td className="px-3 py-2.5 text-right font-black text-black">
                          {item.avgCompositeScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right text-zinc-700">
                          {item.avgOfficeScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right text-zinc-700">
                          {item.avgCreatorScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-zinc-500">{item.lastTestedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
