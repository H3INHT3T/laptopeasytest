import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Activity, Thermometer, ShieldCheck, X } from "lucide-react";
import type { LiveTelemetrySnapshot } from "../types";

interface BottomSensorsDockProps {
  telemetry: LiveTelemetrySnapshot | null;
}

interface SparkHistory {
  cpuTemp: number[];
  cpuPower: number[];
  cpuUsage: number[];
  cpuFreq: number[];
  gpuTemp: number[];
  gpuPower: number[];
  gpuUsage: number[];
}

const MiniSpark: React.FC<{ values: number[]; maxHint?: number; accent?: boolean }> = ({
  values,
  maxHint = 100,
  accent = false,
}) => {
  const w = 64;
  const h = 18;
  if (values.length < 2) {
    return (
      <svg width={w} height={h} className="overflow-visible">
        <line x1={0} y1={h - 2} x2={w} y2={h - 2} stroke="#d4d4d8" strokeWidth={1.2} />
      </svg>
    );
  }
  const hi = Math.max(maxHint, ...values, 1);
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * w;
      const y = h - 2 - (Math.max(0, v) / hi) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        fill="none"
        stroke={accent ? "#2563EB" : "#09090B"}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
    </svg>
  );
};

export const BottomSensorsDock: React.FC<BottomSensorsDockProps> = ({ telemetry }) => {
  const [expanded, setExpanded] = useState(false);
  const [showSensorHelp, setShowSensorHelp] = useState(false);
  const [hist, setHist] = useState<SparkHistory>({
    cpuTemp: [],
    cpuPower: [],
    cpuUsage: [],
    cpuFreq: [],
    gpuTemp: [],
    gpuPower: [],
    gpuUsage: [],
  });

  useEffect(() => {
    if (!telemetry) return;
    const push = (arr: number[], v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return arr;
      return [...arr.slice(-19), v];
    };
    setHist((prev) => ({
      cpuTemp: push(prev.cpuTemp, telemetry.cpuTempC),
      cpuPower: push(prev.cpuPower, telemetry.cpuPowerW),
      cpuUsage: push(prev.cpuUsage, telemetry.cpuUsagePct),
      cpuFreq: push(prev.cpuFreq, telemetry.cpuClockMhz),
      gpuTemp: push(prev.gpuTemp, telemetry.gpuTempC),
      gpuPower: push(prev.gpuPower, telemetry.gpuPowerW),
      gpuUsage: push(prev.gpuUsage, telemetry.gpuLoadPct),
    }));
  }, [telemetry]);

  const perCoreTemps = telemetry?.perCoreTempsC ?? [];
  const tempUnavailable = Boolean(telemetry && !telemetry.cpuTempAvailable);

  return (
    <div className="shrink-0 bg-white border-t border-zinc-200 select-none">
      <div className="w-full h-8 px-4 flex items-center justify-between text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 h-full flex items-center gap-1.5 text-left cursor-pointer"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          <span>Sensors</span>
          {telemetry?.sensorSource && (
            <span className="text-[10px] font-mono text-zinc-400 ml-1">
              • {telemetry.sensorSource}
            </span>
          )}
          {perCoreTemps.length > 0 && (
            <span className="text-[10px] font-mono text-blue-600 ml-1">
              • {perCoreTemps.length} cores
            </span>
          )}
        </button>
        <div className="flex items-center gap-2.5">
          {tempUnavailable && (
            <button
              type="button"
              onClick={() => setShowSensorHelp(true)}
              className="px-2 py-0.5 rounded-md border border-blue-600 bg-blue-50/70 hover:bg-blue-100 text-[10px] font-bold text-blue-700 inline-flex items-center gap-1 cursor-pointer"
            >
              <Thermometer className="w-3 h-3" />
              Enable Sensors
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500 cursor-pointer"
          >
            <Activity className="w-3 h-3 text-blue-600" />
            Live Telemetry
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-200 overflow-x-auto">
          <table className="w-full text-left border-collapse text-[11px] font-mono tabular-nums">
            <thead>
              <tr className="text-[10px] text-zinc-400 border-b border-zinc-100">
                <th className="py-1 px-4 font-medium w-20">Device</th>
                <th className="py-1 px-2 font-medium">Temp</th>
                <th className="py-1 px-2 font-medium w-20" />
                <th className="py-1 px-2 font-medium">Power</th>
                <th className="py-1 px-2 font-medium w-20" />
                <th className="py-1 px-2 font-medium">Usage</th>
                <th className="py-1 px-2 font-medium w-20" />
                <th className="py-1 px-2 font-medium">Freq</th>
                <th className="py-1 px-4 font-medium w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 text-black">
              <tr>
                <td className="py-1.5 px-4 font-sans font-bold">CPU</td>
                <td className="py-1.5 px-2">
                  {telemetry?.cpuTempC != null ? `${telemetry.cpuTempC.toFixed(0)} °C` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.cpuTemp} maxHint={100} accent />
                </td>
                <td className="py-1.5 px-2">
                  {telemetry?.cpuPowerW != null ? `${telemetry.cpuPowerW.toFixed(1)} W` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.cpuPower} maxHint={65} />
                </td>
                <td className="py-1.5 px-2">
                  {telemetry ? `${telemetry.cpuUsagePct.toFixed(0)} %` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.cpuUsage} maxHint={100} accent />
                </td>
                <td className="py-1.5 px-2">
                  {telemetry && telemetry.cpuClockMhz > 0 ? `${telemetry.cpuClockMhz} MHz` : "—"}
                </td>
                <td className="py-1.5 px-4">
                  <MiniSpark values={hist.cpuFreq} maxHint={5000} />
                </td>
              </tr>
              <tr>
                <td className="py-1.5 px-4 font-sans font-bold">GPU</td>
                <td className="py-1.5 px-2">
                  {telemetry?.gpuTempC != null ? `${telemetry.gpuTempC.toFixed(0)} °C` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.gpuTemp} maxHint={100} accent />
                </td>
                <td className="py-1.5 px-2">
                  {telemetry?.gpuPowerW != null ? `${telemetry.gpuPowerW.toFixed(1)} W` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.gpuPower} maxHint={120} />
                </td>
                <td className="py-1.5 px-2">
                  {telemetry?.gpuLoadPct != null ? `${telemetry.gpuLoadPct.toFixed(0)} %` : "—"}
                </td>
                <td className="py-1.5 px-2">
                  <MiniSpark values={hist.gpuUsage} maxHint={100} accent />
                </td>
                <td className="py-1.5 px-2 text-zinc-400">—</td>
                <td className="py-1.5 px-4 text-zinc-400">
                  {telemetry?.fanRpm != null && telemetry.fanRpm > 0 ? `${telemetry.fanRpm} RPM` : "—"}
                </td>
              </tr>
            </tbody>
          </table>

          {perCoreTemps.length > 0 && (
            <div className="px-4 py-1.5 border-t border-zinc-100 bg-[#F8FAFC] flex items-center gap-1.5 flex-wrap font-mono text-[10px] tabular-nums">
              <span className="text-zinc-500 font-bold uppercase mr-1">Per-Core:</span>
              {perCoreTemps.map((t, i) => (
                <span
                  key={i}
                  className={`px-1.5 py-0.5 rounded border ${
                    t >= 90
                      ? "bg-black border-black text-white font-bold"
                      : t >= 80
                      ? "bg-blue-50 border-blue-600 text-blue-700 font-bold"
                      : "bg-white border-zinc-200 text-black"
                  }`}
                >
                  C{i}: {t.toFixed(0)}°
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {showSensorHelp && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowSensorHelp(false)}
        >
          <div
            className="bg-white rounded-2xl border border-zinc-200 max-w-md w-full p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Zero-Defender-Warning Sensor Bridge
                </div>
                <h3 className="text-base font-bold text-black mt-0.5">
                  Unlock Full Windows Thermal &amp; Fan Sensors
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSensorHelp(false)}
                className="p-1 rounded-lg hover:bg-zinc-100 text-zinc-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-600 leading-relaxed">
              This laptop&apos;s BIOS restricts raw CPU thermal reads from standard Windows accounts. LaptopBench QC connects automatically (no WinRing0 driver bundled) as soon as either bridge is open:
            </p>

            <div className="space-y-2 text-xs">
              <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3">
                <div className="font-bold text-black">1. HWiNFO64 Shared Memory (Fastest)</div>
                <div className="text-zinc-600 mt-0.5">
                  Open HWiNFO64 → Settings → check <strong>Shared Memory Support</strong>. LaptopBench reads CPU Package °C, Per-Core °C, Fan RPM &amp; Watts in &lt;0.5ms.
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3">
                <div className="font-bold text-black">2. LibreHardwareMonitor (HTTP or WMI)</div>
                <div className="text-zinc-600 mt-0.5">
                  Open LibreHardwareMonitor as Admin (or enable <strong>Options → Remote Web Server</strong> on port <span className="font-mono">8085</span>).
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 flex items-center justify-between font-mono text-[11px]">
                <span className="text-zinc-600">PawnIO WHQL Driver:</span>
                <span className={telemetry?.pawnioInstalled ? "text-blue-700 font-bold" : "text-zinc-500"}>
                  {telemetry?.pawnioInstalled ? "Installed" : "Not Detected"}
                </span>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowSensorHelp(false)}
                className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
