import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  BatteryHealthReport,
  BatterySagResult,
  ErrorLogsReport,
  ExportReportPayload,
  ExportedReportPaths,
  GpuStressResult,
  ModuleRecord,
  PerfBenchResult,
  PortsSpeakerSignoff,
  PowerTortureResult,
  RamTestResult,
  SecurityAuditReport,
  ShopProfile,
  StepModuleId,
  StorageBenchResult,
  StorageSmartReport,
  SubsystemScoreBar,
  SystemSpecs,
  VramTestResult,
} from "../types";

interface PreReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shopProfile: ShopProfile;
  onUpdateProfile: (profile: ShopProfile) => void;
  specs: SystemSpecs | null;
  stepOrder: StepModuleId[];
  modules: Record<StepModuleId, ModuleRecord>;
  signoff: PortsSpeakerSignoff;
  securityReport?: SecurityAuditReport | null;
  batteryReport?: BatteryHealthReport | null;
  batterySagResult?: BatterySagResult | null;
  errorLogsReport?: ErrorLogsReport | null;
  smartReport?: StorageSmartReport | null;
  storageBench?: StorageBenchResult | null;
  ramResult?: RamTestResult | null;
  perfResult?: PerfBenchResult | null;
  gpuResult?: GpuStressResult | null;
  vramResult?: VramTestResult | null;
  tortureResult?: PowerTortureResult | null;
}

