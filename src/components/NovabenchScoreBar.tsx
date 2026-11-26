import React from "react";

interface NovabenchScoreBarProps {
  scoreLabel: string;
  scoreValue: string;
  title: string;
  takeaway: string;
  percent: number;
  medianLabel?: string;
  medianPercent?: number;
  badge?: string;
  monochrome?: boolean;
}

export const NovabenchScoreBar: React.FC<NovabenchScoreBarProps> = ({
  scoreLabel,
  scoreValue,
  title,
  takeaway,
  percent,
  medianLabel = "Class Median",
  medianPercent = 70,
  badge,
  monochrome = false,
}) => {
  const clamped = Math.max(4, Math.min(100, Math.round(percent)));
  const clampedMed = Math.max(4, Math.min(100, Math.round(medianPercent)));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3.5 min-w-0">
          <div
            className={`px-4 py-2 rounded-full font-mono text-base font-bold shrink-0 ${
              monochrome ? "bg-black text-white" : "bg-blue-600 text-white"
            }`}
          >
            {scoreValue}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-black tracking-tight">{title}</h2>
              {badge && (
                <span className="px-2 py-0.5 rounded-full border border-zinc-200 bg-[#F8FAFC] font-mono text-[10px] font-bold text-zinc-700">
                  {badge}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-600 mt-0.5">{takeaway}</p>
          </div>
        </div>
        <span className="font-mono text-[11px] font-semibold text-zinc-400 uppercase shrink-0">
          {scoreLabel}
        </span>
      </div>

      <div className="space-y-2.5 pt-1">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-black">This Laptop</span>
            <span className="font-mono font-bold text-black">{clamped}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-zinc-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                monochrome ? "bg-black" : "bg-blue-600"
              }`}
              style={{ width: `${clamped}%` }}
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">{medianLabel}</span>
            <span className="font-mono text-zinc-500">{clampedMed}%</span>
          </div>
          <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-zinc-400"
              style={{ width: `${clampedMed}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
