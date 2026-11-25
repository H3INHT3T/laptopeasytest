import React from "react";

interface LiveChartProps {
  title: string;
  unit: string;
  data: number[];
  maxSuggested?: number;
  baselineValue?: number;
  baselineLabel?: string;
  height?: number;
}

export const LiveChart: React.FC<LiveChartProps> = ({
  title,
  unit,
  data,
  maxSuggested,
  baselineValue,
  baselineLabel,
  height = 104,
}) => {
  const latest = data.length > 0 ? data[data.length - 1] : 0;
  const minVal = data.length > 0 ? Math.min(...data) : 0;
  const peakVal = data.length > 0 ? Math.max(...data) : 0;
  const avgVal = data.length > 0 ? data.reduce((a, b) => a + b, 0) / data.length : 0;

  // Stability % = 100 - Coefficient of Variation (%)
  let stabilityPct = 100;
  if (data.length >= 3 && avgVal > 0.001) {
    const variance = data.reduce((s, v) => s + (v - avgVal) * (v - avgVal), 0) / data.length;
    const stdDev = Math.sqrt(variance);
    stabilityPct = Math.max(0, Math.min(100, 100 - (stdDev / avgVal) * 100));
  }

  // P95 (high-percentile or low-5% depending on metric)
  const sorted = [...data].sort((a, b) => a - b);
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;

  const maxAxis = Math.max(maxSuggested ?? 1, peakVal * 1.12, (baselineValue ?? 0) * 1.18, 1);
  const w = 520;
  const h = height;

  const yOf = (val: number) => h - 8 - (Math.max(0, val) / maxAxis) * (h - 18);

  const points =
    data.length > 1
      ? data
          .map((v, i) => {
            const x = (i / Math.max(data.length - 1, 1)) * w;
            return `${x.toFixed(1)},${yOf(v).toFixed(1)}`;
          })
          .join(" ")
      : `0,${h - 8} ${w},${h - 8}`;

  const areaPoints = `0,${h} ${points} ${w},${h}`;
  const baseY = baselineValue != null && baselineValue > 0 ? yOf(baselineValue) : null;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      {/* Instrument Oscilloscope Header */}
      <div className="px-3 py-1.5 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between gap-2 font-mono tabular-nums text-[10px]">
        <span className="font-bold text-black uppercase tracking-wider truncate">{title}</span>
        <span className="font-black text-blue-700 text-xs shrink-0">
          {latest.toFixed(1)} {unit}
        </span>
      </div>

      {/* SVG Oscilloscope Grid */}
      <div className="p-2 bg-white">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full overflow-hidden border border-zinc-200 bg-[#FCFCFD]"
          style={{ height }}
        >
          {/* Horizontal & Vertical Hairline Graticule */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={`h-${f}`} x1="0" y1={h * f} x2={w} y2={h * f} stroke="#e4e4e7" strokeWidth="1" />
          ))}
          {[0.2, 0.4, 0.6, 0.8].map((f) => (
            <line key={`v-${f}`} x1={w * f} y1="0" x2={w * f} y2={h} stroke="#f4f4f5" strokeWidth="1" />
          ))}

          {/* Normal Baseline Reference Line */}
          {baseY != null && (
            <>
              <line
                x1="0"
                y1={baseY}
                x2={w}
                y2={baseY}
                stroke="#09090b"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
              <text
                x={w - 4}
                y={Math.max(10, baseY - 3)}
                textAnchor="end"
                fill="#09090b"
                fontSize="8.5"
                fontFamily="monospace"
                fontWeight="bold"
              >
                {baselineLabel ?? `NORMAL ${baselineValue?.toFixed(0)} ${unit}`}
              </text>
            </>
          )}

          {/* Waveform Fill & Trace */}
          <polygon points={areaPoints} fill="rgba(37,99,235,0.09)" />
          <polyline fill="none" stroke="#2563eb" strokeWidth="1.8" points={points} />
        </svg>
      </div>

      {/* Precision Statistical Footer */}
      <div className="grid grid-cols-5 divide-x divide-zinc-200 border-t border-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-[9.5px] text-center">
        <div className="py-1 px-1">
          <span className="text-zinc-500">MIN </span>
          <strong className="text-black">{minVal.toFixed(1)}</strong>
        </div>
        <div className="py-1 px-1">
          <span className="text-zinc-500">AVG </span>
          <strong className="text-black">{avgVal.toFixed(1)}</strong>
        </div>
        <div className="py-1 px-1">
          <span className="text-zinc-500">P95 </span>
          <strong className="text-black">{p95.toFixed(1)}</strong>
        </div>
        <div className="py-1 px-1">
          <span className="text-zinc-500">PEAK </span>
          <strong className="text-blue-700">{peakVal.toFixed(1)}</strong>
        </div>
        <div className="py-1 px-1">
          <span className="text-zinc-500">STAB </span>
          <strong className="text-black">{stabilityPct.toFixed(0)}%</strong>
        </div>
      </div>
    </div>
  );
};
