import React from "react";
import { Award, AlertTriangle } from "lucide-react";
import type { BaselineRating } from "../types";

export const BaselineCard: React.FC<{ baseline: BaselineRating }> = ({ baseline }) => {
  const isBad =
    baseline.grade.includes("FAIL") ||
    baseline.grade.includes("POOR") ||
    baseline.grade.includes("BELOW");

  const barPct = Math.max(4, Math.min(100, Math.round(baseline.percentOfNormal)));

  return (
    <div
      className={`rounded-xl border p-4 space-y-2.5 ${
        isBad ? "border-black bg-black text-white" : "border-blue-600 bg-blue-50 text-black"
      }`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {isBad ? (
            <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
          ) : (
            <Award className="w-4 h-4 text-blue-600 shrink-0" />
          )}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider opacity-75">
              Normal Baseline Rating — {baseline.detectedClass}
            </div>
            <div className="text-sm font-black mt-0.5">
              {baseline.grade}{" "}
              {baseline.percentOfNormal > 0 && (
                <span className={isBad ? "text-blue-400 font-mono" : "text-blue-700 font-mono"}>
                  ({baseline.percentOfNormal.toFixed(0)}% of Normal)
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-right font-mono text-[11px] opacity-85">
          <div>Expected Normal:</div>
          <div className="font-bold">{baseline.expectedNormal}</div>
        </div>
      </div>

      {baseline.percentOfNormal > 0 && (
        <div className={`h-2 rounded-full overflow-hidden ${isBad ? "bg-zinc-800" : "bg-blue-200"}`}>
          <div
            className={`h-full transition-all ${isBad ? "bg-white" : "bg-blue-600"}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      )}

      <div className="text-xs opacity-90">{baseline.verdictNote}</div>
    </div>
  );
};
