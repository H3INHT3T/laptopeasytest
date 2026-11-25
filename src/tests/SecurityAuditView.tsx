import React from "react";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { SecurityAuditReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface SecurityAuditViewProps {
  report: SecurityAuditReport | null;
  loading: boolean;
  status: TestStatus;
  onRefresh: () => void;
  onNext?: () => void;
}

export const SecurityAuditView: React.FC<SecurityAuditViewProps> = ({
  report,
  loading,
  status,
  onRefresh,
  onNext,
}) => {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Lock, MDM &amp; License Audit</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Verifies zero corporate MDM/DEP enrollment, Activation Lock / Find My status, OS license, encryption, and TPM/Secure Boot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Re-run Audit
          </button>
          {onNext && (
            <button
              onClick={onNext}
              className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
            >
              Next Test →
            </button>
          )}
        </div>
      </div>

      {!report ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400">
          {loading ? "Auditing MDM, Activation Lock, Encryption & Licensing..." : "Click Re-run Audit to inspect ownership & security locks."}
        </div>
      ) : (
        <>
          <div
            className={`rounded-xl border p-4 flex items-center gap-3 ${
              report.overallStatus === "fail"
                ? "bg-rose-500/10 border-rose-500/40 text-rose-200"
                : report.overallStatus === "warn"
                ? "bg-amber-500/10 border-amber-500/40 text-amber-200"
                : "bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
            }`}
          >
            {report.overallStatus === "fail" ? (
              <ShieldAlert className="w-6 h-6 shrink-0 text-rose-400" />
            ) : (
              <ShieldCheck className="w-6 h-6 shrink-0 text-emerald-400" />
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
                className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 flex flex-col justify-between gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-400">{item.label}</div>
                    <div className="text-base font-bold text-white mt-0.5">{item.value}</div>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <div className="text-xs text-slate-400 font-mono break-words pt-1 border-t border-slate-800/80">
                  {item.detail}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
