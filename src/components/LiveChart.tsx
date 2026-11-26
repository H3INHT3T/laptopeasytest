import React from "react";

interface LiveChartProps {
  title: string;
  unit: string;
  data: number[];
  maxSuggested?: number;
  baselineValue?: number;
  baselineLabel?: string;
  height?: number;
  plainHint?: string;
  higherIsBetter?: boolean;
}

export const LiveChart: React.FC<LiveChartProps> = ({
  title,
  unit,
  data,
  maxSuggested,
  baselineValue,
  baselineLabel,
  height = 104,
  plainHint,
  higherIsBetter = true,
}) => {
  const finiteData = data.filter((v) => Number.isFinite(v));
  const hasData = finiteData.length > 0;
  const latest = hasData ? finiteData[finiteData.length - 1] : 0;
  const minVal = hasData ? Math.min(...finiteData) : 0;
  const peakVal = hasData ? Math.max(...finiteData) : 0;
  const avgVal = hasData ? finiteData.reduce((a, b) => a + b, 0) / finiteData.length : 0;

  // Stability % = 100 - Coefficient of Variation (%)
  let stabilityPct = 100;
  if (finiteData.length >= 3 && avgVal > 0.001) {
    const variance =
      finiteData.reduce((s, v) => s + (v - avgVal) * (v - avgVal), 0) / finiteData.length;
    const stdDev = Math.sqrt(variance);
    stabilityPct = Math.max(0, Math.min(100, 100 - (stdDev / avgVal) * 100));
  }

  const stabilityLabel =
    !hasData
      ? "Waiting"
      : stabilityPct >= 90
      ? "Steady"
      : stabilityPct >= 75
      ? "Moderate Variance"
      : "Fluctuating";

  // P95 (high-percentile or low-5% depending on metric)
  const sorted = [...finiteData].sort((a, b) => a - b);
  const p95 =
    sorted.length > 0
      ? sorted[
          higherIsBetter
            ? Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
            : Math.max(0, Math.floor(sorted.length * 0.05))
        ]
      : 0;

  const maxAxis = Math.max(maxSuggested ?? 1, peakVal * 1.12, (baselineValue ?? 0) * 1.18, 1);
  const w = 520;
  const h = height;

  const yOf = (val: number) => h - 8 - (Math.max(0, val) / maxAxis) * (h - 18);

  const singleY = finiteData.length === 1 ? yOf(finiteData[0]) : h - 8;
  const points =
    finiteData.length > 1
      ? finiteData
          .map((v, i) => {
            const x = (i / Math.max(finiteData.length - 1, 1)) * w;
            return `${x.toFixed(1)},${yOf(v).toFixed(1)}`;
          })
          .join(" ")
      : finiteData.length === 1
      ? `0,${singleY.toFixed(1)} ${w},${singleY.toFixed(1)}`
      : "";

  const areaPoints = hasData ? `0,${h} ${points} ${w},${h}` : "";
  const baseY = baselineValue != null && baselineValue > 0 ? yOf(baselineValue) : null;

  return (
    <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
      {/* Instrument Oscilloscope Header */}
      <div className="px-3 py-1.5 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between gap-2 font-mono tabular-nums text-[10px]">
        <div className="min-w-0">
          <span className="font-bold text-black uppercase tracking-wider truncate block">
            {title}
          </span>
          {plainHint && (
            <span className="font-sans text-[10px] text-zinc-600 block truncate">
              {plainHint}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasData && (
            <span
              className={`px-1.5 py-0.5 rounded-[2px] border text-[9px] font-bold uppercase ${
                stabilityPct >= 90
                  ? "border-blue-600 bg-white text-blue-700"
                  : stabilityPct >= 75
                  ? "border-zinc-300 bg-white text-black"
                  : "border-black bg-black text-white"
              }`}
              title="Signal stability based on sample-to-sample variance"
            >
              {stabilityLabel}
            </span>
          )}
          <span className="font-black text-blue-700 text-xs">
            {hasData ? `${latest.toFixed(1)} ${unit}` : "—"}
          </span>
        </div>
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

          {hasData ? (
            <>
              {/* Waveform Fill & Trace */}
              <polygon points={areaPoints} fill="rgba(37,99,235,0.09)" />
              <polyline fill="none" stroke="#2563eb" strokeWidth="1.8" points={points} />
              {finiteData.length === 1 && (
                <circle cx={w - 6} cy={singleY} r="3.5" fill="#2563eb" stroke="#09090b" strokeWidth="1" />
              )}
            </>
          ) : (
            <text
              x={w / 2}
              y={h / 2 + 3}
              textAnchor="middle"
              fill="#09090b"
              fontSize="11"
              fontFamily="monospace"
              opacity="0.55"
            >
              Waiting for telemetry samples...
            </text>
          )}
        </svg>
      </div>

      {/* Precision Statistical Footer */}
      <div className="grid grid-cols-5 divide-x divide-zinc-200 border-t border-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-[9.5px] text-center">
        <div className="py-1 px-1" title="Lowest reading recorded during this run">
          <span className="text-zinc-500">MIN </span>
          <strong className="text-black">{hasData ? minVal.toFixed(1) : "—"}</strong>
        </div>
        <div className="py-1 px-1" title="Average reading across all captured samples">
          <span className="text-zinc-500">AVG </span>
          <strong className="text-black">{hasData ? avgVal.toFixed(1) : "—"}</strong>
        </div>
        <div
          className="py-1 px-1"
          title={
            higherIsBetter
              ? "95th percentile reading (top sustained performance)"
              : "5th percentile reading (low-tail stability floor)"
          }
        >
          <span className="text-zinc-500">{higherIsBetter ? "P95 " : "P05 "}</span>
          <strong className="text-black">{hasData ? p95.toFixed(1) : "—"}</strong>
        </div>
        <div className="py-1 px-1" title="Highest reading recorded during this run">
          <span className="text-zinc-500">PEAK </span>
          <strong className="text-blue-700">{hasData ? peakVal.toFixed(1) : "—"}</strong>
        </div>
        <div
          className="py-1 px-1"
          title="Consistency score (Steady >= 90%, Moderate Variance 75-89%, Fluctuating < 75%)"
        >
          <span className="text-zinc-500">STAB </span>
          <strong className="text-black">
            {hasData ? `${stabilityPct.toFixed(0)}% (${stabilityLabel})` : "—"}
          </strong>
        </div>
      </div>
    </div>
  );
};
