import React, { useState } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";

interface TechnicalDetailsDrawerProps {
  title?: string;
  subtitle?: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const TechnicalDetailsDrawer: React.FC<TechnicalDetailsDrawerProps> = ({
  title = "Technical Details",
  subtitle,
  summary,
  defaultOpen = false,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const subText = subtitle ?? summary;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8FAFC] transition cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown className="w-4 h-4 text-blue-600 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0" />
          )}
          <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <span className="text-xs font-bold text-black">{title}</span>
          {subText && (
            <span className="text-xs text-zinc-500 truncate hidden sm:inline">
              — {subText}
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] font-semibold text-blue-700 shrink-0">
          {open ? "Hide" : "Expand"}
        </span>
      </button>

      {open && (
        <div className="p-4 pt-3 border-t border-zinc-200 bg-[#FAFAFA] space-y-4">
          {children}
        </div>
      )}
    </div>
  );
};
