import React from "react";
import { AlertTriangle, CheckSquare } from "lucide-react";
import type { BaselineRating } from "../types";

export const BaselineCard: React.FC<{ baseline: BaselineRating }> = ({ baseline }) => {
  const isFail = baseline.grade.includes("FAIL");
  const isWarn =
    !isFail &&
    (baseline.grade.includes("POOR") ||
      baseline.grade.includes("BELOW") ||
      baseline.grade.includes("WARNING") ||
      baseline.grade.includes("THROTTL"));

  const barPct = Math.max(2, Math.min(100, Math.round((baseline.percentOfNormal / 120) * 100)));

  return (
    <div
      className={`rounded-[2px] border border-l-[3px] p-4 space-y-2.5 ${
        isFail
          ? "border-black border-l-black bg-black text-white"
          : isWarn
          ? "border-zinc-300 border-l-black bg-white text-black"
          : "border-zinc-300 border-l-blue-600 bg-white text-black"
      }`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-2.5">
          {isFail || isWarn ? (
            <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${isFail ? "text-blue-400" : "text-black"}`} />
          ) : (
            <CheckSquare className="w-4 h-4 mt-0.5 text-blue-600 shrink-0" />
          )}
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">
              CALIBRATION BASELINE // {baseline.detectedClass}
            </div>
            <div className="text-sm font-black tracking-tight mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{baseline.grade}</span>
              {baseline.percentOfNormal > 0 && (
                <span
                  className={`font-mono text-xs px-1.5 py-0.5 rounded-[2px] tabular-nums ${
                    isFail
                      ? "bg-white text-black"
                      : isWarn
                      ? "bg-zinc-100 border border-black text-black"
                      : "bg-blue-600 text-white"
                  }`}
                >
                  {baseline.percentOfNormal.toFixed(1)}% OF NORMAL
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-right font-mono text-[11px] tabular-nums">
          <div className="text-[9.5px] uppercase tracking-wider opacity-65">Reference Range</div>
          <div className="font-bold">{baseline.expectedNormal}</div>
        </div>
      </div>

      {/* Calibrated Tick Ruler (85% Normal threshold marker) */}
      {baseline.percentOfNormal > 0 && (
        <div className="relative pt-1">
          <div className={`h-2 overflow-hidden relative ${isFail ? "bg-zinc-800" : "bg-zinc-200"}`}>
            <div
              className={`h-full transition-all ${isFail ? "bg-white" : isWarn ? "bg-black" : "bg-blue-600"}`}
              style={{ width: `${barPct}%` }}
            />
            {/* 85% Normal Threshold Tick */}
            <div
              className={`absolute top-0 bottom-0 w-[1.5px] ${isFail ? "bg-blue-400" : "bg-black"}`}
              style={{ left: "71%" }}
              title="85% Minimum Normal Threshold"
            />
          </div>
          <div className="flex justify-between font-mono text-[9px] opacity-60 mt-0.5 tabular-nums">
            <span>0%</span>
            <span>60%</span>
            <span>85% NORMAL</span>
            <span>100%</span>
            <span>120%+</span>
          </div>
        </div>
      )}

      <div className="text-xs opacity-90">{baseline.verdictNote}</div>
    </div>
  );
};
