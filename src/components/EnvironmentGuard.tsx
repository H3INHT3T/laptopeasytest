import React from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import type { LiveTelemetrySnapshot } from "../types";

interface EnvironmentGuardProps {
  telemetry: LiveTelemetrySnapshot | null;
  requireAc?: boolean;
}

/**
 * Pre-Test Reliability Guardrail — checks AC power, idle background CPU load,
 * and starting thermal headroom before running performance or stress benchmarks.
 */
export const EnvironmentGuard: React.FC<EnvironmentGuardProps> = ({
  telemetry,
  requireAc = true,
}) => {
  if (!telemetry) return null;

  const onBattery = requireAc && telemetry.acPlugged === false;
  const highCpu = telemetry.cpuUsagePct > 18;
  const hotStart = (telemetry.cpuTempC ?? 0) >= 75 || (telemetry.gpuTempC ?? 0) >= 75;
  const hasIssue = onBattery || highCpu || hotStart;

  return (
    <div
      className={`rounded-[2px] border px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums ${
        hasIssue
          ? "border-black bg-zinc-50 text-black"
          : "border-zinc-300 bg-[#F8FAFC] text-zinc-700"
      }`}
    >
      <div className="flex items-center gap-2 font-bold">
        {hasIssue ? (
          <AlertTriangle className="w-3.5 h-3.5 text-blue-600 shrink-0" />
        ) : (
          <ShieldCheck className="w-3.5 h-3.5 text-blue-600 shrink-0" />
        )}
        <span className="uppercase tracking-wider text-black">
          {hasIssue ? "Pre-Test Reliability Advisory" : "Pre-Test Lab Conditions: Verified"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[10.5px]">
        <span className={onBattery ? "font-bold text-black underline" : "text-blue-700 font-semibold"}>
          {onBattery
            ? "WARN: ON BATTERY (Plug AC Charger for Full Speed)"
            : telemetry.acPlugged === true
            ? "AC POWER: OK"
            : "AC: DETECTED"}
        </span>
        <span className="text-zinc-300">|</span>
        <span className={highCpu ? "font-bold text-black underline" : "text-zinc-700"}>
          {highCpu
            ? `WARN: BG CPU ${telemetry.cpuUsagePct.toFixed(0)}% (Close Apps)`
            : `IDLE CPU: ${telemetry.cpuUsagePct.toFixed(0)}% OK`}
        </span>
        {telemetry.cpuTempC != null && (
          <>
            <span className="text-zinc-300">|</span>
            <span className={hotStart ? "font-bold text-black underline" : "text-zinc-700"}>
              START TEMP: {telemetry.cpuTempC.toFixed(0)}°C {hotStart ? "(HOT)" : "OK"}
            </span>
          </>
        )}
        {!hasIssue && <CheckCircle2 className="w-3.5 h-3.5 text-blue-600" />}
      </div>
    </div>
  );
};
