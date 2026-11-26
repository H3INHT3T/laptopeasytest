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
  Flame,
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
} from "../types";
import { StatusBadge } from "../components/StatusBadge";

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
  touchscreenResult,
  batteryDischargeResult,
  networkReport,
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
  const perfStageNum = String(Math.max(1, stepOrder.indexOf("performance") + 1)).padStart(2, "0");
  const hasAdvancedChips = Boolean(
    userbenchmarkComparison || touchscreenResult || batteryDischargeResult || networkReport
  );

  return (
    <div className="space-y-4">
      {/* Crash-Safe Session Resume / Unexpected Reboot Detection Banner */}
      {savedSession && (
        <div className={`rounded-[2px] border-2 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
          savedSession.activeStressStage
            ? "border-black bg-black text-white"
            : "border-blue-600 bg-blue-50/60 text-black"
        }`}>
          <div className="flex items-start gap-2.5 text-xs">
            <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${savedSession.activeStressStage ? "text-blue-400" : "text-blue-600"}`} />
            <div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-blue-500">
                {savedSession.activeStressStage
                  ? `CRITICAL: UNEXPECTED SHUTDOWN / REBOOT DETECTED DURING ${savedSession.activeStressStage.toUpperCase()}`
                  : `SAVED QC SESSION FOUND FOR S/N ${savedSession.serialNumber}`}
              </div>
              <div className="mt-0.5">
                Last checkpoint saved at <strong className="font-mono">{savedSession.savedAt}</strong>. Resume to restore all completed steps
                {savedSession.activeStressStage ? " and log the hard-crash failure automatically into the QC Certificate." : "."}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onResumeSession}
              className="px-3.5 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase cursor-pointer"
            >
              Resume Session
            </button>
            <button
              onClick={onDiscardSession}
              className={`px-3 py-1.5 rounded-[2px] border font-mono text-[11px] font-bold uppercase cursor-pointer ${
                savedSession.activeStressStage
                  ? "border-zinc-600 bg-zinc-900 hover:bg-zinc-800 text-white"
                  : "border-black bg-white hover:bg-zinc-100 text-black"
              }`}
            >
              Start Fresh
            </button>
          </div>
        </div>
      )}

      {crashAlert && !savedSession && (
        <div className="rounded-[2px] border-2 border-black bg-black text-white px-4 py-2.5 flex items-center gap-2.5 font-mono text-xs">
          <ShieldAlert className="w-4 h-4 text-blue-400 shrink-0" />
          <span>{crashAlert}</span>
        </div>
      )}

      {/* Novabench-Style Clean Centered Launcher Card */}
      <div className="rounded-2xl border border-zinc-200 bg-white px-6 py-6 text-center space-y-4">
        <div className="space-y-1">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Stage 00 // Hardware Inspection Manifest
          </div>
          <div className="inline-flex items-center gap-2.5 justify-center">
            <span className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs">
              <Activity className="w-5 h-5 stroke-[2.5]" />
            </span>
            <span className="text-2xl font-bold tracking-tight text-black">LaptopBench QC</span>
          </div>
          <h1 className="text-base font-semibold text-zinc-800">
            {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop Hardware..."}
          </h1>
          <p className="text-xs text-zinc-500">
            {specs
              ? `${specs.cpuBrand} • ${Math.round(specs.totalRamGb)} GB RAM • ${specs.osName}`
              : "Scanning hardware, BIOS lock, battery, crash logs & SSD SMART..."}
          </p>
        </div>

        {/* Big Cobalt-Blue Primary CTA */}
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={onStartOrResume}
            className="min-w-[260px] px-7 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 shadow-sm transition cursor-pointer"
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
              Certificate
            </button>
          )}
        </div>

        {/* Compact Option Pills (Novabench Style) */}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onSelectModule("stress_hub")}
            className="px-3.5 py-2 rounded-lg border border-blue-200 bg-blue-50/60 hover:bg-blue-100/70 text-blue-800 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Flame className="w-3.5 h-3.5 text-blue-600" />
            Stress Lab
          </button>
          <button
            type="button"
            onClick={onRunAutoChecks}
            disabled={autoRunning}
            className="px-3.5 py-2 rounded-lg border border-zinc-200 bg-[#F8FAFC] hover:border-zinc-400 text-zinc-800 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRunning ? "animate-spin text-blue-600" : "text-zinc-500"}`} />
            Re-Scan
          </button>
          <button
            type="button"
            onClick={() => setBurnInOpen(true)}
            className="px-3.5 py-2 rounded-lg border border-zinc-200 bg-[#F8FAFC] hover:border-zinc-400 text-zinc-800 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Timer className="w-3.5 h-3.5 text-blue-600" />
            Shelf Burn-In
          </button>
          <button
            type="button"
            onClick={openHistoryModal}
            className="px-3.5 py-2 rounded-lg border border-zinc-200 bg-[#F8FAFC] hover:border-zinc-400 text-zinc-800 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Database className="w-3.5 h-3.5 text-blue-600" />
            Shop DB
          </button>
        </div>

        {/* Clean Summary Counters */}
        <div className="grid grid-cols-4 max-w-xl mx-auto pt-3 border-t border-zinc-100 text-center font-mono tabular-nums">
          <div>
            <div className="text-lg font-bold text-blue-600">{String(passed).padStart(2, "0")}</div>
            <div className="text-[11px] font-sans text-zinc-500">Passed</div>
          </div>
          <div>
            <div className="text-lg font-bold text-black">{String(warned).padStart(2, "0")}</div>
            <div className="text-[11px] font-sans text-zinc-500">Warnings</div>
          </div>
          <div>
            <div className="text-lg font-bold text-black">{String(failed).padStart(2, "0")}</div>
            <div className="text-[11px] font-sans text-zinc-500">Failures</div>
          </div>
          <div>
            <div className="text-lg font-bold text-zinc-500">{String(skipped).padStart(2, "0")}</div>
            <div className="text-[11px] font-sans text-zinc-500">Skipped</div>
          </div>
        </div>
      </div>

      {/* Novabench-Style Score & Key Health Summary Card */}
      {hasAdvancedChips && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 space-y-4">
          {userbenchmarkComparison && (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <span className="px-3.5 py-1.5 rounded-full bg-blue-600 text-white font-bold text-sm">
                    {userbenchmarkComparison.overallVehicleTier}
                  </span>
                  <div>
                    <div className="text-sm font-bold text-black">Performance Rating</div>
                    <div className="text-xs text-zinc-500">{userbenchmarkComparison.headlineSummary}</div>
                  </div>
                </div>
                <span className="text-xs font-mono text-zinc-500">UserBenchmark Calibrated</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                {[
                  { label: "Desktop", pct: userbenchmarkComparison.desktopPct },
                  { label: "Gaming", pct: userbenchmarkComparison.gamingPct },
                  { label: "Workstation", pct: userbenchmarkComparison.workstationPct },
                ].map((bar) => (
                  <div key={bar.label} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-600">{bar.label}</span>
                      <span className="font-mono font-bold text-black">{bar.pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-600"
                        style={{ width: `${Math.min(100, Math.max(5, bar.pct))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(batteryDischargeResult || touchscreenResult || networkReport) && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-zinc-100 text-xs">
              {batteryDischargeResult && (
                <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-600">Battery Discharge</span>
                    <span className="px-2 py-0.5 rounded-full bg-black text-white font-mono text-[10px] font-bold">
                      {batteryDischargeResult.verdict}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs font-bold text-black">
                    Sag {batteryDischargeResult.voltageSagMv.toFixed(0)} mV • CV {batteryDischargeResult.powerCvPct.toFixed(1)}%
                  </div>
                </div>
              )}

              {touchscreenResult && (
                <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-600">Touchscreen</span>
                    <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white font-mono text-[10px] font-bold">
                      {touchscreenResult.verdict}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs font-bold text-black">
                    {touchscreenResult.touchCapable
                      ? `${touchscreenResult.coveragePct.toFixed(0)}% • ${touchscreenResult.maxSimultaneousTouches}-Pt`
                      : "Non-Touch"}
                  </div>
                </div>
              )}

              {networkReport && (
                <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-600">Network</span>
                    <span className="px-2 py-0.5 rounded-full bg-black text-white font-mono text-[10px] font-bold">
                      {networkReport.verdict}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs font-bold text-black">
                    {networkReport.linkSpeedMbps != null ? `${networkReport.linkSpeedMbps.toFixed(0)} Mbps` : "Link OK"}
                    {networkReport.gatewayPingMs != null ? ` • ${networkReport.gatewayPingMs.toFixed(1)} ms` : ""}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Clean, Easy-to-Scan 14-Step QC Checklist */}
      <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-200 flex items-center justify-between">
          <span className="text-sm font-bold text-black">
            {stepOrder.length}-Step QC Checklist
          </span>
          <span className="text-xs text-zinc-500">
            Step-by-step • Skip allowed anytime
          </span>
        </div>

        <div className="overflow-x-auto">
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
                        ? "bg-blue-50/50 hover:bg-blue-50 cursor-pointer"
                        : isUnlocked
                        ? "bg-white hover:bg-zinc-50 cursor-pointer"
                        : "bg-white text-zinc-400"
                    }`}
                  >
                    <td className="py-2.5 pl-5 pr-2 w-12">
                      <span
                        className={`w-7 h-7 rounded-full font-mono text-[11px] font-bold flex items-center justify-center ${
                          isCurrent
                            ? "bg-blue-600 text-white"
                            : isUnlocked
                            ? "bg-zinc-100 text-black"
                            : "bg-zinc-50 text-zinc-400"
                        }`}
                      >
                        {num}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 w-56">
                      <div className={`text-sm font-semibold truncate ${isUnlocked ? "text-black" : "text-zinc-400"}`}>
                        {mod.name}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-xs text-zinc-500 max-w-md truncate">
                      {!isUnlocked
                        ? `Unlocks after Step ${String(idx).padStart(2, "0")}`
                        : mod.summary || "Ready to run"}
                    </td>
                    <td className="py-2.5 pl-2 pr-5 text-right w-28">
                      <div className="inline-flex items-center justify-end gap-2">
                        {!isUnlocked ? (
                          <Lock className="w-3.5 h-3.5 text-zinc-300" />
                        ) : (
                          <>
                            <StatusBadge status={mod.status} compact />
                            <ChevronRight className="w-4 h-4 text-zinc-400" />
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

      {/* Quiet Attribution Footer */}
      <div className="px-2 py-1 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>Offline Native Rust Diagnostics • SHA-256 Certificates</span>
        <span className="font-semibold text-black inline-flex items-center gap-1.5">
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
                <div className="rounded-[2px] bg-black text-white p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span
                      className={`font-mono text-[10px] font-bold uppercase tracking-widest ${
                        isMonochromeBadge ? "text-zinc-400" : "text-blue-400"
                      }`}
                    >
                      MARATHON FINAL VERDICT
                    </span>
                    <span
                      data-testid="burnin-verdict-badge"
                      className={`px-2.5 py-0.5 rounded-[2px] font-mono text-xs font-black ${
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
                  <div className="font-mono text-xs text-zinc-200">{burnInRes.summary}</div>
                  {burnInRes.tortureResult?.batteryDrainWhilePlugged && (
                    <div className="text-xs text-zinc-200 font-bold flex items-center gap-1.5 pt-1">
                      <ShieldAlert className="w-4 h-4" /> AC Charger Drain Detected Under Combined Load!
                    </div>
                  )}
                </div>
              );
            })()}
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
                  NO MODEL RECORDS YET — COMPLETE STAGE {perfStageNum} TO AUTO-CALIBRATE YOUR FIRST LAPTOP MODEL.
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
