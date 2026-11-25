import React, { useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";

export interface ThresholdAuditRow {
  parameter: string;
  measured: string;
  limit: string;
  verdict: "PASS" | "WARN" | "FAIL";
}

export const ThresholdAuditTable: React.FC<{
  title?: string;
  rows: ThresholdAuditRow[];
}> = ({ title = "Pass / Fail Engineering Threshold Verification", rows }) => {
  if (rows.length === 0) return null;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      <div className="px-3.5 py-2 border-b border-zinc-200 bg-[#F8FAFC] font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-600">
        {title}
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
              <td className="py-2 px-3.5 font-sans font-semibold text-black">{r.parameter}</td>
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
}> = ({ lines, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  if (lines.length === 0) return null;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3.5 py-2 bg-[#F8FAFC] hover:bg-zinc-100 flex items-center justify-between text-[10.5px] font-mono font-bold uppercase tracking-wider text-black cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-blue-600" />
          Diagnostic Execution Log ({lines.length} events)
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
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
