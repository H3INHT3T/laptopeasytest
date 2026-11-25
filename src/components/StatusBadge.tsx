import React from "react";
import type { TestStatus } from "../types";

export const StatusBadge: React.FC<{ status: TestStatus; compact?: boolean }> = ({
  status,
  compact = false,
}) => {
  const map: Record<TestStatus, { label: string; cls: string }> = {
    pass: {
      label: "PASS",
      cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    },
    warn: {
      label: "WARN",
      cls: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    },
    fail: {
      label: "FAIL",
      cls: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    },
    running: {
      label: "RUN",
      cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 animate-pulse",
    },
    notApplicable: {
      label: "N/A",
      cls: "bg-slate-600/25 text-slate-400 border-slate-600/40",
    },
    pending: {
      label: "PENDING",
      cls: "bg-slate-800 text-slate-400 border-slate-700",
    },
  };

  const item = map[status];
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border font-semibold tracking-wider ${
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs"
      } ${item.cls}`}
    >
      {item.label}
    </span>
  );
};
