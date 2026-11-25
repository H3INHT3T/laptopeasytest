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

  return (
    <div className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-md bg-black text-white font-mono text-xs font-bold">
          STEP {stepNumber} / {totalSteps}
        </span>
        <div className="text-xs text-zinc-700">
          {isDone ? (
            <span className="font-semibold text-blue-700">
              Step recorded ({status.toUpperCase()}) — ready to proceed to Step {Math.min(stepNumber + 1, totalSteps)}.
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-zinc-600">
              <Lock className="w-3.5 h-3.5 text-black shrink-0" />
              {requirementHint}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        {!isDone && (
          <button
            type="button"
            onClick={onSkip}
            className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Skip Step
          </button>
        )}
        <button
          type="button"
          disabled={!isDone}
          onClick={onNext}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
            isDone
              ? "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer shadow-sm"
              : "bg-zinc-200 text-zinc-500 cursor-not-allowed"
          }`}
        >
          {nextLabel ?? (stepNumber < totalSteps ? `Next: Step ${stepNumber + 1}` : "Open Final QC Report")}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
