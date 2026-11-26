import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Moon, RefreshCw, Search } from "lucide-react";
import type { ErrorLogEntry, ErrorLogsReport, SleepStandbyReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface ErrorLogsViewProps {
  report: ErrorLogsReport | null;
  sleepReport?: SleepStandbyReport | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onScan: (days: number) => void;
  onSleepAuditLoaded?: (rep: SleepStandbyReport) => void;
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
  sleepReport = null,
  loading,
  status,
  stepNumber,
  totalSteps,
  onScan,
  onSleepAuditLoaded,
  onNext,
  onSkip,
}) => {
  const [days, setDays] = useState(30);
  const [localSleep, setLocalSleep] = useState<SleepStandbyReport | null>(sleepReport);
  const [sleepLoading, setSleepLoading] = useState(false);

  const effectiveSleep = sleepReport ?? localSleep;

  useEffect(() => {
    if (!effectiveSleep) {
      setSleepLoading(true);
      invoke<SleepStandbyReport>("run_sleep_standby_audit")
        .then((res) => {
          setLocalSleep(res);
          onSleepAuditLoaded?.(res);
        })
        .catch(() => {})
        .finally(() => setSleepLoading(false));
    }
  }, []);
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

  const criticalCount = report
    ? report.bsodOrPanicCount + report.wheaOrHwCount + report.diskErrorCount + report.gpuResetCount
    : 0;
  const stabilityPct = report ? (report.status === "fail" ? 25 : report.status === "warn" ? 72 : 100) : 0;

  return (
    <div className="space-y-6">
      {/* BLOCK 1: Minimal Header + 1 Primary Button */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              System Error &amp; Crash Logs
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • BSOD, WHEA hardware faults, disk &amp; GPU resets (last {days} days)
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => {
              const d = Number(e.target.value);
              setDays(d);
              onScan(d);
            }}
            className="bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs text-black font-medium"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
          </select>
          <button
            type="button"
            onClick={() => onScan(days)}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Re-scan logs
          </button>
        </div>
      </div>

      {/* BLOCK 2: 1 Clean Visual Result Block */}
      {!report ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500">
          {loading ? "Scanning OS critical & hardware logs..." : "Click Re-scan logs to inspect crash history."}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
            {[
              { label: "BSOD / Panics", val: report.bsodOrPanicCount },
              { label: "WHEA hardware", val: report.wheaOrHwCount },
              { label: "Disk errors", val: report.diskErrorCount },
              { label: "GPU resets", val: report.gpuResetCount },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
                <div className="text-xs text-zinc-500">{k.label}</div>
                <div className={`text-2xl font-bold font-mono tabular-nums ${k.val > 0 ? "text-black" : "text-blue-600"}`}>
                  {k.val}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-zinc-100">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-black">{report.plainSummary || report.summary}</span>
              <span className="font-mono font-bold text-zinc-600 shrink-0">
                {criticalCount} hardware event{criticalCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${report.status === "fail" ? "bg-black" : "bg-blue-600"}`}
                style={{ width: `${stabilityPct}%` }}
              />
            </div>

            {/* Passive Sleep & Modern Standby (S0ix / S3) Drain & Wake Audit (v3.0.0) */}
            <div className="pt-3 border-t border-zinc-100">
              <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <Moon className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  <span className="font-semibold text-black">Sleep &amp; Modern Standby (S0ix / S3)</span>
                  {effectiveSleep ? (
                    <span className="text-zinc-500 font-mono text-[11px]">
                      {effectiveSleep.sleepMode}
                      {effectiveSleep.maxDrainPctPerHr != null
                        ? ` • Peak ${effectiveSleep.maxDrainPctPerHr.toFixed(1)}%/hr drain`
                        : ""}
                      {` • ${effectiveSleep.wakeArmedDevices.length} wake-armed`}
                      {effectiveSleep.sleepCrashCount > 0 ? ` • ${effectiveSleep.sleepCrashCount} sleep crash(es)` : ""}
                    </span>
                  ) : (
                    <span className="text-zinc-400">{sleepLoading ? "Auditing sleep study..." : "Ready"}</span>
                  )}
                </div>
                {effectiveSleep && <StatusBadge status={effectiveSleep.status} compact />}
              </div>
              {effectiveSleep && effectiveSleep.status !== "pass" && (
                <div className="mt-2 rounded-lg border border-black bg-[#F8FAFC] px-3 py-2 text-xs text-black">
                  {effectiveSleep.plainSummary}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BLOCK 3: 1 Collapsed "Details" Toggle (Full Filterable Event Log Table) */}
      {report && (
        <TechnicalDetailsDrawer
          title="Details"
          subtitle={`${report.entries.length} OS event(s) • ${report.minidumpFiles.length} crash dump file(s)`}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {(["All", "WHEA", "Thermal", "BSOD", "Storage", "GPU"] as CategoryFilter[]).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer ${
                      categoryFilter === cat
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-white border-zinc-200 text-black hover:border-black"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1.5 text-xs text-black cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deduplicate}
                    onChange={(e) => setDeduplicate(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Deduplicate
                </label>
                <label className="flex items-center gap-1.5 text-xs text-black cursor-pointer">
                  <input
                    type="checkbox"
                    checked={onlyHardware}
                    onChange={(e) => setOnlyHardware(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Hardware only
                </label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter events..."
                    className="bg-white border border-zinc-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-black"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-zinc-500 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Level</th>
                      <th className="px-3 py-2 font-medium">ID</th>
                      <th className="px-3 py-2 font-medium">Source</th>
                      <th className="px-3 py-2 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {displayedEntries.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                          No matching events found.
                        </td>
                      </tr>
                    ) : (
                      displayedEntries.map(({ entry: ev, count }, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-500">{ev.timestamp}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                ev.level === "Critical" ? "bg-black text-white" : "bg-blue-50 text-blue-700"
                              }`}
                            >
                              {ev.level}
                            </span>
                            {count > 1 && (
                              <span className="ml-1 font-mono text-[10px] font-bold text-black">×{count}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap text-black">
                            {ev.eventId != null ? ev.eventId : "—"}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-black font-medium">{ev.source}</td>
                          <td className="px-3 py-2 text-zinc-600 break-words max-w-md">{ev.message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </TechnicalDetailsDrawer>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(report)}
        requirementHint="Scan OS error logs before continuing."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
