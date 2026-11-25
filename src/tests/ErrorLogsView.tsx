import React, { useState } from "react";
import { AlertOctagon, FileWarning, RefreshCw, Search } from "lucide-react";
import type { ErrorLogsReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface ErrorLogsViewProps {
  report: ErrorLogsReport | null;
  loading: boolean;
  status: TestStatus;
  onScan: (days: number) => void;
  onNext?: () => void;
}

export const ErrorLogsView: React.FC<ErrorLogsViewProps> = ({
  report,
  loading,
  status,
  onScan,
  onNext,
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">System Error &amp; Crash Logs</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
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
            className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
          </select>
          <button
            onClick={() => onScan(days)}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Re-scan Logs
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
          {loading ? "Scanning OS critical & hardware error logs..." : "Click Re-scan Logs to inspect crash history."}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-[11px] text-slate-400">BSOD / Kernel Panics</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${report.bsodOrPanicCount > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {report.bsodOrPanicCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-[11px] text-slate-400">WHEA / Hardware Faults</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${report.wheaOrHwCount > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {report.wheaOrHwCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-[11px] text-slate-400">Disk / Storage Errors</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${report.diskErrorCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                {report.diskErrorCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-[11px] text-slate-400">GPU Driver Resets</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${report.gpuResetCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                {report.gpuResetCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-[11px] text-slate-400">Crash Dump Files</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${report.minidumpFiles.length > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {report.minidumpFiles.length}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-200">
              {report.status === "fail" ? (
                <AlertOctagon className="w-4 h-4 text-rose-400" />
              ) : (
                <FileWarning className="w-4 h-4 text-cyan-400" />
              )}
              <span>{report.summary}</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyHardware}
                  onChange={(e) => setOnlyHardware(e.target.checked)}
                  className="accent-cyan-500"
                />
                Hardware / Crash Only
              </label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter source or message..."
                  className="bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] sticky top-0">
                  <tr>
                    <th className="px-3 py-2.5">Timestamp</th>
                    <th className="px-3 py-2.5">Level</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Source</th>
                    <th className="px-3 py-2.5">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filteredEntries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                        No matching error events found.
                      </td>
                    </tr>
                  ) : (
                    filteredEntries.map((ev, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/40">
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-slate-400">{ev.timestamp}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              ev.level === "Critical"
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-amber-500/20 text-amber-300"
                            }`}
                          >
                            {ev.level}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-cyan-300 font-medium">{ev.category}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-200">{ev.source}</td>
                        <td className="px-3 py-2 text-slate-300 break-words max-w-md">{ev.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
