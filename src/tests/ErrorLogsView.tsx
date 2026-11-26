import React, { useMemo, useState } from "react";
import { AlertOctagon, CheckSquare, FileWarning, RefreshCw, Search } from "lucide-react";
import type { ErrorLogEntry, ErrorLogsReport, TestStatus } from "../types";
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

type CategoryFilter = "All" | "WHEA" | "Thermal" | "BSOD" | "Storage" | "GPU";

interface GroupedLogEntry {
  entry: ErrorLogEntry;
  count: number;
  earliestTs: string;
}

function matchesCategoryPill(ev: ErrorLogEntry, cat: CategoryFilter): boolean {
  if (cat === "All") return true;
  const hay = `${ev.category} ${ev.source} ${ev.message}`.toLowerCase();
  if (cat === "WHEA") return /whea|hardware|mce|pci|cpu/.test(hay);
  if (cat === "Thermal") return /thermal|overheat|acpi.*temp|prochot|throttl/.test(hay);
  if (cat === "BSOD") return /bsod|bugcheck|kernel-power|panic|crash|dump|41\b|1001\b/.test(hay);
  if (cat === "Storage") return /disk|stornvme|nvme|storage|ntfs|bad block|ahci|129\b|153\b/.test(hay);
  if (cat === "GPU") return /gpu|tdr|display|nvlddmkm|amdkmdag|igfx|4101\b/.test(hay);
  return true;
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
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("All");
  const [deduplicate, setDeduplicate] = useState(true);

  const filteredEntries = useMemo(() => {
    return (report?.entries ?? []).filter((e) => {
      if (onlyHardware && e.category === "System / App") return false;
      if (!matchesCategoryPill(e, categoryFilter)) return false;
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return (
        e.source.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        (e.eventId != null && String(e.eventId).includes(q))
      );
    });
  }, [report?.entries, onlyHardware, categoryFilter, filter]);

  const displayedEntries: GroupedLogEntry[] = useMemo(() => {
    if (!deduplicate) {
      return filteredEntries.map((entry) => ({ entry, count: 1, earliestTs: entry.timestamp }));
    }
    const groups = new Map<string, GroupedLogEntry>();
    for (const ev of filteredEntries) {
      const key = `${ev.source}|${ev.level}|${ev.eventId ?? ""}|${ev.category}|${ev.message.trim()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.earliestTs = ev.timestamp;
      } else {
        groups.set(key, { entry: ev, count: 1, earliestTs: ev.timestamp });
      }
    }
    return Array.from(groups.values());
  }, [filteredEntries, deduplicate]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-xs font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              System Error &amp; Crash Logs
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Inspects Windows Event Viewer &amp; Minidumps (BSOD, Kernel-Power 41, WHEA, Thermal, StorNVMe Disk, GPU TDR) or macOS Kernel Panics &amp; Unified Logs.
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
            className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-2 text-xs text-black font-medium"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
          </select>
          <button
            onClick={() => onScan(days)}
            disabled={loading}
            className="px-3.5 py-2 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
            Re-scan Logs
          </button>
        </div>
      </div>

      {!report ? (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-10 text-center text-sm text-zinc-600">
          {loading ? "Scanning OS critical & hardware error logs..." : "Click Re-scan Logs to inspect crash history."}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: "BSOD / Kernel Panics", val: report.bsodOrPanicCount },
              { label: "WHEA / Hardware Faults", val: report.wheaOrHwCount },
              { label: "Thermal / Overheat", val: report.thermalEventCount ?? 0 },
              { label: "Disk / Storage Errors", val: report.diskErrorCount },
              { label: "GPU Driver Resets", val: report.gpuResetCount },
              { label: "Crash Dump Files", val: report.minidumpFiles.length },
            ].map((k) => (
              <div
                key={k.label}
                className={`rounded-[2px] border p-3.5 bg-white ${
                  k.val > 0 ? "border-zinc-300 border-l-[3px] border-l-black" : "border-zinc-300"
                }`}
              >
                <div className="text-[11px] text-zinc-500">{k.label}</div>
                <div className={`text-2xl font-black font-mono tabular-nums mt-1 ${k.val > 0 ? "text-black" : "text-blue-600"}`}>
                  {k.val}
                </div>
              </div>
            ))}
          </div>

          {/* Plain-Language Stability & Buyer Risk Summary */}
          <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
              Plain-Language Stability &amp; Buyer Risk Summary
            </div>
            <div className="text-xs text-black font-medium">
              {report.plainSummary || report.summary}
            </div>
            {(report.buyerInterpretation?.length ?? 0) > 0 && (
              <ul className="space-y-1 text-xs text-zinc-700 pt-1 border-t border-zinc-100">
                {report.buyerInterpretation!.map((line, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <CheckSquare className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}
            {report.minidumpFiles.length > 0 && (
              <div className="pt-2 border-t border-zinc-100 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] font-bold uppercase text-zinc-500 mr-1">
                  Crash Dump / Panic Files:
                </span>
                {report.minidumpFiles.map((fname, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10px] text-black"
                  >
                    {fname}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2 text-xs text-black font-medium">
                {report.status === "fail" ? (
                  <AlertOctagon className="w-4 h-4 text-black shrink-0" />
                ) : (
                  <FileWarning className="w-4 h-4 text-blue-600 shrink-0" />
                )}
                <span>{report.summary}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-black cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={deduplicate}
                    onChange={(e) => setDeduplicate(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Deduplicate Identical Events
                </label>
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
                    placeholder="Filter source, ID, or message..."
                    className="bg-white border border-zinc-300 rounded-[2px] pl-8 pr-3 py-1.5 text-xs text-black focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>
            </div>

            {/* Category Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-zinc-200 font-mono text-[10.5px]">
              <span className="text-[10px] font-bold uppercase text-zinc-500 mr-1">Subsystem:</span>
              {(["All", "WHEA", "Thermal", "BSOD", "Storage", "GPU"] as CategoryFilter[]).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1 rounded-[2px] border font-bold uppercase cursor-pointer ${
                    categoryFilter === cat
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-white border-zinc-300 text-black hover:border-black"
                  }`}
                >
                  {cat}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
                Showing {displayedEntries.length} {deduplicate ? "unique" : "raw"} ({filteredEntries.length} total matching)
              </span>
            </div>
          </div>

          <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-zinc-500 uppercase text-[10px] sticky top-0">
                  <tr>
                    <th className="px-3 py-2.5">Timestamp</th>
                    <th className="px-3 py-2.5">Level</th>
                    <th className="px-3 py-2.5">Event ID</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Source</th>
                    <th className="px-3 py-2.5">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {displayedEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                        No matching error events found.
                      </td>
                    </tr>
                  ) : (
                    displayedEntries.map(({ entry: ev, count, earliestTs }, idx) => (
                      <tr key={idx} className="hover:bg-blue-50/40">
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-500">
                          <div>{ev.timestamp}</div>
                          {count > 1 && earliestTs !== ev.timestamp && (
                            <div className="text-[9.5px] text-zinc-400">since {earliestTs}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`px-1.5 py-0.5 rounded-[2px] text-[10px] font-bold ${
                              ev.level === "Critical"
                                ? "bg-black text-white"
                                : "bg-blue-50 text-blue-800 border border-blue-200"
                            }`}
                          >
                            {ev.level}
                          </span>
                          {count > 1 && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[9.5px] font-bold">
                              ×{count}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-black font-semibold">
                          {ev.eventId != null ? `ID ${ev.eventId}` : "—"}
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
