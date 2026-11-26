import React from "react";
import { AlertTriangle, Lock, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { SecurityAuditReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface SecurityAuditViewProps {
  report: SecurityAuditReport | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefresh: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export const SecurityAuditView: React.FC<SecurityAuditViewProps> = ({
  report,
  loading,
  status,
  stepNumber,
  totalSteps,
  onRefresh,
  onNext,
  onSkip,
}) => {
  const hasOwnershipRisk = Boolean(
    report &&
      ((report.ownershipRisks?.length ?? 0) > 0 ||
        report.mdmEnrolled === true ||
        report.activationLocked === true ||
        report.biosLocked === true)
  );
  const passCount = report ? report.items.filter((i) => i.status === "pass").length : 0;
  const totalChecks = report ? report.items.length : 0;
  const scorePct = totalChecks > 0 ? Math.round((passCount / totalChecks) * 100) : 0;

  const findItem = (id: string) => report?.items.find((i) => i.id === id);
  const computraceItem = findItem("computrace");
  const autopilotItem = findItem("autopilot");

  const biosLabel =
    report?.biosLocked === true || report?.biosLockStatus === "LOCKED"
      ? "Locked"
      : report?.biosLocked === false || report?.biosLockStatus === "UNLOCKED"
      ? "Unlocked"
      : "Verify at boot";

  return (
    <div className="space-y-6">
      {/* BLOCK 1: Minimal Header + 1 Primary Button */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Lock, MDM &amp; License Audit
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • MDM, Autopilot, Computrace, BIOS lock &amp; encryption
          </div>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 transition cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Re-run audit
        </button>
      </div>

      {/* BLOCK 2: 1 Clean Result Card */}
      {!report ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500">
          {loading ? "Auditing MDM, Autopilot, Computrace & BIOS locks..." : "Click Re-run audit to check locks."}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-5">
          {hasOwnershipRisk && (
            <div className="rounded-xl border border-black bg-black text-white p-4 space-y-1.5">
              <div className="text-xs font-bold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                Ownership lock risk detected — resolve before purchase
              </div>
              <div className="text-xs text-zinc-200">
                {(report.ownershipRisks?.length ?? 0) > 0
                  ? report.ownershipRisks!.join(" • ")
                  : "Active MDM, Autopilot, Computrace, BIOS password, or Activation Lock detected."}
              </div>
            </div>
          )}

          {/* 4 Key Security Tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                MDM &amp; Autopilot
              </div>
              <div className="text-base font-bold text-black">
                {report.mdmEnrolled === true || autopilotItem?.status === "fail" ? "Locked" : "Clean"}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {autopilotItem ? autopilotItem.value : report.mdmEnrolled === false ? "Not enrolled" : "Checked"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <ShieldAlert className="w-3.5 h-3.5 text-blue-600" />
                Computrace
              </div>
              <div className="text-base font-bold text-black">
                {computraceItem?.status === "fail" ? "Active" : "Clean"}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {computraceItem ? computraceItem.value : "No persistence"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <Lock className="w-3.5 h-3.5 text-blue-600" />
                BIOS firmware
              </div>
              <div className="text-base font-bold text-black">{biosLabel}</div>
              <div className="text-xs text-zinc-500 truncate">{report.platform}</div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                Checks passed
              </div>
              <div className="text-xl font-bold text-black tabular-nums leading-tight">
                {passCount} / {totalChecks}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {report.overallStatus === "fail" ? "Action required" : report.overallStatus === "warn" ? "Review details" : "Safe to buy"}
              </div>
            </div>
          </div>

          {report.kmsPiracySuspected && (
            <div className="rounded-xl border border-black bg-[#F8FAFC] p-4 space-y-1">
              <div className="text-xs font-bold text-black flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-600 shrink-0" />
                Windows KMS / Volume Crack Suspected ({report.licenseChannel || "Volume:GVLK"}
                {report.licenseGraceDays != null ? ` • expires in ~${report.licenseGraceDays}d` : ""})
              </div>
              <div className="text-xs text-zinc-700">
                {report.oemBiosKeyPresent
                  ? `Genuine factory OEM BIOS key IS embedded on this motherboard (${report.oemBiosKeyHint || "UEFI MSDM"}) — reinstall the matching Windows edition to restore permanent OEM activation.`
                  : "No factory OEM BIOS (OA3) product key found on motherboard — buyer may need a genuine Windows license after 180 days."}
              </div>
            </div>
          )}

          {!report.kmsPiracySuspected && report.oemBiosKeyPresent && (
            <div className="rounded-xl border border-blue-200 bg-[#F8FAFC] px-4 py-2.5 text-xs text-black flex items-center justify-between gap-2 flex-wrap">
              <span>
                <strong>Genuine Windows OEM BIOS Key Verified:</strong>{" "}
                {report.oemBiosKeyHint || "Embedded in UEFI MSDM"} ({report.licenseChannel || "OEM:DM"})
              </span>
              <span className="font-mono text-[11px] font-bold text-blue-700">OA3 VERIFIED</span>
            </div>
          )}

          {/* Clean Verdict Bar */}
          <div className="space-y-2 pt-2 border-t border-zinc-100">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-black">{report.plainSummary || report.summary}</span>
              <span className="font-mono font-bold text-zinc-600 shrink-0">{scorePct}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  report.overallStatus === "fail" ? "bg-black" : "bg-blue-600"
                }`}
                style={{ width: `${Math.max(8, scorePct)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* BLOCK 3: 1 Collapsed "Details" Toggle */}
      {report && (
        <TechnicalDetailsDrawer
          title="Details"
          subtitle={`${report.items.length} security, firmware, license & encryption checks`}
          defaultOpen={report.overallStatus === "fail"}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {report.items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-zinc-500">{item.label}</div>
                    <div className="text-sm font-bold text-black mt-0.5">{item.value}</div>
                  </div>
                  <StatusBadge status={item.status} compact />
                </div>
                {item.buyerNote && (
                  <div className="text-xs text-zinc-700 bg-[#F8FAFC] border border-zinc-200 rounded-lg px-2.5 py-1.5">
                    {item.buyerNote}
                  </div>
                )}
                <div className="text-[11px] text-zinc-500 font-mono break-words pt-1 border-t border-zinc-100">
                  {item.detail}
                </div>
              </div>
            ))}
          </div>
        </TechnicalDetailsDrawer>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(report)}
        requirementHint="Wait for security audit to finish."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
