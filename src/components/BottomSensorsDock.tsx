import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Activity } from "lucide-react";
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

  return (
    <div className="shrink-0 bg-white border-t border-zinc-200 select-none">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full h-8 px-4 flex items-center justify-between text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 cursor-pointer"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          <span>Sensors</span>
          {telemetry?.sensorSource && (
            <span className="text-[10px] font-mono text-zinc-400 ml-1">
              • {telemetry.sensorSource}
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
          <Activity className="w-3 h-3 text-blue-600" />
          Live Telemetry
        </span>
      </button>

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
        </div>
      )}
    </div>
  );
};
