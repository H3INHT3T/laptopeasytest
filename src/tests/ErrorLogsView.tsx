import React, { useState } from "react";
import { AlertOctagon, FileWarning, RefreshCw, Search } from "lucide-react";
import type { ErrorLogsReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface ErrorLogsViewProps {
  report: ErrorLogsReport | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onScan: (days: number) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const ErrorLogsView: React.FC<ErrorLogsViewProps> = ({
  report,
  loading,
  status,
  stepNumber,
  totalSteps,
  onScan,
  onNext,
  onSkip,
}) => {
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState("");
  const [onlyHardware, setOnlyHardware] = useState(false);

  const filteredEntries = (report?.entries ?? []).filter((e) => {
    if (onlyHardware && e.category === "System / App") return false;
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      e.source.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.message.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              System Error &amp; Crash Logs
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Inspects Windows Event Viewer &amp; Minidumps (BSOD, Kernel-Power 41, WHEA, Disk, GPU TDR) or macOS Kernel Panics &amp; Unified Logs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => {
              const d = Number(e.target.value);
              setDays(d);
              onScan(d);
            }}
            className="bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
          </select>
          <button
            onClick={() => onScan(days)}
            disabled={loading}
            className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
            Re-scan Logs
          </button>
        </div>
      </div>

      {!report ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-10 text-center text-sm text-zinc-600">
          {loading ? "Scanning OS critical & hardware error logs..." : "Click Re-scan Logs to inspect crash history."}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "BSOD / Kernel Panics", val: report.bsodOrPanicCount },
              { label: "WHEA / Hardware Faults", val: report.wheaOrHwCount },
              { label: "Disk / Storage Errors", val: report.diskErrorCount },
              { label: "GPU Driver Resets", val: report.gpuResetCount },
              { label: "Crash Dump Files", val: report.minidumpFiles.length },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-zinc-200 bg-white p-3.5">
                <div className="text-[11px] text-zinc-500">{k.label}</div>
                <div className={`text-2xl font-black font-mono mt-1 ${k.val > 0 ? "text-black" : "text-blue-600"}`}>
                  {k.val}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-xs text-black font-medium">
              {report.status === "fail" ? (
                <AlertOctagon className="w-4 h-4 text-black shrink-0" />
              ) : (
                <FileWarning className="w-4 h-4 text-blue-600 shrink-0" />
              )}
              <span>{report.summary}</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-black cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={onlyHardware}
                  onChange={(e) => setOnlyHardware(e.target.checked)}
                  className="accent-blue-600"
                />
                Hardware / Crash Only
              </label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter source or message..."
                  className="bg-white border border-zinc-300 rounded-lg pl-8 pr-3 py-1.5 text-xs text-black focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-500 uppercase text-[10px] sticky top-0">
                  <tr>
                    <th className="px-3 py-2.5">Timestamp</th>
                    <th className="px-3 py-2.5">Level</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Source</th>
                    <th className="px-3 py-2.5">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {filteredEntries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                        No matching error events found.
                      </td>
                    </tr>
                  ) : (
                    filteredEntries.map((ev, idx) => (
                      <tr key={idx} className="hover:bg-blue-50/40">
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-500">{ev.timestamp}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              ev.level === "Critical"
                                ? "bg-black text-white"
                                : "bg-blue-50 text-blue-800 border border-blue-200"
                            }`}
                          >
                            {ev.level}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-blue-700 font-semibold">{ev.category}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-black font-medium">{ev.source}</td>
                        <td className="px-3 py-2 text-zinc-700 break-words max-w-md">{ev.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(report)}
        requirementHint="Scan OS error logs before proceeding."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
