import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Award,
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  BatteryDischargeResult,
  BatteryHealthReport,
  BatterySagResult,
  CpuStressResult,
  ErrorLogsReport,
  ExportReportPayload,
  ExportedReportPaths,
  GpuStressResult,
  ModuleRecord,
  NetworkDiagnosticsReport,
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
  TouchscreenTestResult,
  UserBenchmarkComparison,
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
  batteryDischargeResult?: BatteryDischargeResult | null;
  errorLogsReport?: ErrorLogsReport | null;
  smartReport?: StorageSmartReport | null;
  storageBench?: StorageBenchResult | null;
  touchscreenResult?: TouchscreenTestResult | null;
  ramResult?: RamTestResult | null;
  perfResult?: PerfBenchResult | null;
  cpuStressResult?: CpuStressResult | null;
  gpuResult?: GpuStressResult | null;
  vramResult?: VramTestResult | null;
  tortureResult?: PowerTortureResult | null;
  networkReport?: NetworkDiagnosticsReport | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
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
  batteryDischargeResult,
  errorLogsReport,
  smartReport,
  storageBench,
  touchscreenResult,
  ramResult,
  perfResult,
  cpuStressResult,
  gpuResult,
  vramResult,
  tortureResult,
  networkReport,
  userbenchmarkComparison,
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
  const naCount = list.filter((m) => m.status === "notApplicable").length;
  const skippedOrNaCount = skippedCount + naCount;
  const pendingCount = list.filter((m) => m.status === "pending" || m.status === "running").length;

  const overallVerdict =
    failCount > 0
      ? "FAILED"
      : pendingCount > 0
      ? "INCOMPLETE"
      : warnCount > 0 || skippedCount > 0
      ? "PASSED WITH WARNINGS"
      : "PASSED";

  const plainVerdictSummary =
    overallVerdict === "FAILED"
      ? `${failCount} diagnostic stage(s) failed critical hardware or safety checks. Review failed subsystems before resale or purchase.`
      : overallVerdict === "INCOMPLETE"
      ? `${pendingCount} stage(s) have not been completed yet. Finish or explicitly skip remaining stages for a full ${stepOrder.length}-stage certificate.`
      : overallVerdict === "PASSED WITH WARNINGS"
      ? `Core hardware passed without critical faults, with ${warnCount} warning(s) and ${skippedCount} skipped stage(s)${
          naCount > 0 ? ` (${naCount} N/A stage(s))` : ""
        } noted for buyer transparency.`
      : naCount > 0
      ? `All ${stepOrder.length - naCount} applicable diagnostic stages passed within healthy factory safety and performance thresholds (${naCount} N/A stage(s) noted).`
      : `All ${stepOrder.length} diagnostic stages passed within healthy factory safety and performance thresholds.`;

  const rawDurabilityGrade =
    failCount > 0
      ? "FAIL"
      : tortureResult?.durabilityGrade &&
        !tortureResult.cancelled &&
        tortureResult.durabilityGrade !== "CANCELLED"
      ? tortureResult.durabilityGrade
      : perfResult?.durabilityGrade &&
        !perfResult.cancelled &&
        perfResult.durabilityGrade !== "CANCELLED"
      ? perfResult.durabilityGrade
      : warnCount > 0 || skippedCount > 0
      ? "B"
      : "A";

  const durabilityGrade =
    skippedCount > 0 && (rawDurabilityGrade === "A+" || rawDurabilityGrade === "A")
      ? "B"
      : rawDurabilityGrade;

  const effectiveSsdUb = userbenchmarkComparison?.ssd ?? storageBench?.userbenchmarkRating ?? null;
  const effectiveRamUb = userbenchmarkComparison?.ram ?? ramResult?.userbenchmarkRating ?? null;
  const effectiveCpuUb = userbenchmarkComparison?.cpu ?? perfResult?.userbenchmarkRating ?? null;
  const effectiveGpuUb = userbenchmarkComparison?.gpu ?? gpuResult?.userbenchmarkRating ?? null;

  // Build Visual Subsystem Health & Performance Score Bars for Page 1 Executive Certificate
  const subsystemScores: SubsystemScoreBar[] = [];
  if (
    batteryReport?.present ||
    (batteryDischargeResult && batteryDischargeResult.verdict !== "NOT_APPLICABLE")
  ) {
    const hasCapacity = batteryReport?.healthPercent != null;
    const dischargeVerdict = batteryDischargeResult?.verdict;
    const pct = hasCapacity
      ? (batteryReport!.healthPercent as number)
      : dischargeVerdict === "NORMAL"
      ? 88
      : dischargeVerdict === "ABNORMAL"
      ? 45
      : 75;
    const cyclePart =
      batteryReport?.cycleCount != null ? ` • ${batteryReport.cycleCount} cycles` : "";
    const dischargeTag = batteryDischargeResult
      ? ` • Discharge ${batteryDischargeResult.verdict}`
      : "";
    const metricText = hasCapacity
      ? `${pct.toFixed(1)}% capacity${cyclePart}${dischargeTag}`
      : batteryDischargeResult
      ? `Discharge ${batteryDischargeResult.verdict}${cyclePart}`
      : `Present${cyclePart}`;
    const statusLabel =
      dischargeVerdict === "ABNORMAL"
        ? "ABNORMAL"
        : hasCapacity && pct < 60
        ? "LOW"
        : dischargeVerdict === "CANCELLED"
        ? "CANCELLED"
        : dischargeVerdict &&
          dischargeVerdict !== "NORMAL" &&
          dischargeVerdict !== "NOT_APPLICABLE"
        ? dischargeVerdict
        : hasCapacity
        ? pct >= 80
          ? "PASS"
          : "WARN"
        : dischargeVerdict ?? "PASS";
    subsystemScores.push({
      label: "Battery Health & Discharge",
      scorePct: Math.max(5, Math.min(100, pct)),
      metricText,
      statusLabel,
    });
  }
  if (storageBench) {
    const ssdFail =
      storageBench.integrityErrors > 0 ||
      Boolean(storageBench.thermalCutoffTriggered) ||
      storageBench.status === "fail";
    const ssdWarn = !ssdFail && storageBench.status === "warn";
    const ssdThermalTag = storageBench.thermalCutoffTriggered ? " • Thermal Cutoff" : "";
    subsystemScores.push({
      label: "SSD Direct-IO",
      scorePct: ssdFail
        ? 15
        : ssdWarn
        ? Math.max(5, Math.min(75, storageBench.baseline.percentOfNormal))
        : Math.max(5, Math.min(100, storageBench.baseline.percentOfNormal)),
      metricText: `R ${storageBench.seqReadMbS.toFixed(0)} / W ${storageBench.seqWriteMbS.toFixed(
        0
      )} MB/s${
        effectiveSsdUb ? ` • UB ${effectiveSsdUb.vehicleTier}` : ""
      } • ${storageBench.integrityErrors} err${ssdThermalTag}`,
      statusLabel: ssdFail
        ? "FAIL"
        : ssdWarn
        ? "WARN"
        : storageBench.baseline.grade,
    });
  } else if (smartReport?.drives[0]) {
    const d = smartReport.drives[0];
    const wearVal = d.percentageUsedRaw ?? d.wearPercent;
    const spareLow =
      d.availableSparePct != null &&
      d.availableSpareThresholdPct != null &&
      d.availableSparePct <= d.availableSpareThresholdPct;
    const isFail =
      smartReport.status === "fail" ||
      d.status === "fail" ||
      (d.mediaErrors ?? 0) > 0 ||
      spareLow ||
      (wearVal ?? 0) >= 100;
    const isWarn =
      !isFail &&
      (smartReport.status === "warn" ||
        d.status === "warn" ||
        (wearVal ?? 0) >= 80 ||
        (d.unsafeShutdowns ?? 0) >= 50);
    const scorePct =
      d.healthPercent != null
        ? Math.max(5, Math.min(100, d.healthPercent))
        : isFail
        ? 10
        : isWarn
        ? 60
        : 90;
    const parts = [
      wearVal != null ? `${wearVal}% used` : null,
      d.availableSparePct != null ? `${d.availableSparePct}% spare` : null,
      d.mediaErrors != null ? `${d.mediaErrors} media err` : null,
      d.unsafeShutdowns != null ? `${d.unsafeShutdowns} unsafe off` : null,
    ].filter(Boolean);
    subsystemScores.push({
      label: "SSD SMART (Log 0x02)",
      scorePct,
      metricText: parts.length > 0 ? parts.join(" • ") : d.healthStatus,
      statusLabel: isFail ? "FAIL" : isWarn ? "WARN" : "PASS",
    });
  }
  if (touchscreenResult && touchscreenResult.touchCapable) {
    subsystemScores.push({
      label: "Touchscreen Digitizer",
      scorePct: Math.max(5, Math.min(100, touchscreenResult.coveragePct)),
      metricText: `${touchscreenResult.coveredCells}/${touchscreenResult.totalCells} cells (${touchscreenResult.coveragePct.toFixed(
        0
      )}%) • ${touchscreenResult.maxSimultaneousTouches}-pt • ${touchscreenResult.pollingHz}Hz`,
      statusLabel: touchscreenResult.verdict,
    });
  }
  if (cpuStressResult) {
    const csFail =
      cpuStressResult.totalErrors > 0 ||
      cpuStressResult.thermalCutoffTriggered ||
      cpuStressResult.status === "fail";
    const csCancelled = !csFail && Boolean(cpuStressResult.cancelled);
    const csWarn = !csFail && !csCancelled && cpuStressResult.status === "warn";
    const cdTag =
      cpuStressResult.cooldownDropC != null
        ? ` • Cool-Down -${cpuStressResult.cooldownDropC.toFixed(1)}°C`
        : "";
    subsystemScores.push({
      label: "OCCT CPU Stress & Cool-Down",
      scorePct: csFail
        ? 15
        : csCancelled
        ? 50
        : csWarn
        ? 70
        : Math.max(60, Math.min(100, Math.round(100 - cpuStressResult.throttleDropPct))),
      metricText: `${cpuStressResult.totalErrors} err • ${cpuStressResult.avgClockMhz} MHz • Throttle ${cpuStressResult.throttleDropPct.toFixed(1)}%${cdTag}`,
      statusLabel: csFail
        ? "FAIL"
        : csCancelled
        ? "CANCELLED"
        : csWarn
        ? "WARN"
        : "0 ERR PASS",
    });
  }
  if (ramResult) {
    const ramFail =
      ramResult.errorsFound > 0 ||
      Boolean(ramResult.thermalCutoffTriggered) ||
      ramResult.status === "fail";
    const ramCancelled = !ramFail && Boolean(ramResult.cancelled);
    const ramWarn = !ramFail && !ramCancelled && ramResult.status === "warn";
    const ramThermalTag = ramResult.thermalCutoffTriggered ? " • Thermal Cutoff" : "";
    subsystemScores.push({
      label: "RAM Stability (TM5)",
      scorePct: ramFail
        ? 15
        : ramCancelled
        ? Math.max(10, Math.min(60, ramResult.baseline.percentOfNormal))
        : ramWarn
        ? Math.max(10, Math.min(75, ramResult.baseline.percentOfNormal))
        : Math.max(10, Math.min(100, ramResult.baseline.percentOfNormal)),
      metricText: `${ramResult.totalGbVerified.toFixed(1)} GB verified • ${ramResult.errorsFound} bit errors${ramThermalTag}`,
      statusLabel: ramFail
        ? "FAIL"
        : ramCancelled
        ? "CANCELLED"
        : ramWarn
        ? "WARN"
        : "0 ERR PASS",
    });
  }
  if (perfResult) {
    const perfFail =
      Boolean(perfResult.thermalCutoffTriggered) || perfResult.status === "fail";
    const perfCancelled = !perfFail && Boolean(perfResult.cancelled);
    const perfWarn = !perfFail && !perfCancelled && perfResult.status === "warn";
    const perfThermalTag = perfResult.thermalCutoffTriggered ? " • Thermal Cutoff" : "";
    subsystemScores.push({
      label: "360° CPU & Creator",
      scorePct: perfFail
        ? 15
        : perfCancelled
        ? Math.max(5, Math.min(60, perfResult.baseline.percentOfNormal))
        : Math.max(5, Math.min(100, perfResult.baseline.percentOfNormal)),
      metricText: `Mark ${perfResult.compositeScore} (Office ${perfResult.officeScore} / Creator ${perfResult.creatorScore}) • -${perfResult.throttleDropPct.toFixed(1)}%${perfThermalTag}`,
      statusLabel: perfFail
        ? "FAIL"
        : perfCancelled
        ? "CANCELLED"
        : perfWarn
        ? "WARN"
        : `GRADE ${perfResult.durabilityGrade}`,
    });
  }
  if (gpuResult || vramResult || tortureResult) {
    const anyFail =
      gpuResult?.status === "fail" ||
      vramResult?.status === "fail" ||
      tortureResult?.status === "fail" ||
      Boolean(gpuResult?.thermalCutoffTriggered) ||
      Boolean(vramResult?.thermalCutoffTriggered) ||
      Boolean(tortureResult?.thermalCutoffTriggered) ||
      (gpuResult?.artifactErrors ?? 0) > 0 ||
      (vramResult?.errorsFound ?? 0) > 0 ||
      (tortureResult?.artifactErrors ?? 0) > 0;
    const anyCancelled =
      !anyFail &&
      Boolean(gpuResult?.cancelled || vramResult?.cancelled || tortureResult?.cancelled);
    const anyWarn =
      !anyFail &&
      !anyCancelled &&
      (gpuResult?.status === "warn" ||
        vramResult?.status === "warn" ||
        tortureResult?.status === "warn" ||
        Boolean(tortureResult?.batteryDrainWhilePlugged));
    const anyThermalCutoff = Boolean(
      gpuResult?.thermalCutoffTriggered ||
        vramResult?.thermalCutoffTriggered ||
        tortureResult?.thermalCutoffTriggered
    );
    const pct = anyFail
      ? 15
      : anyCancelled
      ? Math.min(
          60,
          gpuResult?.baseline.percentOfNormal ??
            tortureResult?.baseline.percentOfNormal ??
            vramResult?.baseline.percentOfNormal ??
            50
        )
      : gpuResult?.baseline.percentOfNormal ??
        tortureResult?.baseline.percentOfNormal ??
        vramResult?.baseline.percentOfNormal ??
        95;
    const detail = [
      gpuResult ? `${gpuResult.avgFps.toFixed(1)} FPS` : null,
      gpuResult?.artifactErrors != null ? `Art ${gpuResult.artifactErrors}` : null,
      vramResult ? `VRAM ${vramResult.errorsFound} err` : null,
      tortureResult
        ? tortureResult.cancelled
          ? "Power Cancelled"
          : tortureResult.batteryDrainWhilePlugged
          ? "AC Drain Warn"
          : tortureResult.thermalCutoffTriggered
          ? "Thermal Cutoff"
          : "Power OK"
        : null,
      anyThermalCutoff && !tortureResult?.thermalCutoffTriggered ? "Thermal Cutoff" : null,
    ]
      .filter(Boolean)
      .join(" • ");
    subsystemScores.push({
      label: "GPU / VRAM / Power",
      scorePct: Math.max(5, Math.min(100, pct)),
      metricText: detail,
      statusLabel: anyFail
        ? "FAIL"
        : anyCancelled
        ? "CANCELLED"
        : anyWarn
        ? "WARN"
        : "VERIFIED",
    });
  }
  if (networkReport) {
    const netPct =
      networkReport.verdict === "HEALTHY"
        ? 95
        : networkReport.verdict === "LOCAL_ONLY_NO_DNS" || networkReport.verdict === "DEGRADED"
        ? 65
        : networkReport.verdict === "POOR_LINK"
        ? 45
        : 20;
    subsystemScores.push({
      label: "Network & Wi-Fi Link",
      scorePct: netPct,
      metricText: `${networkReport.interfaceName}${
        networkReport.linkSpeedMbps != null ? ` • ${networkReport.linkSpeedMbps} Mbps` : ""
      }${networkReport.gatewayPingMs != null ? ` • ${networkReport.gatewayPingMs.toFixed(1)}ms` : ""}`,
      statusLabel: networkReport.verdict,
    });
  }
  if (userbenchmarkComparison) {
    subsystemScores.push({
      label: "UserBenchmark Class Index",
      scorePct: Math.max(
        5,
        Math.min(
          100,
          Math.max(
            userbenchmarkComparison.desktopPct,
            userbenchmarkComparison.gamingPct,
            userbenchmarkComparison.workstationPct
          )
        )
      ),
      metricText: `${userbenchmarkComparison.overallVehicleTier} • Desk ${userbenchmarkComparison.desktopPct.toFixed(
        0
      )}% / Game ${userbenchmarkComparison.gamingPct.toFixed(0)}% / WS ${userbenchmarkComparison.workstationPct.toFixed(0)}%`,
      statusLabel: userbenchmarkComparison.overallVehicleTier.toUpperCase(),
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
    if (id === "specs") {
      if (specs) {
        out.push(["CPU", `${specs.cpuPhysicalCores}C/${specs.cpuLogicalCores}T`]);
        out.push(["RAM", `${specs.totalRamGb.toFixed(0)} GB${specs.ramChannelMode ? ` (${specs.ramChannelMode})` : ""}`]);
        if (specs.wifiSignalPct != null) out.push(["Wi-Fi RSSI", `${specs.wifiSignalPct}% (${specs.wifiRssiDbm ?? "—"} dBm)`]);
      }
      if (networkReport) {
        out.push(["Net Verdict", networkReport.verdict]);
        if (networkReport.linkSpeedMbps != null) out.push(["Link Speed", `${networkReport.linkSpeedMbps} Mbps`]);
        if (networkReport.gatewayPingMs != null) out.push(["Ping", `${networkReport.gatewayPingMs.toFixed(1)} ms (${networkReport.packetLossPct.toFixed(0)}% loss)`]);
        out.push(["DNS", networkReport.dnsResolveOk ? "OK" : "FAIL"]);
      }
    } else if (id === "security" && securityReport) {
      out.push(["MDM", securityReport.mdmEnrolled === true ? "ENROLLED" : "Clean"]);
      if (securityReport.activationLocked != null) {
        out.push(["Activation Lock", securityReport.activationLocked ? "LOCKED" : "Clean"]);
      }
    } else if (id === "battery") {
      if (batteryReport?.present) {
        if (batteryReport.healthPercent != null) out.push(["Health", `${batteryReport.healthPercent.toFixed(1)}%`]);
        if (batteryReport.cycleCount != null) out.push(["Cycles", `${batteryReport.cycleCount}`]);
      }
      if (batterySagResult) {
        out.push(["15s Sag", `${batterySagResult.maxVoltageSagMv} mV (-${batterySagResult.chargeDropPct.toFixed(1)}%)`]);
      }
      if (batteryDischargeResult) {
        out.push(["Discharge", batteryDischargeResult.verdict]);
        out.push(["Power Avg", `Idle ${batteryDischargeResult.idleAvgWatts.toFixed(1)}W / Load ${batteryDischargeResult.loadAvgWatts.toFixed(1)}W`]);
        out.push(["Power CV", `${batteryDischargeResult.powerCvPct.toFixed(1)}%`]);
        out.push(["Max 5s Drop", `${batteryDischargeResult.maxStepDropPct.toFixed(1)}%`]);
      }
    } else if (id === "logs" && errorLogsReport) {
      out.push(["BSOD/Panics", `${errorLogsReport.bsodOrPanicCount}`]);
      out.push(["WHEA HW", `${errorLogsReport.wheaOrHwCount}`]);
      out.push(["Disk Err", `${errorLogsReport.diskErrorCount}`]);
      out.push(["GPU TDR", `${errorLogsReport.gpuResetCount}`]);
    } else if (id === "storage") {
      const d = smartReport?.drives[0];
      const wearVal = d?.percentageUsedRaw ?? d?.wearPercent;
      if (d?.healthPercent != null) out.push(["SMART Health", `${d.healthPercent}%`]);
      if (wearVal != null) out.push(["Wear (Log 0x02)", `${wearVal}%`]);
      if (d?.availableSparePct != null) out.push(["Spare", `${d.availableSparePct}%`]);
      if (d?.mediaErrors != null) out.push(["Media Err", `${d.mediaErrors}`]);
      if (d?.unsafeShutdowns != null) out.push(["Unsafe Off", `${d.unsafeShutdowns}`]);
      if (d?.tbwGb != null) out.push(["TBW", `${(d.tbwGb / 1000).toFixed(1)} TB`]);
      if (storageBench) {
        out.push(["Seq Read", `${storageBench.seqReadMbS.toFixed(0)} MB/s`]);
        out.push(["Seq Write", `${storageBench.seqWriteMbS.toFixed(0)} MB/s`]);
        if (storageBench.rand4kQd32ReadMbS != null) {
          out.push(["4K QD32", `R ${storageBench.rand4kQd32ReadMbS.toFixed(0)} / W ${(storageBench.rand4kQd32WriteMbS ?? 0).toFixed(0)} MB/s`]);
        }
        if (storageBench.mixedRwMbS != null) {
          out.push(["70/30 Mix", `${storageBench.mixedRwMbS.toFixed(0)} MB/s`]);
        }
        if (storageBench.slcSustainedMbS != null) {
          out.push(["SLC Sust", `${storageBench.slcSustainedMbS.toFixed(0)} MB/s`]);
        }
        if (storageBench.totalWrittenMb != null) {
          out.push(["Budget", `${storageBench.totalWrittenMb.toFixed(0)} MB`]);
        }
        out.push(["4K P99", `${storageBench.p994kLatencyMs.toFixed(2)} ms`]);
        out.push(["Verify Err", `${storageBench.integrityErrors}`]);
        if (effectiveSsdUb) {
          out.push(["UB SSD", `${effectiveSsdUb.vehicleTier} (${effectiveSsdUb.standingLabel})`]);
        }
      } else {
        out.push(["Write Budget", "128/256/512 MB Safe Guard (4x free space)"]);
      }
    } else if (id === "touchscreen" && touchscreenResult) {
      out.push(["Touchscreen", touchscreenResult.touchCapable ? "Capable" : "Non-Touch"]);
      out.push(["Grid Coverage", `${touchscreenResult.coveredCells}/${touchscreenResult.totalCells} (${touchscreenResult.coveragePct.toFixed(0)}%)`]);
      out.push(["Multi-Touch", `${touchscreenResult.maxSimultaneousTouches} pts`]);
      out.push(["Polling / RMS", `${touchscreenResult.pollingHz}Hz / ${touchscreenResult.swipeLinearityRmsPx.toFixed(1)}px`]);
    } else if (id === "ram" && ramResult) {
      out.push(["Verified", `${ramResult.totalGbVerified.toFixed(1)} GB`]);
      out.push(["Peak BW", `${ramResult.peakBandwidthGbS.toFixed(1)} GB/s`]);
      out.push(["Bit Errors", `${ramResult.errorsFound}`]);
      if (ramResult.osReserveMb != null) out.push(["OS Reserve", `${ramResult.osReserveMb} MB`]);
      if (effectiveRamUb) {
        out.push(["UB RAM", `${effectiveRamUb.vehicleTier} (${effectiveRamUb.standingLabel})`]);
      }
    } else if (id === "performance" && perfResult) {
      out.push(["Composite", `${perfResult.compositeScore}`]);
      out.push(["Office", `${perfResult.officeScore}`]);
      out.push(["Creator", `${perfResult.creatorScore} (${perfResult.creatorMegaRaysS.toFixed(1)} MRays/s)`]);
      out.push(["Memory", `${perfResult.memoryMark} (${perfResult.memoryLatencyNs.toFixed(1)} ns)`]);
      if (perfResult.memoryUncachedReadGbS != null) {
        out.push(["Uncached/Thread", `${perfResult.memoryUncachedReadGbS.toFixed(1)} / ${(perfResult.memoryThreadedGbS ?? perfResult.memoryBandwidthGbS).toFixed(1)} GB/s`]);
      }
      out.push(["Throttle", `-${perfResult.throttleDropPct.toFixed(1)}%`]);
      if (perfResult.thermalCutoffTriggered) out.push(["Thermal Cutoff", "TRIGGERED"]);
      if (effectiveCpuUb) {
        out.push(["UB CPU", `${effectiveCpuUb.vehicleTier} (${effectiveCpuUb.standingLabel})`]);
      }
    } else if (id === "gpu") {
      if (gpuResult) {
        out.push(["FurMark", `${gpuResult.avgFps.toFixed(1)} FPS (1% Low ${gpuResult.low1pctFps.toFixed(1)})`]);
        out.push(["GPU Drop", `-${gpuResult.fpsDropPct.toFixed(1)}%`]);
        if (gpuResult.artifactErrors != null) out.push(["Artifacts", `${gpuResult.artifactErrors}`]);
        if (gpuResult.throttleReason) out.push(["Throttle", gpuResult.throttleReason]);
        if (effectiveGpuUb) {
          out.push(["UB GPU", `${effectiveGpuUb.vehicleTier} (${effectiveGpuUb.standingLabel})`]);
        }
      }
      if (vramResult) {
        out.push(["VRAM", `${vramResult.errorsFound} err (${vramResult.totalGbVerified.toFixed(1)} GB)`]);
        if (vramResult.thermalCutoffTriggered) out.push(["VRAM Cutoff", "TRIGGERED"]);
      }
      if (tortureResult) {
        out.push(["AC Drain", tortureResult.batteryDrainWhilePlugged ? "ALERT" : "Stable"]);
        if (tortureResult.artifactErrors != null) out.push(["Torture Art", `${tortureResult.artifactErrors}`]);
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
        tests: list.map((m) => {
          let summary = m.summary || "Not run";
          if (m.id === "storage" && m.status === "skipped" && smartReport?.summary) {
            summary = `${smartReport.summary} — Stage skipped (low-space/write-budget guard or manual skip)`;
          }
          return {
            id: m.id,
            name: `${String(m.stepNumber).padStart(2, "0")}. ${m.name}`,
            category: m.category,
            status: m.status,
            summary,
            metrics: buildStageMetrics(m.id),
            notes: m.notes,
          };
        }),
        signoff,
        outputDir: profile.defaultOutputDir,
        plainVerdictSummary,
        userBenchmark: userbenchmarkComparison ?? null,
        batteryDischarge: batteryDischargeResult ?? null,
        touchscreen: touchscreenResult ?? null,
        networkReport: networkReport ?? null,
        cpuStress: cpuStressResult ?? null,
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
                  <div className="text-[8px] uppercase text-zinc-500">Skip / N/A</div>
                  <div className="text-sm font-black text-zinc-500">{String(skippedOrNaCount).padStart(2, "0")}</div>
                </div>
              </div>

              {/* Plain-Language Verdict & UserBenchmark Executive Summary */}
              <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-2">
                <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-blue-700">
                  Plain-Language Verdict &amp; Long-Term Reliability Summary
                </div>
                <div className="text-[11px] text-black leading-relaxed">{plainVerdictSummary}</div>

                {userbenchmarkComparison && (
                  <div className="rounded-[2px] border border-zinc-300 bg-white p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="font-mono text-[9.5px] font-bold uppercase text-black flex items-center gap-1.5">
                        <Award className="w-3.5 h-3.5 text-blue-600" />
                        UserBenchmark Standing:
                        <span className="px-1.5 py-0.5 rounded-[2px] bg-blue-600 text-white font-black">
                          {userbenchmarkComparison.overallVehicleTier}
                        </span>
                      </div>
                      <div className="font-mono text-[9.5px] text-zinc-600 tabular-nums">
                        Gaming <strong className="text-black">{userbenchmarkComparison.gamingPct.toFixed(0)}%</strong> •{" "}
                        Desktop <strong className="text-black">{userbenchmarkComparison.desktopPct.toFixed(0)}%</strong> •{" "}
                        Workstation <strong className="text-black">{userbenchmarkComparison.workstationPct.toFixed(0)}%</strong>
                      </div>
                    </div>
                    <div className="text-[10.5px] text-zinc-700">{userbenchmarkComparison.headlineSummary}</div>
                    <div className="flex flex-wrap gap-1">
                      {[
                        userbenchmarkComparison.cpu,
                        userbenchmarkComparison.gpu,
                        userbenchmarkComparison.ssd,
                        userbenchmarkComparison.ram,
                      ]
                        .filter(Boolean)
                        .map((comp) => (
                          <span
                            key={comp!.component}
                            className="px-1.5 py-0.5 rounded-[2px] border border-zinc-200 bg-[#F8FAFC] font-mono text-[9px] text-black"
                          >
                            <strong>{comp!.component.toUpperCase()}</strong>: {comp!.vehicleTier} ({comp!.standingLabel})
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {(batteryDischargeResult || touchscreenResult || networkReport) && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {batteryDischargeResult && (
                      <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[9.5px] text-black">
                        Battery Discharge:{" "}
                        <strong
                          className={
                            batteryDischargeResult.verdict === "ABNORMAL"
                              ? "text-zinc-950"
                              : "text-blue-700"
                          }
                        >
                          {batteryDischargeResult.verdict}
                        </strong>
                      </span>
                    )}
                    {touchscreenResult && (
                      <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[9.5px] text-black">
                        Touchscreen:{" "}
                        <strong className="text-blue-700">
                          {touchscreenResult.touchCapable
                            ? `${touchscreenResult.coveragePct.toFixed(0)}% (${touchscreenResult.verdict})`
                            : touchscreenResult.verdict}
                        </strong>
                      </span>
                    )}
                    {networkReport && (
                      <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[9.5px] text-black">
                        Network: <strong className="text-blue-700">{networkReport.verdict}</strong>
                      </span>
                    )}
                  </div>
                )}
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
                    Complete hardware stress modules to populate calibration bars (full {stepOrder.length}-stage audit ledger exports on Page 2).
                  </div>
                ) : (
                  <div className="border border-zinc-300 divide-y divide-zinc-200">
                    {subsystemScores.map((b) => {
                      const upper = b.statusLabel.toUpperCase();
                      const isFail =
                        upper.includes("FAIL") ||
                        upper === "ABNORMAL" ||
                        upper === "POOR_LINK";
                      const isNeutralWarn =
                        !isFail &&
                        (upper.includes("CANCELLED") ||
                          upper.includes("INCOMPLETE") ||
                          upper.includes("WARN") ||
                          upper === "LOW" ||
                          upper === "SKIPPED" ||
                          upper === "NO_ACTIVE_LINK" ||
                          upper === "DEGRADED" ||
                          upper === "LOCAL_ONLY_NO_DNS" ||
                          upper === "ABORTED_LOW_BATTERY" ||
                          upper === "AC_CONNECTED" ||
                          upper === "INSUFFICIENT_SAMPLES");
                      return (
                        <div key={b.label} data-subsystem-row={b.label} className="px-2.5 py-1.5 space-y-1">
                          <div className="flex items-center justify-between text-[10px]">
                            <strong className="text-black">{b.label}</strong>
                            <span className="font-mono text-zinc-600 truncate mx-2">{b.metricText}</span>
                            <span
                              className={`font-mono font-bold ${
                                isFail ? "text-black" : isNeutralWarn ? "text-zinc-700" : "text-blue-700"
                              }`}
                            >
                              {b.statusLabel}
                            </span>
                          </div>
                          <div className="h-1.5 bg-zinc-200">
                            <div
                              data-subsystem-bar={b.label}
                              className={
                                isFail
                                  ? "h-full bg-black"
                                  : isNeutralWarn
                                  ? "h-full bg-zinc-700"
                                  : "h-full bg-blue-600"
                              }
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
              Created by <strong className="text-black">Hein Htet Zaw</strong> • Telegram:{" "}
            </span>
            <span className="text-blue-700 font-mono inline-flex items-center gap-0.5 font-semibold">
              <Send className="w-2.5 h-2.5" />@ich8g92
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
