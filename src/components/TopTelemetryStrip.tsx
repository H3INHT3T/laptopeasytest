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
  const batW = telemetry?.batteryWatts;
  const cpuTemp = telemetry?.cpuTempC;
  const gpuTemp = telemetry?.gpuTempC;

  return (
    <header className="h-10 shrink-0 bg-white border-b border-zinc-300 flex items-center justify-between px-4 select-none text-[11px] font-mono tabular-nums overflow-x-auto">
      {/* Left: Device Under Test Identity */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center gap-1.5 font-sans font-bold text-black tracking-tight shrink-0">
          <Laptop className="w-3.5 h-3.5 text-blue-600" />
          {specs ? `${specs.manufacturer} ${specs.model}` : "PROBING HARDWARE..."}
        </span>
        {specs?.serialNumber && (
          <span className="px-1.5 py-0.5 bg-zinc-100 border border-zinc-300 text-zinc-700 text-[10px] rounded-[2px] shrink-0">
            S/N {specs.serialNumber}
          </span>
        )}
        {specs?.isGamingCapable && (
          <span className="px-1.5 py-0.5 bg-blue-600 text-white text-[10px] font-bold rounded-[2px] shrink-0">
            dGPU
          </span>
        )}
      </div>

      {/* Right: Live Docked Instrument Sensors */}
      <div className="flex items-center divide-x divide-zinc-300 shrink-0 ml-4">
        <div className="px-3 flex items-center gap-1.5 text-black">
          <Cpu className="w-3 h-3 text-blue-600" />
          <span className="text-zinc-500">CPU</span>
          <strong className="text-black">
            {telemetry ? `${telemetry.cpuUsagePct.toFixed(0)}%` : "—"}
          </strong>
          {telemetry && telemetry.cpuClockMhz > 0 && (
            <span className="text-zinc-600">{telemetry.cpuClockMhz}MHz</span>
          )}
        </div>

        <div className="px-3 flex items-center gap-1.5 text-black">
          <Thermometer className="w-3 h-3 text-blue-600" />
          <span className="text-zinc-500">TEMP</span>
          <strong>
            {cpuTemp != null
              ? `${cpuTemp.toFixed(0)}°C`
              : gpuTemp != null
              ? `GPU ${gpuTemp.toFixed(0)}°C`
              : "N/A"}
          </strong>
        </div>

        <div className="px-3 flex items-center gap-1.5 text-black">
          {acPlugged === false ? (
            <BatteryCharging className="w-3 h-3 text-black" />
          ) : (
            <Plug className="w-3 h-3 text-blue-600" />
          )}
          <span className={acPlugged === false ? "font-bold text-black underline" : "text-blue-700 font-bold"}>
            {acPlugged === true ? "AC" : acPlugged === false ? "BAT" : "PWR"}
          </span>
          {batPct != null && <strong>{batPct.toFixed(0)}%</strong>}
          {batW != null && (
            <span className="text-zinc-600">
              ({batW >= 0 ? "+" : ""}
              {batW.toFixed(1)}W)
            </span>
          )}
        </div>

        <div className="pl-3 flex items-center gap-1.5 text-zinc-700">
          <Activity className="w-3 h-3 text-blue-600" />
          <span className="text-zinc-500">QC</span>
          <strong className="text-blue-700">
            {String(completedCount).padStart(2, "0")}/{String(totalSteps).padStart(2, "0")}
          </strong>
        </div>
      </div>
    </header>
  );
};
