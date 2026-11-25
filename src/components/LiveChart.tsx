import React from "react";

interface LiveChartProps {
  title: string;
  unit: string;
  data: number[];
  maxSuggested?: number;
  height?: number;
}

export const LiveChart: React.FC<LiveChartProps> = ({
  title,
  unit,
  data,
  maxSuggested,
  height = 84,
}) => {
  const latest = data.length > 0 ? data[data.length - 1] : 0;
  const maxVal = Math.max(maxSuggested ?? 1, ...data, 1);
  const w = 480;
  const h = height;

  const points =
    data.length > 1
      ? data
          .map((v, i) => {
            const x = (i / Math.max(data.length - 1, 1)) * w;
            const y = h - 6 - (Math.max(0, v) / maxVal) * (h - 14);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : `0,${h - 6} ${w},${h - 6}`;

  const areaPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 space-y-1.5">
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="font-bold text-zinc-600 uppercase tracking-wider">{title}</span>
        <span className="font-black text-blue-600">
          {latest.toFixed(1)} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full overflow-hidden rounded bg-zinc-50 border border-zinc-100" style={{ height }}>
        <line x1="0" y1={h * 0.25} x2={w} y2={h * 0.25} stroke="#e4e4e7" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke="#e4e4e7" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.75} x2={w} y2={h * 0.75} stroke="#e4e4e7" strokeDasharray="3 3" />
        <polygon points={areaPoints} fill="rgba(37,99,235,0.12)" />
        <polyline fill="none" stroke="#2563eb" strokeWidth="2.2" points={points} />
      </svg>
    </div>
  );
};
