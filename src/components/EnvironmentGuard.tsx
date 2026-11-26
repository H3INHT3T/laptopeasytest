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

  const validCpuTemp =
    telemetry.cpuTempAvailable !== false ? telemetry.cpuTempC : null;
  const validGpuTemp =
    telemetry.gpuTempAvailable !== false ? telemetry.gpuTempC : null;

  const onBattery = requireAc && telemetry.acPlugged === false;
  const highCpu = telemetry.cpuUsagePct > 18;
  const hotCpu = validCpuTemp != null && validCpuTemp >= 75;
  const hotGpu = validGpuTemp != null && validGpuTemp >= 75;
  const hotStart = hotCpu || hotGpu;
  const showGpuTemp =
    validGpuTemp != null && (validGpuTemp >= 75 || validCpuTemp == null);
  const tempUnavailable =
    validCpuTemp == null &&
    validGpuTemp == null &&
    (telemetry.cpuTempAvailable === false || telemetry.gpuTempAvailable === false);
  const hasIssue = onBattery || highCpu || hotStart;

  const advisoryWhyParts: string[] = [];
  if (onBattery) {
    advisoryWhyParts.push("battery power limits CPU/GPU boost clocks");
  }
  if (highCpu) {
    advisoryWhyParts.push("background apps compete for CPU & memory bandwidth");
  }
  if (hotStart) {
    advisoryWhyParts.push("starting warm reduces thermal headroom before throttling");
  }

  return (
    <div
      className={`rounded-[2px] border px-3.5 py-2 space-y-1 text-[11px] font-mono tabular-nums ${
        hasIssue
          ? "border-black bg-zinc-50 text-black"
          : "border-zinc-300 bg-[#F8FAFC] text-zinc-700"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
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
          {validCpuTemp != null && (
            <>
              <span className="text-zinc-300">|</span>
              <span className={hotCpu ? "font-bold text-black underline" : "text-zinc-700"}>
                START TEMP: {validCpuTemp.toFixed(0)}°C {hotCpu ? "(HOT)" : "OK"}
              </span>
            </>
          )}
          {tempUnavailable && (
            <>
              <span className="text-zinc-300">|</span>
              <span className="text-zinc-700 font-semibold">
                TEMP: Sensor unavailable (Bounded Safe Run)
              </span>
            </>
          )}
          {showGpuTemp && validGpuTemp != null && (
            <>
              <span className="text-zinc-300">|</span>
              <span className={hotGpu ? "font-bold text-black underline" : "text-zinc-700"}>
                GPU TEMP: {validGpuTemp.toFixed(0)}°C {hotGpu ? "(HOT)" : "OK"}
              </span>
            </>
          )}
          {!hasIssue && <CheckCircle2 className="w-3.5 h-3.5 text-blue-600" />}
        </div>
      </div>

      {hasIssue && (
        <div className="font-sans text-[11px] text-zinc-700">
          Why this matters: {advisoryWhyParts.join("; ")} — resolve before scoring for an accurate factory comparison.
        </div>
      )}
    </div>
  );
};
