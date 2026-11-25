import React from "react";
import { ArrowRight, Lock, SkipForward } from "lucide-react";
import type { TestStatus } from "../types";

interface StepActionBarProps {
  stepNumber: number;
  totalSteps: number;
  status: TestStatus;
  canProceed: boolean;
  requirementHint: string;
  nextLabel?: string;
  onNext: () => void;
  onSkip: () => void;
}

export const StepActionBar: React.FC<StepActionBarProps> = ({
  stepNumber,
  totalSteps,
  status,
  canProceed,
  requirementHint,
  nextLabel,
  onNext,
  onSkip,
}) => {
  const isDone =
    canProceed ||
    status === "pass" ||
    status === "warn" ||
    status === "fail" ||
    status === "notApplicable" ||
    status === "skipped";

  const stepStr = String(stepNumber).padStart(2, "0");
  const totalStr = String(totalSteps).padStart(2, "0");

  return (
    <div className="mt-6 rounded-[2px] border border-zinc-300 bg-white px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center justify-center px-2 py-1 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold tracking-wider shrink-0">
          STAGE {stepStr}/{totalStr}
        </span>
        <div className="text-xs text-zinc-700 truncate">
          {isDone ? (
            <span className="font-mono text-[11px] font-bold text-blue-700 uppercase">
              RECORDED [{status}] — READY FOR STAGE {String(Math.min(stepNumber + 1, totalSteps)).padStart(2, "0")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-zinc-600 text-xs">
              <Lock className="w-3.5 h-3.5 text-black shrink-0" />
              {requirementHint}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!isDone && (
          <button
            type="button"
            onClick={onSkip}
            className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-black font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition cursor-pointer"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Skip Step
          </button>
        )}
        <button
          type="button"
          disabled={!isDone}
          onClick={onNext}
          className={`px-4 py-1.5 rounded-[2px] font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition border ${
            isDone
              ? "bg-blue-600 hover:bg-blue-700 border-blue-600 text-white cursor-pointer"
              : "bg-zinc-100 border-zinc-300 text-zinc-400 cursor-not-allowed"
          }`}
        >
          {nextLabel ??
            (stepNumber < totalSteps
              ? `Next: Stage ${String(stepNumber + 1).padStart(2, "0")}`
              : "Issue QC Certificate")}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
