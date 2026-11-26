import React, { useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";

export interface ThresholdAuditRow {
  parameter: string;
  measured: string;
  limit: string;
  verdict: "PASS" | "WARN" | "FAIL";
  meaning?: string;
}

export const ThresholdAuditTable: React.FC<{
  title?: string;
  plainSummary?: string;
  rows: ThresholdAuditRow[];
}> = ({
  title = "Pass / Fail Engineering Threshold Verification",
  plainSummary,
  rows,
}) => {
  if (rows.length === 0) return null;

  const passCount = rows.filter((r) => r.verdict === "PASS").length;
  const warnCount = rows.filter((r) => r.verdict === "WARN").length;
  const failCount = rows.filter((r) => r.verdict === "FAIL").length;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      <div className="px-3.5 py-2 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-700">
            {title}
          </div>
          {plainSummary && (
            <div className="text-[11px] text-zinc-600 mt-0.5">{plainSummary}</div>
          )}
        </div>
        <div
          className="flex items-center gap-1.5 font-mono text-[10px] font-bold tabular-nums"
          title="PASS = within healthy factory limits • WARN = borderline / inspect • FAIL = threshold exceeded or defect detected"
        >
          <span className="px-1.5 py-0.5 rounded-[2px] bg-blue-600 text-white">
            {passCount} PASS
          </span>
          <span className="px-1.5 py-0.5 rounded-[2px] border border-blue-600 bg-white text-blue-700">
            {warnCount} WARN
          </span>
          <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white">
            {failCount} FAIL
          </span>
        </div>
      </div>
      <table className="w-full text-left border-collapse font-mono text-xs tabular-nums">
        <thead>
          <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-500 bg-white">
            <th className="py-2 px-3.5 font-bold">Parameter</th>
            <th className="py-2 px-3.5 font-bold">Measured Result</th>
            <th className="py-2 px-3.5 font-bold">Required Lab Limit</th>
            <th className="py-2 px-3.5 font-bold text-right">Audit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200">
          {rows.map((r) => (
            <tr key={r.parameter} className="hover:bg-zinc-50">
              <td className="py-2 px-3.5 font-sans">
                <div className="font-semibold text-black">{r.parameter}</div>
                {r.meaning && (
                  <div className="text-[11px] font-normal text-zinc-600 mt-0.5 leading-snug">
                    {r.meaning}
                  </div>
                )}
              </td>
              <td className="py-2 px-3.5 font-bold text-black">{r.measured}</td>
              <td className="py-2 px-3.5 text-zinc-600">{r.limit}</td>
              <td className="py-2 px-3.5 text-right">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded-[2px] text-[9.5px] font-bold border ${
                    r.verdict === "PASS"
                      ? "bg-blue-600 text-white border-blue-600"
                      : r.verdict === "WARN"
                      ? "bg-white text-blue-700 border-blue-600"
                      : "bg-black text-white border-black"
                  }`}
                >
                  {r.verdict}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const EngineeringConsole: React.FC<{
  lines: string[];
  defaultOpen?: boolean;
  title?: string;
}> = ({ lines, defaultOpen = false, title = "Diagnostic Execution Log" }) => {
  const [open, setOpen] = useState(defaultOpen);
  if (lines.length === 0) return null;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3.5 py-2 bg-[#F8FAFC] hover:bg-zinc-100 flex items-center justify-between text-[10.5px] font-mono font-bold uppercase tracking-wider text-black cursor-pointer"
      >
        <span className="flex items-center gap-2 text-left">
          <Terminal className="w-3.5 h-3.5 text-blue-600 shrink-0" />
          <span>
            {title} ({lines.length} events)
            <span className="block font-sans text-[10px] font-normal normal-case tracking-normal text-zinc-500">
              Technical step-by-step hardware trace for audit verification
            </span>
          </span>
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
      </button>
      {open && (
        <div className="p-3 bg-black text-zinc-200 font-mono text-[11px] leading-relaxed max-h-48 overflow-y-auto space-y-0.5 tabular-nums">
          {lines.map((ln, idx) => (
            <div key={idx} className="whitespace-pre-wrap break-words">
              <span className="text-blue-400 mr-2">&gt;</span>
              {ln}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
