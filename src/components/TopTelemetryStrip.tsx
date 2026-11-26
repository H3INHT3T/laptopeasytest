import React from "react";
import { Activity, BatteryCharging, Cpu, Laptop, Plug, Thermometer } from "lucide-react";
import type { LiveTelemetrySnapshot, SystemSpecs } from "../types";

interface TopTelemetryStripProps {
  specs: SystemSpecs | null;
  telemetry: LiveTelemetrySnapshot | null;
  completedCount: number;
  totalSteps: number;
}

export const TopTelemetryStrip: React.FC<TopTelemetryStripProps> = ({
  specs,
  telemetry,
  completedCount,
  totalSteps,
}) => {
  const acPlugged = telemetry?.acPlugged;
  const batPct = telemetry?.batteryPercent;
  const cpuSensorAvailable = telemetry?.cpuTempAvailable !== false;
  const gpuSensorAvailable = telemetry?.gpuTempAvailable !== false;
  const cpuTemp = cpuSensorAvailable ? telemetry?.cpuTempC ?? null : null;
  const gpuTemp = gpuSensorAvailable ? telemetry?.gpuTempC ?? null : null;
  const tempUnavailableCue =
    telemetry != null &&
    cpuTemp == null &&
    gpuTemp == null &&
    (telemetry.cpuTempAvailable === false || telemetry.gpuTempAvailable === false);

  return (
    <header className="h-11 shrink-0 bg-white border-b border-zinc-200 flex items-center justify-between px-4 select-none text-xs overflow-x-auto">
      {/* Left: Clean Device Identity */}
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="inline-flex items-center gap-2 font-bold text-black tracking-tight shrink-0">
          <Laptop className="w-4 h-4 text-blue-600" />
          {specs ? `${specs.manufacturer} ${specs.model}` : "Detecting Laptop..."}
        </span>
        {specs?.serialNumber && (
          <span className="px-2 py-0.5 bg-[#F8FAFC] border border-zinc-200 text-zinc-600 font-mono text-[10px] rounded-md shrink-0">
            S/N {specs.serialNumber}
          </span>
        )}
      </div>

      {/* Right: Compact Live Pills */}
      <div className="flex items-center gap-3 shrink-0 ml-4 font-mono text-[11px] tabular-nums">
        <div className="flex items-center gap-1.5 text-zinc-800">
          <Cpu className="w-3.5 h-3.5 text-blue-600" />
          <strong className="text-black">{telemetry ? `${telemetry.cpuUsagePct.toFixed(0)}%` : "—"}</strong>
          {telemetry && telemetry.cpuClockMhz > 0 && (
            <span className="text-zinc-500">{telemetry.cpuClockMhz}MHz</span>
          )}
        </div>

        <div className="h-3.5 w-px bg-zinc-200" />

        <div className="flex items-center gap-1.5 text-zinc-800">
          <Thermometer className="w-3.5 h-3.5 text-blue-600" />
          {tempUnavailableCue ? (
            <span className="text-zinc-500 text-[10px]">Sensor unavailable</span>
          ) : cpuTemp != null ? (
            <strong className={cpuTemp >= 85 ? "bg-black text-white px-1.5 py-0.5 rounded" : "text-black"}>
              {cpuTemp.toFixed(0)}°C
            </strong>
          ) : gpuTemp != null ? (
            <strong className="text-blue-700">GPU {gpuTemp.toFixed(0)}°C</strong>
          ) : (
            <span className="text-zinc-500">{telemetry == null ? "—" : "Sensor unavailable"}</span>
          )}
        </div>

        <div className="h-3.5 w-px bg-zinc-200" />

        <div className="flex items-center gap-1.5 text-zinc-800">
          {acPlugged === false ? (
            <BatteryCharging className="w-3.5 h-3.5 text-black" />
          ) : (
            <Plug className="w-3.5 h-3.5 text-blue-600" />
          )}
          <span className="font-bold text-black">
            {acPlugged === true ? "AC" : acPlugged === false ? "BAT" : "PWR"}
          </span>
          {batPct != null && <span className="text-zinc-600">{batPct.toFixed(0)}%</span>}
        </div>

        {telemetry?.sensorSource && (
          <>
            <div className="h-3.5 w-px bg-zinc-200 hidden md:block" />
            <span className="hidden md:inline-block px-2 py-0.5 rounded-md bg-[#F8FAFC] border border-zinc-200 text-[10px] text-zinc-600">
              {telemetry.sensorSource}
            </span>
          </>
        )}

        <div className="h-3.5 w-px bg-zinc-200" />

        <div className="flex items-center gap-1 text-blue-700 font-bold">
          <Activity className="w-3.5 h-3.5" />
          <span>
            {String(completedCount).padStart(2, "0")}/{String(totalSteps).padStart(2, "0")}
          </span>
        </div>
      </div>
    </header>
  );
};
