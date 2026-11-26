import React from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { SecurityAuditReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

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
        report.activationLocked === true)
  );
  const passCount = report ? report.items.filter((i) => i.status === "pass").length : 0;
  const warnCount = report ? report.items.filter((i) => i.status === "warn").length : 0;
  const failCount = report ? report.items.filter((i) => i.status === "fail").length : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-xs font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Lock, MDM &amp; License Audit
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Verifies zero MDM/DEP enrollment, Apple Activation Lock / Find My, OEM Windows License, BitLocker/FileVault, TPM 2.0 &amp; Secure Boot.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3.5 py-2 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Re-run Audit
        </button>
      </div>

      {!report ? (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-10 text-center text-sm text-zinc-600">
          {loading ? "Auditing MDM, Activation Lock, Encryption & Licensing..." : "Click Re-run Audit to check ownership locks."}
        </div>
      ) : (
        <>
          <div
            className={`rounded-[2px] border p-4 flex items-center justify-between flex-wrap gap-3 ${
              report.overallStatus === "fail"
                ? "bg-black border-black text-white"
                : "bg-blue-50/40 border-blue-600 text-black"
            }`}
          >
            <div className="flex items-center gap-3">
              {report.overallStatus === "fail" ? (
                <ShieldAlert className="w-6 h-6 shrink-0 text-white" />
              ) : (
                <ShieldCheck className="w-6 h-6 shrink-0 text-blue-600" />
              )}
              <div>
                <div className="text-sm font-bold">{report.platform} Ownership &amp; Security Verdict</div>
                <div className="text-xs opacity-90 mt-0.5">{report.summary}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] font-bold">
              <span
                className={`px-2 py-0.5 rounded-[2px] border ${
                  report.mdmEnrolled === true
                    ? "bg-white text-black border-white"
                    : report.overallStatus === "fail"
                    ? "bg-zinc-900 text-zinc-200 border-zinc-700"
                    : "bg-white text-black border-zinc-300"
                }`}
              >
                MDM:{" "}
                {report.mdmEnrolled === true
                  ? "ENROLLED"
                  : report.mdmEnrolled === false
                  ? "Clean"
                  : "Unknown"}
              </span>
              <span
                className={`px-2 py-0.5 rounded-[2px] border ${
                  report.activationLocked === true
                    ? "bg-white text-black border-white"
                    : report.overallStatus === "fail"
                    ? "bg-zinc-900 text-zinc-200 border-zinc-700"
                    : "bg-white text-black border-zinc-300"
                }`}
              >
                Activation Lock:{" "}
                {report.activationLocked === true
                  ? "LOCKED"
                  : report.activationLocked === false
                  ? "Clean"
                  : "N/A"}
              </span>
              <span
                className={`px-2 py-0.5 rounded-[2px] border ${
                  report.overallStatus === "fail"
                    ? "bg-zinc-900 text-zinc-200 border-zinc-700"
                    : "bg-white text-black border-zinc-300"
                }`}
              >
                Checks: {passCount}P / {warnCount}W / {failCount}F
              </span>
            </div>
          </div>

          {hasOwnershipRisk && (
            <div className="rounded-[2px] border-2 border-black bg-black text-white p-4 space-y-2">
              <div className="font-mono text-xs font-bold uppercase flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                OWNERSHIP LOCK RISK ALERT — DO NOT COMPLETE PURCHASE UNTIL RESOLVED
              </div>
              {(report.ownershipRisks?.length ?? 0) > 0 ? (
                <ul className="space-y-1 text-xs font-mono list-disc list-inside">
                  {report.ownershipRisks!.map((risk, idx) => (
                    <li key={idx}>{risk}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs font-mono">
                  {report.mdmEnrolled ? "Active corporate MDM/DEP enrollment detected. " : ""}
                  {report.activationLocked ? "Active Activation Lock / Find My binding detected." : ""}
                </div>
              )}
            </div>
          )}

          {/* What This Means for Second-Hand Buyers */}
          <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-1.5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
              What This Means for Second-Hand Buyers
            </div>
            <div className="text-xs text-black font-medium">
              {report.plainSummary || report.summary}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {report.items.map((item) => {
              const accentCls =
                item.status === "fail" || item.status === "warn"
                  ? "border-l-black"
                  : item.status === "pass"
                  ? "border-l-blue-600"
                  : "border-l-zinc-300";
              return (
                <div
                  key={item.id}
                  className={`rounded-[2px] border border-zinc-300 border-l-[3px] ${accentCls} bg-white p-4 flex flex-col justify-between gap-2`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-zinc-500">{item.label}</div>
                      <div className="text-base font-bold text-black mt-0.5">{item.value}</div>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                  {item.buyerNote && (
                    <div className="text-xs text-black bg-[#F8FAFC] border border-zinc-200 rounded-[2px] px-2.5 py-1.5">
                      {item.buyerNote}
                    </div>
                  )}
                  <div className="text-xs text-zinc-600 font-mono break-words pt-2 border-t border-zinc-100">
                    {item.detail}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(report)}
        requirementHint="Complete security & MDM audit before continuing."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
