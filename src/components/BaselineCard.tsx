import React from "react";
import { AlertTriangle, Award, CheckSquare } from "lucide-react";
import type { BaselineRating, UserBenchmarkComponentRating } from "../types";

export interface BaselineCardProps {
  baseline: BaselineRating;
  plainSummary?: string | null;
  userbenchmarkRating?: UserBenchmarkComponentRating | null;
  title?: string;
}

const VEHICLE_TIER_DESCRIPTIONS: Record<string, string> = {
  UFO: "Top-tier flagship speed for heavy 3D, AI, and demanding workloads.",
  "Nuclear Submarine": "High-end enthusiast class with strong multi-year headroom.",
  "Aircraft Carrier": "Upper-mid/high tier — handles heavy multitasking and creation smoothly.",
  Battleship: "Strong performance tier with solid longevity for work and gaming.",
  Cruiser: "Balanced mainstream-plus tier for daily productivity and light creation.",
  Destroyer: "Reliable everyday tier for office, browsing, and light media.",
  Speedboat: "Basic everyday laptop speed suited for office docs and web apps.",
  "Jet Ski": "Entry-level capability — best kept to light browsing and simple tasks.",
  Raft: "Severely limited or throttled — inspect cooling, power mode, or hardware health.",
};

function derivePlainBaselineSummary(baseline: BaselineRating): string {
  const pct = baseline.percentOfNormal;
  const grade = baseline.grade.toUpperCase();
  if (grade.includes("FAIL") || pct > 0 && pct < 65) {
    return "Performance is significantly below expected class levels or failed safety/integrity checks. Inspect cooling, charger/power settings, or component health before purchase.";
  }
  if (
    grade.includes("POOR") ||
    grade.includes("BELOW") ||
    grade.includes("WARNING") ||
    grade.includes("THROTTL") ||
    (pct > 0 && pct < 85)
  ) {
    return "Slightly below normal factory expectations for this hardware class. Verify AC power mode, thermal throttling, background apps, or single-channel RAM.";
  }
  if (pct >= 100) {
    return "Performing at or above factory class expectations — strong sustained health and long-term usability.";
  }
  return "Performing within normal factory expectations for this hardware class, indicating healthy day-to-day longevity.";
}

export const BaselineCard: React.FC<BaselineCardProps> = ({
  baseline,
  plainSummary,
  userbenchmarkRating,
  title,
}) => {
  const isFail = baseline.grade.includes("FAIL");
  const isWarn =
    !isFail &&
    (baseline.grade.includes("POOR") ||
      baseline.grade.includes("BELOW") ||
      baseline.grade.includes("WARNING") ||
      baseline.grade.includes("THROTTL"));

  const barPct = Math.max(2, Math.min(100, Math.round((baseline.percentOfNormal / 120) * 100)));
  const resolvedPlainSummary =
    (plainSummary && plainSummary.trim()) ||
    (userbenchmarkRating?.plainSummary && userbenchmarkRating.plainSummary.trim()) ||
    derivePlainBaselineSummary(baseline);

  const tierDescription = userbenchmarkRating
    ? VEHICLE_TIER_DESCRIPTIONS[userbenchmarkRating.vehicleTier] ??
      "Calibrated UserBenchmark-style hardware speed tier."
    : "";

  const isStandingBad =
    userbenchmarkRating?.standingLabel === "Underperforming" ||
    userbenchmarkRating?.standingLabel === "Below Expectations";

  const sourceLabel =
    userbenchmarkRating?.sourceMode === "live_verified" ? "Live Verified" : "Offline Calibrated";

  return (
    <div
      className={`rounded-[2px] border border-l-[3px] p-4 space-y-3 ${
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
              CALIBRATION BASELINE // {title ? `${title} // ` : ""}
              {baseline.detectedClass}
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

      {/* What This Means for Long-Term Use — Plain-Language Buyer Callout */}
      <div
        className={`rounded-[2px] border px-3 py-2 text-xs space-y-0.5 ${
          isFail
            ? "border-zinc-700 bg-zinc-900 text-zinc-100"
            : "border-zinc-200 bg-[#F8FAFC] text-black"
        }`}
      >
        <div
          className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] ${
            isFail ? "text-blue-400" : "text-blue-700"
          }`}
        >
          What This Means for Long-Term Use
        </div>
        <div className="leading-relaxed">{resolvedPlainSummary}</div>
      </div>

      {/* UserBenchmark Calibration Sub-Panel */}
      {userbenchmarkRating && (
        <div
          className={`rounded-[2px] border p-3 space-y-2.5 ${
            isFail
              ? "border-zinc-700 bg-zinc-900 text-white"
              : "border-zinc-300 bg-white text-black"
          }`}
        >
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="space-y-0.5">
              <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] flex items-center gap-1.5 opacity-80">
                <Award className={`w-3.5 h-3.5 ${isFail ? "text-blue-400" : "text-blue-600"}`} />
                USERBENCHMARK CALIBRATION // {userbenchmarkRating.detectedModel}
              </div>
              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                <span className="px-2 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-[11px] font-black uppercase tracking-wider">
                  {userbenchmarkRating.vehicleTier}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-[2px] border font-mono text-[10.5px] font-bold ${
                    userbenchmarkRating.standingLabel === "Underperforming"
                      ? "bg-black text-white border-black"
                      : isStandingBad
                      ? "bg-white text-black border-black"
                      : "bg-blue-50/40 text-blue-700 border-blue-600"
                  }`}
                >
                  {userbenchmarkRating.standingLabel}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-[2px] border font-mono text-[9.5px] font-bold uppercase ${
                    isFail
                      ? "border-zinc-600 text-zinc-300"
                      : "border-zinc-300 bg-[#F8FAFC] text-zinc-700"
                  }`}
                >
                  {sourceLabel}
                </span>
              </div>
              <div className={`text-[11px] pt-0.5 ${isFail ? "text-zinc-300" : "text-zinc-600"}`}>
                {tierDescription}
              </div>
            </div>

            <div className="text-right font-mono tabular-nums text-[11px] shrink-0">
              <div className="text-[9.5px] uppercase opacity-70">Effective vs Class</div>
              <div className="font-black text-sm">
                <span className={isFail ? "text-blue-400" : "text-blue-700"}>
                  {userbenchmarkRating.effectiveSpeedPct.toFixed(1)}%
                </span>{" "}
                <span className="opacity-65 font-normal">
                  / {userbenchmarkRating.expectedClassPct.toFixed(1)}%
                </span>
              </div>
              <div className="text-[10px] font-bold opacity-80">
                {userbenchmarkRating.relativeStandingPct.toFixed(0)}% of class
              </div>
            </div>
          </div>

          {userbenchmarkRating.bottleneckFlag && (
            <div className="rounded-[2px] border border-black bg-black text-white px-2.5 py-1.5 font-mono text-[11px] flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>BOTTLENECK ALERT: {userbenchmarkRating.bottleneckFlag}</span>
            </div>
          )}

          {(userbenchmarkRating.subMetrics?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(userbenchmarkRating.subMetrics ?? []).map(([k, v]) => (
                <span
                  key={`${k}-${v}`}
                  className={`px-2 py-0.5 rounded-[2px] border font-mono text-[10px] tabular-nums ${
                    isFail
                      ? "border-zinc-700 bg-black text-zinc-200"
                      : "border-zinc-200 bg-[#F8FAFC] text-black"
                  }`}
                >
                  <span className="opacity-65">{k}:</span> <strong>{v}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
