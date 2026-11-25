import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  Database,
  Download,
  FileCheck2,
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
      setHistoryMsg(`Exported ${n} laptop model baseline(s) to ${path}`);
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

  const nextStepNum = String(Math.min(unlockedIndex + 1, stepOrder.length)).padStart(2, "0");

  return (
    <div className="space-y-4">
      {/* Swiss Architectural Header Bar */}
      <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
        <div className="px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-200">
          <div className="space-y-1">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-blue-700">
              STAGE 00 // HARDWARE INSPECTION MANIFEST
            </div>
            <h1 className="text-xl font-black text-black tracking-tight">
              {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop Hardware..."}
            </h1>
            <div className="font-mono text-[11px] text-zinc-600 tabular-nums">
              {specs
                ? `${specs.cpuBrand}  •  ${specs.totalRamGb.toFixed(0)} GB RAM  •  S/N: ${specs.serialNumber}  •  ${specs.osName}`
                : "Enumerating hardware subsystems, locks, battery, crash logs & SMART..."}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={onRunAutoChecks}
              disabled={autoRunning}
              className="px-3 py-2 rounded-[2px] border border-zinc-300 bg-white hover:border-black text-black font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${autoRunning ? "animate-spin text-blue-600" : ""}`} />
              Re-Scan
            </button>
            <button
              onClick={() => setBurnInOpen(true)}
              className="px-3 py-2 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
            >
              <Timer className="w-3.5 h-3.5 text-blue-600" />
              Shelf Burn-In
            </button>
            <button
              onClick={openHistoryModal}
              className="px-3 py-2 rounded-[2px] border border-zinc-300 bg-white hover:border-black text-black font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
            >
              <Database className="w-3.5 h-3.5 text-blue-600" />
              Shop DB
            </button>
            <button
              onClick={onStartOrResume}
              className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
            >
              {unlockedIndex === 0 ? "Begin Stage 01" : `Resume Stage ${nextStepNum}`}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            {allStepsDone && (
              <button
                onClick={onOpenReport}
                className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
              >
                <FileCheck2 className="w-3.5 h-3.5 text-blue-400" />
                Certificate
              </button>
            )}
          </div>
        </div>

        {/* Dense Hairline Telemetry Counter Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums">
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Passed</span>
            <span className="text-base font-black text-blue-600">{String(passed).padStart(2, "0")}</span>
          </div>
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Warnings</span>
            <span className="text-base font-black text-black">{String(warned).padStart(2, "0")}</span>
          </div>
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Failures</span>
            <span className={`text-base font-black ${failed > 0 ? "px-1.5 bg-black text-white" : "text-black"}`}>
              {String(failed).padStart(2, "0")}
            </span>
          </div>
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Skipped</span>
            <span className="text-base font-black text-zinc-600">{String(skipped).padStart(2, "0")}</span>
          </div>
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Graphics Class</span>
            <span className="text-[11px] font-bold text-blue-700 uppercase">
              {specs?.isGamingCapable ? "Gaming dGPU" : "Office / iGPU"}
            </span>
          </div>
        </div>
      </div>

      {/* Dense Architectural 13-Step Inspection Manifest Ledger */}
      <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-300 bg-[#F8FAFC] flex items-center justify-between font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-600">
          <span>13-Stage Sequential Diagnostic Ledger</span>
          <span>Strict Step-by-Step • Explicit Skip Allowed Per Stage</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 bg-white font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-2 px-4 w-14">Stage</th>
                <th className="py-2 px-3 w-48">Diagnostic Module</th>
                <th className="py-2 px-3 w-32">Scope</th>
                <th className="py-2 px-3 w-24">Status</th>
                <th className="py-2 px-3">Measured Summary &amp; Audit Proof</th>
                <th className="py-2 px-4 w-28 text-right">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {list.map((mod, idx) => {
                const isUnlocked = idx <= unlockedIndex;
                const isCurrent = idx === unlockedIndex;
                const num = String(idx + 1).padStart(2, "0");

                return (
                  <tr
                    key={mod.id}
                    onClick={() => isUnlocked && onSelectModule(mod.id)}
                    className={`transition ${
                      isCurrent
                        ? "bg-blue-50/40 hover:bg-blue-50/70 cursor-pointer"
                        : isUnlocked
                        ? "bg-white hover:bg-zinc-50 cursor-pointer"
                        : "bg-[#FAFAFA] text-zinc-400"
                    }`}
                  >
                    <td className="py-2.5 px-4 font-mono tabular-nums font-bold">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded-[2px] text-[10px] ${
                          isCurrent
                            ? "bg-blue-600 text-white"
                            : isUnlocked
                            ? "bg-black text-white"
                            : "bg-zinc-200 text-zinc-500"
                        }`}
                      >
                        {num}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-bold text-black">
                      <span className={!isUnlocked ? "text-zinc-500 font-semibold" : ""}>{mod.name}</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      {mod.category}
                    </td>
                    <td className="py-2.5 px-3">
                      {!isUnlocked ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500">
                          <Lock className="w-3 h-3" /> LOCKED
                        </span>
                      ) : (
                        <StatusBadge status={mod.status} compact />
                      )}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-zinc-700 max-w-md truncate">
                      {!isUnlocked
                        ? `Unlocks after Stage ${String(idx).padStart(2, "0")}`
                        : mod.summary || "Ready for diagnostic execution."}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      {isUnlocked ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[10.5px] font-bold uppercase text-blue-700 hover:underline">
                          {isCurrent ? "Inspect" : "Review"} <ArrowRight className="w-3 h-3" />
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer Attribution Rule */}
      <div className="px-4 py-2.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="font-mono text-zinc-600">
          OFFLINE NATIVE RUST ENGINE • ZERO CLOUD TELEMETRY • TAMPER-EVIDENT SHA-256 CERTIFICATES
        </span>
        <span className="font-bold text-black inline-flex items-center gap-1.5">
          Created by Hein Htet Zaw
          <span className="text-blue-700 font-mono inline-flex items-center gap-1">
            • <Send className="w-3 h-3" /> @ich8g92
          </span>
        </span>
      </div>

      {/* ===================== SHELF BURN-IN MARATHON MODAL ===================== */}
      {burnInOpen && (
        <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-[2px] max-w-2xl w-full p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-300 pb-3">
              <div>
                <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-blue-700">
                  UNATTENDED SHOP BENCH PROTOCOL
                </div>
                <h2 className="text-base font-black text-black flex items-center gap-2 mt-0.5">
                  <Timer className="w-4 h-4 text-blue-600" />
                  Shelf Burn-In Marathon (RAM → VRAM → Combined Power)
                </h2>
              </div>
              {!burnInRunning && (
                <button
                  onClick={() => setBurnInOpen(false)}
                  className="p-1 hover:bg-zinc-100 text-black cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">
                  Total Duration
                </label>
                <select
                  value={burnInMins}
                  disabled={burnInRunning}
                  onChange={(e) => setBurnInMins(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-2 text-xs font-mono font-bold text-black"
                >
                  <option value={5}>05 MIN (Fast Shelf Check)</option>
                  <option value={15}>15 MIN (Shop Standard)</option>
                  <option value={30}>30 MIN (Heavy Durability)</option>
                </select>
              </div>
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">
                  Thermal Cutoff (°C)
                </label>
                <input
                  type="number"
                  min={75}
                  max={105}
                  disabled={burnInRunning}
                  value={burnInCutoff}
                  onChange={(e) => setBurnInCutoff(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-2 text-xs font-mono font-bold text-blue-700"
                />
              </div>
              <div>
                {burnInRunning ? (
                  <button
                    onClick={() => invoke("cancel_shelf_burnin").catch(() => {})}
                    className="w-full py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Abort
                  </button>
                ) : (
                  <button
                    onClick={startShelfBurnIn}
                    className="w-full py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Run {burnInMins}m Marathon
                  </button>
                )}
              </div>
            </div>

            {burnInErr && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{burnInErr}</div>
            )}

            {burnInProg && (
              <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-4 space-y-2.5 font-mono">
                <div className="flex items-center justify-between text-xs tabular-nums">
                  <span className="font-bold text-blue-700">{burnInProg.stageName}</span>
                  <span className="font-bold text-black">{burnInProg.overallPercent.toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${burnInProg.overallPercent}%` }} />
                </div>
                <div className="text-[11px] text-zinc-600">{burnInProg.stageDetail}</div>
                <div className="grid grid-cols-3 gap-2 pt-1 text-xs tabular-nums">
                  <div className="bg-white border border-zinc-300 p-2">
                    RAM ERR: <strong className="text-black">{burnInProg.ramErrors}</strong>
                  </div>
                  <div className="bg-white border border-zinc-300 p-2">
                    VRAM ERR: <strong className="text-black">{burnInProg.vramErrors}</strong>
                  </div>
                  <div className="bg-white border border-zinc-300 p-2">
                    AC DRAIN:{" "}
                    <strong className={burnInProg.batteryDrainAlert ? "text-blue-700 underline" : "text-black"}>
                      {burnInProg.batteryDrainAlert ? "ALERT" : "NONE"}
                    </strong>
                  </div>
                </div>
              </div>
            )}

            {burnInRes && !burnInRunning && (
              <div className="rounded-[2px] bg-black text-white p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-blue-400">
                    MARATHON FINAL VERDICT
                  </span>
                  <span className="px-2.5 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-xs font-black">
                    GRADE {burnInRes.durabilityGrade}
                  </span>
                </div>
                <div className="font-mono text-xs text-zinc-200">{burnInRes.summary}</div>
                {burnInRes.tortureResult?.batteryDrainWhilePlugged && (
                  <div className="text-xs text-blue-300 font-bold flex items-center gap-1.5 pt-1">
                    <ShieldAlert className="w-4 h-4" /> AC Charger Drain Detected Under Combined Load!
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================== SHOP MODEL HISTORY MODAL ===================== */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-[2px] max-w-3xl w-full p-5 space-y-4 shadow-xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-300 pb-3">
              <div>
                <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-blue-700">
                  LOCAL CALIBRATION ARCHIVE
                </div>
                <h2 className="text-base font-black text-black flex items-center gap-2 mt-0.5">
                  <Database className="w-4 h-4 text-blue-600" />
                  Shop Model History Database
                </h2>
              </div>
              <button
                onClick={() => setHistoryOpen(false)}
                className="p-1 hover:bg-zinc-100 text-black cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={exportHistory}
                className="px-3 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export JSON
              </button>
              <button
                onClick={importHistory}
                className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-blue-600" /> Import &amp; Merge
              </button>
            </div>

            {historyMsg && (
              <div className="rounded-[2px] bg-blue-50 border border-blue-600 text-blue-900 px-3 py-2 font-mono text-xs font-semibold">
                {historyMsg}
              </div>
            )}

            <div className="overflow-y-auto flex-1 border border-zinc-300 rounded-[2px]">
              {historyList.length === 0 ? (
                <div className="p-8 text-center font-mono text-xs text-zinc-500">
                  NO MODEL RECORDS YET — COMPLETE STAGE 11 TO AUTO-CALIBRATE YOUR FIRST LAPTOP MODEL.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-[#F8FAFC] border-b border-zinc-300 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                    <tr>
                      <th className="px-3 py-2">Model &amp; Processor</th>
                      <th className="px-3 py-2 text-right">Units</th>
                      <th className="px-3 py-2 text-right">Avg Mark</th>
                      <th className="px-3 py-2 text-right">Office</th>
                      <th className="px-3 py-2 text-right">Creator</th>
                      <th className="px-3 py-2 text-right">Last Tested</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 font-mono tabular-nums">
                    {historyList.map((item) => (
                      <tr key={item.modelKey} className="hover:bg-zinc-50">
                        <td className="px-3 py-2 font-sans font-bold text-black">{item.displayLabel}</td>
                        <td className="px-3 py-2 text-right font-bold text-blue-700">{item.unitsTested}</td>
                        <td className="px-3 py-2 text-right font-black text-black">
                          {item.avgCompositeScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-700">
                          {item.avgOfficeScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-700">
                          {item.avgCreatorScore?.toFixed(0) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-[11px] text-zinc-500">{item.lastTestedAt}</td>
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
