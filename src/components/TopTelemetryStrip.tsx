import React from "react";
import { Activity, BatteryCharging, Cpu, Fan, Laptop, Plug, Thermometer } from "lucide-react";
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
  const cpuPowerW = telemetry?.cpuPowerW;
  const gpuPowerW = telemetry?.gpuPowerW;
  const fanRpm = telemetry?.fanRpm;

  const cpuSensorAvailable = telemetry?.cpuTempAvailable !== false;
  const gpuSensorAvailable = telemetry?.gpuTempAvailable !== false;
  const powerSensorAvailable = telemetry?.powerWattsAvailable !== false;

  const cpuTemp = cpuSensorAvailable ? telemetry?.cpuTempC ?? null : null;
  const gpuTemp = gpuSensorAvailable ? telemetry?.gpuTempC ?? null : null;

  const showGpuAlongside =
    gpuTemp != null && (Boolean(specs?.isGamingCapable) || gpuTemp >= 75 || cpuTemp == null);

  const cpuHot = cpuTemp != null && cpuTemp >= 85;
  const gpuHot = gpuTemp != null && gpuTemp >= 85;
  const tempSourceText = telemetry?.tempSource || telemetry?.sensorSource || "Native OS Bridge";

  const tempUnavailableCue =
    telemetry != null &&
    cpuTemp == null &&
    gpuTemp == null &&
    (telemetry.cpuTempAvailable === false || telemetry.gpuTempAvailable === false);

  const tempTooltipParts = [
    `Source: ${tempSourceText}`,
    cpuTemp != null
      ? `CPU: ${cpuTemp.toFixed(1)}°C`
      : telemetry?.cpuTempAvailable === false
      ? "CPU temp: Sensor unavailable (bounded safe fallback active)"
      : "CPU temp: Waiting for reading",
    gpuTemp != null
      ? `GPU: ${gpuTemp.toFixed(1)}°C`
      : telemetry?.gpuTempAvailable === false
      ? "GPU temp: Sensor unavailable"
      : null,
    fanRpm != null ? `Fan: ${fanRpm} RPM` : null,
  ]
    .filter(Boolean)
    .join(" • ");

  const powerTooltipParts = [
    acPlugged === true
      ? "Plugged into AC wall power"
      : acPlugged === false
      ? "Running on internal battery"
      : "Power state probing",
    !powerSensorAvailable
      ? "Power wattage: Sensor unavailable on this controller"
      : [
          batW != null ? `Battery: ${batW >= 0 ? "+" : ""}${batW.toFixed(1)}W` : null,
          cpuPowerW != null ? `CPU Pkg: ${cpuPowerW.toFixed(1)}W` : null,
          gpuPowerW != null ? `GPU: ${gpuPowerW.toFixed(1)}W` : null,
        ]
          .filter(Boolean)
          .join(" • ") || "Wattage telemetry waiting",
  ].join(" — ");

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
        <div
          className="px-3 flex items-center gap-1.5 text-black"
          title={
            telemetry
              ? `CPU Usage: ${telemetry.cpuUsagePct.toFixed(1)}% @ ${telemetry.cpuClockMhz}MHz (${telemetry.sensorSource})`
              : "Waiting for CPU telemetry"
          }
        >
          <Cpu className="w-3 h-3 text-blue-600" />
          <span className="text-zinc-500">CPU</span>
          <strong className="text-black">
            {telemetry ? `${telemetry.cpuUsagePct.toFixed(0)}%` : "—"}
          </strong>
          {telemetry && telemetry.cpuClockMhz > 0 && (
            <span className="text-zinc-600">{telemetry.cpuClockMhz}MHz</span>
          )}
        </div>

        <div className="px-3 flex items-center gap-1.5 text-black" title={tempTooltipParts}>
          <Thermometer className="w-3 h-3 text-blue-600 shrink-0" />
          <span className="text-zinc-500">TEMP</span>
          {tempUnavailableCue ? (
            <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-zinc-700 text-[10px] font-semibold">
              Sensor unavailable
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {cpuTemp != null ? (
                <strong
                  className={
                    cpuHot
                      ? "bg-black text-white px-1.5 py-0.5 rounded-[2px] font-black"
                      : "text-black"
                  }
                >
                  {showGpuAlongside ? `CPU ${cpuTemp.toFixed(0)}°C` : `${cpuTemp.toFixed(0)}°C`}
                </strong>
              ) : telemetry?.cpuTempAvailable === false && gpuTemp != null ? (
                <span className="text-zinc-500 text-[10px]">CPU Sensor unavailable</span>
              ) : null}

              {showGpuAlongside && gpuTemp != null && (
                <strong
                  className={
                    gpuHot
                      ? "bg-black text-white px-1.5 py-0.5 rounded-[2px] font-black"
                      : "text-blue-700"
                  }
                >
                  GPU {gpuTemp.toFixed(0)}°C
                </strong>
              )}

              {cpuTemp == null && gpuTemp == null && (
                <strong className="text-zinc-600">
                  {telemetry == null ? "—" : "Sensor unavailable"}
                </strong>
              )}
            </span>
          )}
          {fanRpm != null && fanRpm > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-zinc-600 text-[10px]"
              title={`Cooling fan speed (${tempSourceText})`}
            >
              <Fan className="w-2.5 h-2.5 text-blue-600" />
              {fanRpm}RPM
            </span>
          )}
        </div>

        <div className="px-3 flex items-center gap-1.5 text-black" title={powerTooltipParts}>
          {acPlugged === false ? (
            <BatteryCharging className="w-3 h-3 text-black" />
          ) : (
            <Plug className="w-3 h-3 text-blue-600" />
          )}
          <span className={acPlugged === false ? "font-bold text-black underline" : "text-blue-700 font-bold"}>
            {acPlugged === true ? "AC" : acPlugged === false ? "BAT" : "PWR"}
          </span>
          {batPct != null && <strong>{batPct.toFixed(0)}%</strong>}
          {!powerSensorAvailable ? (
            <span className="text-zinc-500 text-[10px]">(Sensor unavailable)</span>
          ) : batW != null ? (
            <span className="text-zinc-600">
              ({batW >= 0 ? "+" : ""}
              {batW.toFixed(1)}W)
            </span>
          ) : cpuPowerW != null ? (
            <span className="text-zinc-600">({cpuPowerW.toFixed(1)}W)</span>
          ) : null}
        </div>

        {telemetry?.sensorSource && (
          <div
            className="px-3 flex items-center gap-1.5 text-[10px] text-zinc-700 shrink-0"
            title={`Active telemetry sensor source: ${telemetry.sensorSource}`}
          >
            <span className="text-zinc-500">SRC</span>
            <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black font-semibold whitespace-nowrap">
              {telemetry.sensorSource}
            </span>
          </div>
        )}

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