export const PreReportModal: React.FC<PreReportModalProps> = ({
  isOpen,
  onClose,
  shopProfile,
  onUpdateProfile,
  specs,
  stepOrder,
  modules,
  signoff,
  securityReport,
  batteryReport,
  batterySagResult,
  errorLogsReport,
  smartReport,
  storageBench,
  ramResult,
  perfResult,
  gpuResult,
  vramResult,
  tortureResult,
}) => {
  const [profile, setProfile] = useState<ShopProfile>(shopProfile);
  useEffect(() => {
    setProfile(shopProfile);
  }, [shopProfile, isOpen]);

  const [customerOrSku, setCustomerOrSku] = useState("");
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportedReportPaths | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const list = stepOrder.map((id) => modules[id]);
  const passCount = list.filter((m) => m.status === "pass").length;
  const failCount = list.filter((m) => m.status === "fail").length;
  const warnCount = list.filter((m) => m.status === "warn").length;
  const skippedCount = list.filter((m) => m.status === "skipped").length;
  const pendingCount = list.filter((m) => m.status === "pending" || m.status === "running").length;

  const overallVerdict =
    failCount > 0
      ? "FAILED"
      : pendingCount > 0
      ? "INCOMPLETE"
      : warnCount > 0 || skippedCount > 0
      ? "PASSED WITH WARNINGS"
      : "PASSED";

  const durabilityGrade =
    failCount > 0
      ? "FAIL"
      : tortureResult?.durabilityGrade && tortureResult.durabilityGrade !== "CANCELLED"
      ? tortureResult.durabilityGrade
      : perfResult?.durabilityGrade && perfResult.durabilityGrade !== "CANCELLED"
      ? perfResult.durabilityGrade
      : warnCount > 0
      ? "B"
      : "A";

  // Build Visual Subsystem Health & Performance Score Bars for Page 1 Executive Certificate
  const subsystemScores: SubsystemScoreBar[] = [];
  if (batteryReport?.present) {
    const pct = batteryReport.healthPercent ?? 85;
    subsystemScores.push({
      label: "Battery Health",
      scorePct: Math.max(5, Math.min(100, pct)),
      metricText: `${pct.toFixed(1)}% capacity${batteryReport.cycleCount != null ? ` • ${batteryReport.cycleCount} cycles` : ""}`,
      statusLabel: pct >= 80 ? "PASS" : pct >= 60 ? "WARN" : "LOW",
    });
  }
  if (storageBench) {
    subsystemScores.push({
      label: "SSD Direct-IO",
      scorePct: Math.max(5, Math.min(100, storageBench.baseline.percentOfNormal)),
      metricText: `R ${storageBench.seqReadMbS.toFixed(0)} / W ${storageBench.seqWriteMbS.toFixed(0)} MB/s • ${storageBench.integrityErrors} err`,
      statusLabel: storageBench.integrityErrors > 0 ? "FAIL" : storageBench.baseline.grade,
    });
  }
  if (ramResult) {
    subsystemScores.push({
      label: "RAM Stability (TM5)",
      scorePct: ramResult.errorsFound > 0 ? 15 : Math.max(10, Math.min(100, ramResult.baseline.percentOfNormal)),
      metricText: `${ramResult.totalGbVerified.toFixed(1)} GB verified • ${ramResult.errorsFound} bit errors`,
      statusLabel: ramResult.errorsFound > 0 ? "FAIL" : "0 ERR PASS",
    });
  }
  if (perfResult) {
    subsystemScores.push({
      label: "360° CPU & Creator",
      scorePct: Math.max(5, Math.min(100, perfResult.baseline.percentOfNormal)),
      metricText: `Mark ${perfResult.compositeScore} (Office ${perfResult.officeScore} / Creator ${perfResult.creatorScore}) • -${perfResult.throttleDropPct.toFixed(1)}%`,
      statusLabel: `GRADE ${perfResult.durabilityGrade}`,
    });
  }
  if (gpuResult || vramResult || tortureResult) {
    const anyFail = gpuResult?.status === "fail" || vramResult?.status === "fail" || tortureResult?.status === "fail";
    const pct = anyFail
      ? 15
      : gpuResult?.baseline.percentOfNormal ?? tortureResult?.baseline.percentOfNormal ?? vramResult?.baseline.percentOfNormal ?? 95;
    const detail = [
      gpuResult ? `${gpuResult.avgFps.toFixed(1)} FPS` : null,
      vramResult ? `VRAM ${vramResult.errorsFound} err` : null,
      tortureResult ? (tortureResult.batteryDrainWhilePlugged ? "AC Drain Warn" : "Power OK") : null,
    ]
      .filter(Boolean)
      .join(" • ");
    subsystemScores.push({
      label: "GPU / VRAM / Power",
      scorePct: Math.max(5, Math.min(100, pct)),
      metricText: detail,
      statusLabel: anyFail ? "FAIL" : "VERIFIED",
    });
  }

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setProfile((p) => ({ ...p, logoDataUrl: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setProfile((p) => ({ ...p, defaultOutputDir: selected }));
      }
    } catch {
      // Cancelled
    }
  };

  const buildStageMetrics = (id: StepModuleId): [string, string][] => {
    const out: [string, string][] = [];
    if (id === "specs" && specs) {
      out.push(["CPU", `${specs.cpuPhysicalCores}C/${specs.cpuLogicalCores}T`]);
      out.push(["RAM", `${specs.totalRamGb.toFixed(0)} GB${specs.ramChannelMode ? ` (${specs.ramChannelMode})` : ""}`]);
      if (specs.wifiSignalPct != null) out.push(["Wi-Fi RSSI", `${specs.wifiSignalPct}% (${specs.wifiRssiDbm ?? "—"} dBm)`]);
    } else if (id === "security" && securityReport) {
      out.push(["MDM", securityReport.mdmEnrolled === true ? "ENROLLED" : "Clean"]);
      if (securityReport.activationLocked != null) {
        out.push(["Activation Lock", securityReport.activationLocked ? "LOCKED" : "Clean"]);
      }
    } else if (id === "battery" && batteryReport?.present) {
      if (batteryReport.healthPercent != null) out.push(["Health", `${batteryReport.healthPercent.toFixed(1)}%`]);
      if (batteryReport.cycleCount != null) out.push(["Cycles", `${batteryReport.cycleCount}`]);
      if (batterySagResult) {
        out.push(["15s Sag", `${batterySagResult.maxVoltageSagMv} mV (-${batterySagResult.chargeDropPct.toFixed(1)}%)`]);
      }
    } else if (id === "logs" && errorLogsReport) {
      out.push(["BSOD/Panics", `${errorLogsReport.bsodOrPanicCount}`]);
      out.push(["WHEA HW", `${errorLogsReport.wheaOrHwCount}`]);
      out.push(["Disk Err", `${errorLogsReport.diskErrorCount}`]);
      out.push(["GPU TDR", `${errorLogsReport.gpuResetCount}`]);
    } else if (id === "storage") {
      const d = smartReport?.drives[0];
      if (d?.healthPercent != null) out.push(["SMART Health", `${d.healthPercent}%`]);
      if (d?.tbwGb != null) out.push(["TBW", `${(d.tbwGb / 1000).toFixed(1)} TB`]);
      if (storageBench) {
        out.push(["Seq Read", `${storageBench.seqReadMbS.toFixed(0)} MB/s`]);
        out.push(["Seq Write", `${storageBench.seqWriteMbS.toFixed(0)} MB/s`]);
        out.push(["4K P99", `${storageBench.p994kLatencyMs.toFixed(2)} ms`]);
        out.push(["Verify Err", `${storageBench.integrityErrors}`]);
      }
    } else if (id === "ram" && ramResult) {
      out.push(["Verified", `${ramResult.totalGbVerified.toFixed(1)} GB`]);
      out.push(["Peak BW", `${ramResult.peakBandwidthGbS.toFixed(1)} GB/s`]);
      out.push(["Bit Errors", `${ramResult.errorsFound}`]);
    } else if (id === "performance" && perfResult) {
      out.push(["Composite", `${perfResult.compositeScore}`]);
      out.push(["Office", `${perfResult.officeScore}`]);
      out.push(["Creator", `${perfResult.creatorScore} (${perfResult.creatorMegaRaysS.toFixed(1)} MRays/s)`]);
      out.push(["Memory", `${perfResult.memoryMark} (${perfResult.memoryLatencyNs.toFixed(1)} ns)`]);
      out.push(["Throttle", `-${perfResult.throttleDropPct.toFixed(1)}%`]);
    } else if (id === "gpu") {
      if (gpuResult) {
        out.push(["FurMark", `${gpuResult.avgFps.toFixed(1)} FPS (1% Low ${gpuResult.low1pctFps.toFixed(1)})`]);
        out.push(["GPU Drop", `-${gpuResult.fpsDropPct.toFixed(1)}%`]);
      }
      if (vramResult) {
        out.push(["VRAM", `${vramResult.errorsFound} err (${vramResult.totalGbVerified.toFixed(1)} GB)`]);
      }
      if (tortureResult) {
        out.push(["AC Drain", tortureResult.batteryDrainWhilePlugged ? "ALERT" : "Stable"]);
      }
    }
    return out;
  };

  const handleExport = async () => {
    if (!profile.shopName.trim() && !profile.technicianName.trim()) {
      setError("Please enter at least a Shop Name or Technician Username.");
      return;
    }
    setError(null);
    setExporting(true);
    try {
      onUpdateProfile(profile);
      const payload: ExportReportPayload = {
        shopProfile: profile,
        customerOrSku,
        technicianNotes,
        overallVerdict,
        durabilityGrade,
        subsystemScores,
        specs,
        tests: list.map((m) => ({
          id: m.id,
          name: `${String(m.stepNumber).padStart(2, "0")}. ${m.name}`,
          category: m.category,
          status: m.status,
          summary: m.summary || "Not run",
          metrics: buildStageMetrics(m.id),
          notes: m.notes,
        })),
        signoff,
        outputDir: profile.defaultOutputDir,
      };
      const result = await invoke<ExportedReportPaths>("export_qc_report", { payload });
      setExported(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-white border border-black rounded-[2px] w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Top Modal Header */}
        <div className="px-5 py-3.5 bg-black text-white flex items-center justify-between border-b border-zinc-800">
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-blue-400">
              SWISS LAB CALIBRATION CERTIFICATE GENERATOR
            </div>
            <h2 className="text-base font-black tracking-tight mt-0.5">
              Issue Branded Hardware Certificate (PDF + HTML + Tamper-Check JSON)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 2-Column Split: Form Controls (Left) + Live Certificate Preview (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 overflow-y-auto divide-y lg:divide-y-0 lg:divide-x divide-zinc-300">
          {/* Left Form */}
          <div className="lg:col-span-5 p-5 space-y-3.5 bg-[#FAFAFA]">
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              Certificate Metadata &amp; Shop Identity
            </div>

            <div className="space-y-3">
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-black mb-1">
                  Shop / Lab Name (Saved)
                </label>
                <input
                  type="text"
                  value={profile.shopName}
                  onChange={(e) => setProfile((p) => ({ ...p, shopName: e.target.value }))}
                  placeholder="e.g. ProTech Laptop Store"
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-1.5 text-xs text-black"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-black mb-1">
                  Technician Username (Saved)
                </label>
                <input
                  type="text"
                  value={profile.technicianName}
                  onChange={(e) => setProfile((p) => ({ ...p, technicianName: e.target.value }))}
                  placeholder="e.g. Hein Htet Zaw"
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-1.5 text-xs text-black"
                />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-mono text-[10px] font-bold uppercase text-black mb-1">
                    Customer / SKU
                  </label>
                  <input
                    type="text"
                    value={customerOrSku}
                    onChange={(e) => setCustomerOrSku(e.target.value)}
                    placeholder="SKU-2026-041"
                    className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] font-bold uppercase text-black mb-1">
                    Shop Logo
                  </label>
                  <label className="cursor-pointer flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-[2px] bg-white border border-zinc-300 hover:border-blue-600 font-mono text-[11px] font-bold text-black">
                    <ImageIcon className="w-3.5 h-3.5 text-blue-600" />
                    {profile.logoDataUrl ? "Change" : "Upload"}
                    <input type="file" accept="image/png,image/jpeg" onChange={handleLogoUpload} className="hidden" />
                  </label>
                </div>
              </div>

              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-black mb-1">
                  Technician Remarks
                </label>
                <textarea
                  rows={2}
                  value={technicianNotes}
                  onChange={(e) => setTechnicianNotes(e.target.value)}
                  placeholder="e.g. Clean Grade A unit, thermal paste verified, original adapter tested."
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-1.5 text-xs text-black"
                />
              </div>

              <div className="flex items-center justify-between gap-2 bg-white border border-zinc-300 rounded-[2px] px-3 py-2">
                <div className="min-w-0">
                  <div className="font-mono text-[9.5px] uppercase text-zinc-500">Export Directory</div>
                  <div className="text-[11px] text-black truncate font-mono">
                    {profile.defaultOutputDir || "Documents/LaptopBenchQC/Reports"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleChooseFolder}
                  className="shrink-0 px-2.5 py-1 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[10px] font-bold uppercase text-black flex items-center gap-1 cursor-pointer"
                >
                  <FolderOpen className="w-3 h-3" /> Browse
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{error}</div>
            )}

            {exported && (
              <div className="rounded-[2px] bg-blue-50/50 border border-blue-600 p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-blue-800 font-mono font-bold text-xs uppercase">
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
                  Certificate Issued Successfully
                </div>
                <div className="text-[10.5px] text-zinc-700 font-mono break-all">{exported.directory}</div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <button
                    onClick={() => openPath(exported.pdfPath)}
                    className="px-3 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono font-bold text-[10.5px] uppercase flex items-center gap-1 cursor-pointer"
                  >
                    <FileText className="w-3 h-3" /> Open PDF
                  </button>
                  <button
                    onClick={() => openPath(exported.htmlPath)}
                    className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono font-bold text-[10.5px] uppercase cursor-pointer"
                  >
                    Open HTML
                  </button>
                  <button
                    onClick={() => openPath(exported.directory)}
                    className="px-3 py-1.5 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono font-bold text-[10.5px] uppercase flex items-center gap-1 cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3" /> Folder
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Live Executive Certificate Sheet Preview */}
          <div className="lg:col-span-7 p-5 bg-[#F4F4F5] overflow-y-auto">
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2 flex items-center justify-between">
              <span>Live Page-1 Executive Certificate Preview</span>
              <span>A4 Print-Ready • 2-Tier Dossier</span>
            </div>

            <div className="bg-white border border-zinc-300 border-t-4 border-t-blue-600 p-5 space-y-4 shadow-sm">
              {/* Preview Masthead */}
              <div className="flex items-start justify-between gap-3 pb-3 border-b-2 border-black">
                <div className="flex items-center gap-3 min-w-0">
                  {profile.logoDataUrl && (
                    <img
                      src={profile.logoDataUrl}
                      alt="Shop Logo"
                      className="h-10 w-10 object-contain border border-zinc-300 p-0.5 shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="font-mono text-[8.5px] font-bold uppercase tracking-[0.14em] text-blue-700">
                      OFFICIAL HARDWARE CALIBRATION CERTIFICATE
                    </div>
                    <div className="text-base font-black text-black truncate">
                      {profile.shopName.trim() || "YOUR SHOP NAME"}
                    </div>
                    <div className="font-mono text-[9.5px] text-zinc-500">
                      TECH: {profile.technicianName.trim() || "Technician"}
                      {customerOrSku ? ` • REF: ${customerOrSku}` : ""} • SHA-256 SEALED
                    </div>
                  </div>
                </div>
                <div
                  className={`px-3 py-2 font-mono shrink-0 text-white ${
                    overallVerdict === "FAILED" ? "bg-black" : "bg-blue-600"
                  }`}
                >
                  <div className="text-[8px] uppercase tracking-widest opacity-80">VERDICT</div>
                  <div className="text-xs font-black leading-tight">{overallVerdict}</div>
                  <div className="text-[9.5px] font-bold text-blue-100 mt-0.5">GRADE: {durabilityGrade}</div>
                </div>
              </div>

              {/* Preview Counters */}
              <div className="grid grid-cols-4 border border-zinc-300 divide-x divide-zinc-300 bg-[#F8FAFC] font-mono tabular-nums text-center">
                <div className="py-1.5">
                  <div className="text-[8px] uppercase text-zinc-500">Pass</div>
                  <div className="text-sm font-black text-blue-600">{String(passCount).padStart(2, "0")}</div>
                </div>
                <div className="py-1.5">
                  <div className="text-[8px] uppercase text-zinc-500">Warn</div>
                  <div className="text-sm font-black text-black">{String(warnCount).padStart(2, "0")}</div>
                </div>
                <div className="py-1.5">
                  <div className="text-[8px] uppercase text-zinc-500">Fail</div>
                  <div className="text-sm font-black text-black">{String(failCount).padStart(2, "0")}</div>
                </div>
                <div className="py-1.5">
                  <div className="text-[8px] uppercase text-zinc-500">Skip</div>
                  <div className="text-sm font-black text-zinc-500">{String(skippedCount).padStart(2, "0")}</div>
                </div>
              </div>

              {/* Preview Device Identity */}
              {specs && (
                <div className="space-y-1">
                  <div className="font-mono text-[9px] font-bold uppercase tracking-wider border-b border-black pb-0.5">
                    01 // VERIFIED DEVICE IDENTITY
                  </div>
                  <div className="grid grid-cols-2 border border-zinc-300 text-[10px]">
                    <div className="px-2 py-1 border-b border-r border-zinc-200">
                      <span className="block font-mono text-[8px] text-zinc-500">MODEL</span>
                      <strong className="text-black">{specs.manufacturer} {specs.model}</strong>
                    </div>
                    <div className="px-2 py-1 border-b border-zinc-200">
                      <span className="block font-mono text-[8px] text-zinc-500">SERIAL NUMBER</span>
                      <strong className="font-mono text-black">{specs.serialNumber}</strong>
                    </div>
                    <div className="px-2 py-1 border-r border-zinc-200">
                      <span className="block font-mono text-[8px] text-zinc-500">PROCESSOR</span>
                      <strong className="text-black truncate block">{specs.cpuBrand}</strong>
                    </div>
                    <div className="px-2 py-1">
                      <span className="block font-mono text-[8px] text-zinc-500">MEMORY &amp; OS</span>
                      <strong className="text-black">{specs.totalRamGb.toFixed(0)} GB • {specs.osName}</strong>
                    </div>
                  </div>
                </div>
              )}

              {/* Preview Subsystem Score Bars */}
              <div className="space-y-1.5">
                <div className="font-mono text-[9px] font-bold uppercase tracking-wider border-b border-black pb-0.5">
                  02 // SUBSYSTEM HEALTH &amp; CALIBRATION BARS
                </div>
                {subsystemScores.length === 0 ? (
                  <div className="font-mono text-[10px] text-zinc-500 py-2">
                    Complete hardware stress modules to populate calibration bars (full 13-stage audit ledger exports on Page 2).
                  </div>
                ) : (
                  <div className="border border-zinc-300 divide-y divide-zinc-200">
                    {subsystemScores.map((b) => {
                      const bad = b.statusLabel.includes("FAIL");
                      return (
                        <div key={b.label} className="px-2.5 py-1.5 space-y-1">
                          <div className="flex items-center justify-between text-[10px]">
                            <strong className="text-black">{b.label}</strong>
                            <span className="font-mono text-zinc-600 truncate mx-2">{b.metricText}</span>
                            <span className={`font-mono font-bold ${bad ? "text-black" : "text-blue-700"}`}>
                              {b.statusLabel}
                            </span>
                          </div>
                          <div className="h-1.5 bg-zinc-200">
                            <div
                              className={bad ? "h-full bg-black" : "h-full bg-blue-600"}
                              style={{ width: `${Math.max(4, Math.min(100, b.scorePct))}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Dual Signature Footer Preview */}
              <div className="grid grid-cols-2 gap-6 pt-4 font-mono text-[9px] uppercase text-zinc-600">
                <div className="border-t border-black pt-1 text-black font-bold">
                  Technician: {profile.technicianName.trim() || "—"}
                </div>
                <div className="border-t border-black pt-1">Customer / Buyer Acceptance</div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-300 bg-white flex items-center justify-between gap-2.5">
          <div className="text-[11px] text-zinc-600 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
            <span>
              Created by <strong className="text-black">Hein Htet Zaw</strong>
            </span>
            <span className="text-blue-700 font-mono inline-flex items-center gap-0.5">
              (<Send className="w-2.5 h-2.5" />@ich8g92)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black font-mono text-xs font-bold uppercase text-black cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-5 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-mono font-bold text-xs uppercase cursor-pointer"
            >
              {exporting ? "Generating PDF + HTML + JSON..." : "Issue Official QC Certificate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
