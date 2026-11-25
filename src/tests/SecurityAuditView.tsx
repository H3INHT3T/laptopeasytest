import React from "react";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
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
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
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
          className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Re-run Audit
        </button>
      </div>

      {!report ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-10 text-center text-sm text-zinc-600">
          {loading ? "Auditing MDM, Activation Lock, Encryption & Licensing..." : "Click Re-run Audit to check ownership locks."}
        </div>
      ) : (
        <>
          <div
            className={`rounded-xl border p-4 flex items-center gap-3 ${
              report.overallStatus === "fail"
                ? "bg-black border-black text-white"
                : "bg-blue-50 border-blue-600 text-black"
            }`}
          >
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {report.items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 flex flex-col justify-between gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-zinc-500">{item.label}</div>
                    <div className="text-base font-bold text-black mt-0.5">{item.value}</div>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <div className="text-xs text-zinc-600 font-mono break-words pt-2 border-t border-zinc-100">
                  {item.detail}
                </div>
              </div>
            ))}
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
