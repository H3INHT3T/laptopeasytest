import React from "react";
import type { TestStatus } from "../types";

export const StatusBadge: React.FC<{ status: TestStatus; compact?: boolean; darkSurface?: boolean }> = ({
  status,
  compact = false,
  darkSurface = false,
}) => {
  const map: Record<TestStatus, { label: string; cls: string }> = {
    pass: {
      label: "PASS",
      cls: "bg-blue-600 text-white border-blue-600",
    },
    warn: {
      label: "WARN",
      cls: darkSurface
        ? "bg-transparent text-blue-300 border-blue-400"
        : "bg-blue-50 text-blue-700 border-blue-300",
    },
    fail: {
      label: "FAIL",
      cls: darkSurface
        ? "bg-white text-black border-white font-black"
        : "bg-black text-white border-black font-black",
    },
    running: {
      label: "RUN",
      cls: darkSurface
        ? "bg-blue-600/30 text-blue-200 border-blue-400 animate-pulse"
        : "bg-blue-50 text-blue-700 border-blue-500 animate-pulse",
    },
    skipped: {
      label: "SKIP",
      cls: darkSurface
        ? "bg-transparent text-zinc-300 border-dashed border-zinc-500"
        : "bg-white text-zinc-600 border-dashed border-zinc-300",
    },
    notApplicable: {
      label: "N/A",
      cls: darkSurface
        ? "bg-zinc-900 text-zinc-400 border-zinc-700"
        : "bg-zinc-100 text-zinc-500 border-zinc-200",
    },
    pending: {
      label: "WAIT",
      cls: darkSurface
        ? "bg-zinc-900 text-zinc-500 border-zinc-800"
        : "bg-white text-zinc-400 border-zinc-200",
    },
  };

  const item = map[status];
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border font-mono font-bold tracking-wider uppercase ${
        compact ? "px-1.5 py-[1px] text-[9px]" : "px-2.5 py-0.5 text-[10px]"
      } ${item.cls}`}
    >
      {item.label}
    </span>
  );
};
