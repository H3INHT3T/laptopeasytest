import React from "react";
import { ArrowRight, CheckCircle2, Lock, SkipForward } from "lucide-react";
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
    <div className="mt-6 rounded-xl border border-zinc-200 bg-white px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full bg-[#F8FAFC] border border-zinc-200 text-black font-mono text-[11px] font-bold shrink-0">
          Step {stepStr}/{totalStr}
        </span>
        <div className="text-xs text-zinc-600 truncate">
          {isDone ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-blue-700">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              Recorded [{status}] • Ready for Step {String(Math.min(stepNumber + 1, totalSteps)).padStart(2, "0")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-zinc-600">
              <Lock className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
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
            className="px-3.5 py-2 rounded-lg border border-zinc-300 bg-white hover:border-black text-black font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Skip Step
          </button>
        )}
        <button
          type="button"
          disabled={!isDone}
          onClick={onNext}
          className={`px-4 py-2 rounded-lg font-semibold text-xs flex items-center gap-1.5 transition ${
            isDone
              ? "bg-blue-600 hover:bg-blue-700 text-white shadow-2xs cursor-pointer"
              : "bg-zinc-100 text-zinc-400 cursor-not-allowed"
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
