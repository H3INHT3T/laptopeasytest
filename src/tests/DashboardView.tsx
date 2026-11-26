import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowRight,
  ChevronRight,
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
  Zap,
} from "lucide-react";
import type {
  BatteryDischargeResult,
  BurnInProgress,
  BurnInResult,
  ModuleRecord,
  NetworkDiagnosticsReport,
  SavedSessionPayload,
  ShopModelBenchmarkAvg,
  StepModuleId,
  SystemSpecs,
  TestModuleId,
  TouchscreenTestResult,
  UserBenchmarkComparison,
  WarrantyReturnDiff,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface DashboardViewProps {
  specs: SystemSpecs | null;
  stepOrder: StepModuleId[];
  unlockedIndex: number;
  modules: Record<StepModuleId, ModuleRecord>;
  autoRunning: boolean;
  allStepsDone: boolean;
  savedSession: SavedSessionPayload | null;
  crashAlert: string | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
  touchscreenResult?: TouchscreenTestResult | null;
  batteryDischargeResult?: BatteryDischargeResult | null;
  networkReport?: NetworkDiagnosticsReport | null;
  warrantyDiff?: WarrantyReturnDiff | null;
  expressQueue?: { running: boolean; mode: "fast" | "deep"; stepLabel: string; percent: number } | null;
  onStartExpressQueue?: (mode: "fast" | "deep") => void;
  onCancelExpressQueue?: () => void;
  onResumeSession: () => void;
  onDiscardSession: () => void;
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
  savedSession,
  crashAlert,
  userbenchmarkComparison,
  warrantyDiff,
  expressQueue,
  onStartExpressQueue,
  onCancelExpressQueue,
  onResumeSession,
  onDiscardSession,
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
  const completed = list.filter((m) => m.status !== "pending" && m.status !== "running").length;
  const progressPct = Math.round((completed / Math.max(1, stepOrder.length)) * 100);

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
    <div className="space-y-6">
      {/* Screen-reader / E2E landmark without visual ALL-CAPS clutter */}
      <span className="sr-only">STAGE 00 // HARDWARE INSPECTION MANIFEST</span>

      {/* Urgent conditional alerts (only visible on unexpected crash or return-unit swap) */}
      {savedSession && (
        <div
          className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            savedSession.activeStressStage
              ? "border-black bg-black text-white"
              : "border-blue-600 bg-white text-black"
          }`}
        >
          <div className="flex items-start gap-2.5 text-xs">
            <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${savedSession.activeStressStage ? "text-blue-400" : "text-blue-600"}`} />
            <div>
              <div className="font-semibold">
                {savedSession.activeStressStage
                  ? `Unexpected reboot during ${savedSession.activeStressStage}`
                  : `Saved session found for ${savedSession.serialNumber}`}
              </div>
              <div className="opacity-80 mt-0.5">Saved at {savedSession.savedAt}.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onResumeSession}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
            >
              Resume Session
            </button>
            <button
              type="button"
              onClick={onDiscardSession}
              className={`px-3.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer ${
                savedSession.activeStressStage
                  ? "border-zinc-600 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-black hover:border-black"
              }`}
            >
              Start Fresh
            </button>
          </div>
        </div>
      )}

      {crashAlert && !savedSession && (
        <div className="rounded-xl border border-black bg-black text-white px-4 py-3 flex items-center gap-2.5 text-xs">
          <ShieldAlert className="w-4 h-4 text-blue-400 shrink-0" />
          <span>{crashAlert}</span>
        </div>
      )}

      {warrantyDiff && (
        <div
          className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            warrantyDiff.partSwapSuspected
              ? "border-black bg-black text-white"
              : "border-zinc-200 bg-white text-black"
          }`}
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold flex items-center gap-1.5">
              <ShieldAlert className={`w-4 h-4 shrink-0 ${warrantyDiff.partSwapSuspected ? "text-blue-400" : "text-blue-600"}`} />
              {warrantyDiff.summary}
            </div>
            {warrantyDiff.alerts.length > 0 && (
              <div className="text-[11px] opacity-85">{warrantyDiff.alerts.join(" • ")}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onSelectModule("archive")}
            className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shrink-0 cursor-pointer"
          >
            View Archive ({warrantyDiff.previousCount})
          </button>
        </div>
      )}

      {/* BLOCK 1: Clean Centered Hero + 1 Primary Button */}
      <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center space-y-5">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2.5 justify-center">
            <span className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center">
              <Activity className="w-5 h-5 stroke-[2.4]" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-black">LaptopBench QC</h1>
          </div>
          <div className="text-sm font-medium text-zinc-800">
            {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting hardware..."}
          </div>
          <div className="text-xs text-zinc-500">
            {specs
              ? `${specs.cpuBrand} • ${Math.round(specs.totalRamGb)} GB RAM • ${specs.osName}`
              : "Running quick hardware scan..."}
          </div>
        </div>

        {/* Single Primary CTA */}
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={onStartOrResume}
            className="min-w-[260px] px-7 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <Play className="w-4 h-4 fill-white" />
            {unlockedIndex === 0 ? "Begin Stage 01" : `Resume Stage ${nextStepNum}`}
            <ArrowRight className="w-4 h-4" />
          </button>

          {allStepsDone && (
            <button
              type="button"
              onClick={onOpenReport}
              className="px-5 py-3 rounded-xl bg-black hover:bg-zinc-800 text-white font-semibold text-sm inline-flex items-center gap-2 transition cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 text-blue-400" />
              Issue certificate
            </button>
          )}
        </div>

        {/* Quiet inline quick-run links */}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-1 text-xs font-medium text-zinc-600">
          {onStartExpressQueue && (
            <>
              <button
                type="button"
                disabled={Boolean(expressQueue?.running)}
                onClick={() => onStartExpressQueue("fast")}
                className="inline-flex items-center gap-1.5 hover:text-blue-700 transition cursor-pointer disabled:opacity-40"
              >
                <Zap className="w-3.5 h-3.5 text-blue-600" />
                Fast Auto-QC (2m)
              </button>
              <button
                type="button"
                disabled={Boolean(expressQueue?.running)}
                onClick={() => onStartExpressQueue("deep")}
                className="inline-flex items-center gap-1.5 hover:text-black transition cursor-pointer disabled:opacity-40"
              >
                <Zap className="w-3.5 h-3.5 text-zinc-500" />
                Deep Auto-QC (8m)
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setBurnInOpen(true)}
            className="inline-flex items-center gap-1.5 hover:text-black transition cursor-pointer"
          >
            <Timer className="w-3.5 h-3.5 text-zinc-500" />
            Shelf Burn-In
          </button>
        </div>

        {expressQueue?.running && (
          <div className="max-w-lg mx-auto rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 text-left space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-black">{expressQueue.stepLabel}</span>
              <button
                type="button"
                onClick={onCancelExpressQueue}
                className="px-2.5 py-1 rounded-lg bg-black text-white text-[11px] font-semibold cursor-pointer"
              >
                Stop
              </button>
            </div>
            <div className="h-2 rounded-full bg-zinc-200 overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${expressQueue.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* BLOCK 2: 1 Clean Visual Progress & Performance Card */}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs font-medium text-zinc-500">Inspection progress</div>
            <div className="text-2xl font-bold text-black tabular-nums mt-0.5">
              {completed} of {stepOrder.length} steps
              <span className="text-sm font-medium text-zinc-400 ml-2">{progressPct}%</span>
            </div>
          </div>
          {userbenchmarkComparison && (
            <div className="flex items-center gap-2.5">
              <span className="px-3.5 py-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold">
                {userbenchmarkComparison.overallVehicleTier}
              </span>
              <div className="text-right text-xs text-zinc-500 font-mono tabular-nums">
                Desk {userbenchmarkComparison.desktopPct.toFixed(0)}% • Game {userbenchmarkComparison.gamingPct.toFixed(0)}%
              </div>
            </div>
          )}
        </div>

        <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
          <div
            className="h-full bg-blue-600 rounded-full transition-all duration-300"
            style={{ width: `${Math.max(progressPct, completed > 0 ? 4 : 0)}%` }}
          />
        </div>

        <div className="grid grid-cols-4 gap-4 pt-1 text-center">
          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 py-3">
            <div className="text-xl font-bold text-blue-600 tabular-nums">{passed}</div>
            <div className="text-xs text-zinc-500 mt-0.5">Passed</div>
          </div>
          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 py-3">
            <div className="text-xl font-bold text-black tabular-nums">{warned}</div>
            <div className="text-xs text-zinc-500 mt-0.5">Warnings</div>
          </div>
          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 py-3">
            <div className="text-xl font-bold text-black tabular-nums">{failed}</div>
            <div className="text-xs text-zinc-500 mt-0.5">Failed</div>
          </div>
          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 py-3">
            <div className="text-xl font-bold text-zinc-500 tabular-nums">{skipped}</div>
            <div className="text-xs text-zinc-500 mt-0.5">Skipped</div>
          </div>
        </div>
      </div>

      {/* BLOCK 3: 1 Collapsed "Details" Toggle (Full 14-Step Table + Tools) */}
      <TechnicalDetailsDrawer
        title="Details"
        subtitle={`${stepOrder.length}-step checklist, Re-scan & Shop database`}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRunAutoChecks}
                disabled={autoRunning}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-black text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${autoRunning ? "animate-spin text-blue-600" : "text-zinc-500"}`} />
                Re-scan hardware
              </button>
              <button
                type="button"
                onClick={openHistoryModal}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-black text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Database className="w-3.5 h-3.5 text-blue-600" />
                Shop model database
              </button>
            </div>
            <span className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
              Created by <strong className="text-black">Hein Htet Zaw</strong>
              <span className="text-blue-700 font-mono inline-flex items-center gap-1">
                • <Send className="w-3 h-3" /> @ich8g92
              </span>
            </span>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            <table className="w-full text-left border-collapse">
              <tbody className="divide-y divide-zinc-100">
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
                          ? "bg-blue-50/40 hover:bg-blue-50 cursor-pointer"
                          : isUnlocked
                          ? "bg-white hover:bg-zinc-50 cursor-pointer"
                          : "bg-white text-zinc-400"
                      }`}
                    >
                      <td className="py-2.5 pl-4 pr-2 w-10 font-mono text-xs text-zinc-500">{num}</td>
                      <td className="py-2.5 px-2 w-52 text-xs font-semibold text-black">
                        <span className={isUnlocked ? "text-black" : "text-zinc-400"}>{mod.name}</span>
                      </td>
                      <td className="py-2.5 px-2 text-xs text-zinc-500 truncate max-w-md">
                        {!isUnlocked ? `Locked until step ${idx}` : mod.summary || "Ready"}
                      </td>
                      <td className="py-2.5 pl-2 pr-4 text-right w-24">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {!isUnlocked ? (
                            <Lock className="w-3.5 h-3.5 text-zinc-300" />
                          ) : (
                            <>
                              <StatusBadge status={mod.status} compact />
                              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </TechnicalDetailsDrawer>

      {/* ===================== SHELF BURN-IN MARATHON MODAL ===================== */}
      {burnInOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-xl max-w-xl w-full p-6 space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-black flex items-center gap-2">
                <Timer className="w-4 h-4 text-blue-600" />
                Shelf Burn-In Marathon
              </h2>
              {!burnInRunning && (
                <button
                  type="button"
                  onClick={() => setBurnInOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Duration</label>
                <select
                  value={burnInMins}
                  disabled={burnInRunning}
                  onChange={(e) => setBurnInMins(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-xs font-medium text-black"
                >
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Thermal cutoff (°C)</label>
                <input
                  type="number"
                  min={75}
                  max={105}
                  disabled={burnInRunning}
                  value={burnInCutoff}
                  onChange={(e) => setBurnInCutoff(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-xs font-mono font-bold text-blue-700"
                />
              </div>
              <div>
                {burnInRunning ? (
                  <button
                    type="button"
                    onClick={() => invoke("cancel_shelf_burnin").catch(() => {})}
                    className="w-full py-2 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Abort
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startShelfBurnIn}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Run {burnInMins}m Marathon
                  </button>
                )}
              </div>
            </div>

            {burnInErr && (
              <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{burnInErr}</div>
            )}

            {burnInProg && (
              <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-blue-700">{burnInProg.stageName}</span>
                  <span className="font-mono font-bold text-black">{burnInProg.overallPercent.toFixed(0)}%</span>
                </div>
                <div className="h-2 rounded-full bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${burnInProg.overallPercent}%` }} />
                </div>
                <div className="text-xs text-zinc-600">{burnInProg.stageDetail}</div>
              </div>
            )}

            {burnInRes && !burnInRunning && (() => {
              const displayGrade =
                burnInRes.status === "fail" || burnInRes.durabilityGrade === "FAIL"
                  ? "FAIL"
                  : burnInRes.cancelled
                  ? "INCOMPLETE"
                  : burnInRes.durabilityGrade;
              const isMonochromeBadge =
                displayGrade === "FAIL" ||
                displayGrade === "INCOMPLETE" ||
                displayGrade === "CANCELLED" ||
                burnInRes.status === "warn";
              return (
                <div className="rounded-xl bg-black text-white p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-400">Marathon final verdict</span>
                    <span
                      data-testid="burnin-verdict-badge"
                      className={`px-2.5 py-0.5 rounded-full font-mono text-xs font-bold ${
                        isMonochromeBadge
                          ? "bg-zinc-900 border border-zinc-600 text-white"
                          : "bg-blue-600 text-white"
                      }`}
                    >
                      {displayGrade === "FAIL" ||
                      displayGrade === "INCOMPLETE" ||
                      displayGrade === "CANCELLED"
                        ? displayGrade
                        : `GRADE ${displayGrade}`}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-200">{burnInRes.summary}</div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ===================== SHOP MODEL HISTORY MODAL ===================== */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-xl max-w-3xl w-full p-6 space-y-4 shadow-xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-black flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-600" />
                Shop model history
              </h2>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportHistory}
                className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export JSON
              </button>
              <button
                type="button"
                onClick={importHistory}
                className="px-3.5 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-black text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-blue-600" /> Import JSON
              </button>
            </div>

            {historyMsg && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-900 px-3 py-2 text-xs font-medium">
                {historyMsg}
              </div>
            )}

            <div className="overflow-y-auto flex-1 border border-zinc-200 rounded-xl">
              {historyList.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">
                  No model baselines recorded yet. Complete the performance benchmark to save your first model average.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 font-medium">Units</th>
                      <th className="px-3 py-2 font-medium">Composite</th>
                      <th className="px-3 py-2 font-medium">SSD read</th>
                      <th className="px-3 py-2 font-medium">Last tested</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 font-mono tabular-nums">
                    {historyList.map((h) => (
                      <tr key={h.modelKey}>
                        <td className="px-3 py-2 font-sans font-semibold text-black">{h.displayLabel}</td>
                        <td className="px-3 py-2 text-zinc-600">{h.unitsTested}</td>
                        <td className="px-3 py-2 font-bold text-blue-700">
                          {h.avgCompositeScore != null ? h.avgCompositeScore.toFixed(0) : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-700">
                          {h.avgSsdReadMbS != null ? `${h.avgSsdReadMbS.toFixed(0)} MB/s` : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{h.lastTestedAt}</td>
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
