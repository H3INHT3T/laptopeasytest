import React from "react";
import { Cpu, HardDrive, Laptop, MemoryStick, Monitor, RefreshCw, ShieldAlert } from "lucide-react";
import type { SystemSpecs, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface SpecsViewProps {
  specs: SystemSpecs | null;
  loading: boolean;
  status: TestStatus;
  onRefresh: () => void;
  onNext?: () => void;
}

export const SpecsView: React.FC<SpecsViewProps> = ({
  specs,
  loading,
  status,
  onRefresh,
  onNext,
}) => {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">System Specification Details</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Verify exact CPU, RAM DIMM slots, GPU(s), NVMe/SATA storage, display panel, and serial number.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Re-scan Specs
          </button>
          {onNext && (
            <button
              onClick={onNext}
              className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
            >
              Next Test →
            </button>
          )}
        </div>
      </div>

      {!specs ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400">
          {loading ? "Scanning laptop hardware specifications..." : "Click Re-scan Specs to collect hardware telemetry."}
        </div>
      ) : (
        <>
          {!specs.isElevated && specs.osFamily === "windows" && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-center gap-3 text-xs text-amber-200">
              <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Running without Windows Administrator elevation. Release builds request UAC elevation automatically for full NVMe SMART, BitLocker, and System Event Logs.
              </span>
            </div>
          )}

          {/* Core Identity */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400 uppercase tracking-wider">
                <Laptop className="w-4 h-4" /> System Identity
              </div>
              <div className="text-base font-bold text-white">
                {specs.manufacturer} {specs.model}
              </div>
              <div className="text-xs text-slate-400 space-y-1 font-mono">
                <div>Serial: <span className="text-slate-200">{specs.serialNumber}</span></div>
                <div>BIOS/FW: <span className="text-slate-200">{specs.biosVersion}</span></div>
                <div>OS: <span className="text-slate-200">{specs.osName} ({specs.architecture})</span></div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                <Cpu className="w-4 h-4" /> Processor (CPU)
              </div>
              <div className="text-base font-bold text-white">{specs.cpuBrand}</div>
              <div className="text-xs text-slate-400 space-y-1 font-mono">
                <div>
                  Cores: <span className="text-slate-200">{specs.cpuPhysicalCores} Physical / {specs.cpuLogicalCores} Logical</span>
                </div>
                <div>Base Clock: <span className="text-slate-200">{specs.cpuBaseMhz} MHz</span></div>
                <div>
                  Profile:{" "}
                  <span className={specs.isGamingCapable ? "text-orange-300 font-bold" : "text-cyan-300"}>
                    {specs.isGamingCapable ? "Gaming / Pro Discrete GPU" : "Office / Standard Notebook"}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-violet-400 uppercase tracking-wider">
                <MemoryStick className="w-4 h-4" /> Memory Summary
              </div>
              <div className="text-base font-bold text-white">{specs.totalRamGb.toFixed(1)} GB Total</div>
              <div className="text-xs text-slate-400 space-y-1">
                {specs.ramModules.length > 0 ? (
                  specs.ramModules.map((m, i) => (
                    <div key={i} className="font-mono text-slate-200">
                      {m.slot}: {m.capacityGb} GB {m.memoryType}
                      {m.speedMhz ? ` @ ${m.speedMhz} MHz` : ""} ({m.manufacturer})
                    </div>
                  ))
                ) : (
                  <div>Unified / Integrated Memory</div>
                )}
              </div>
            </div>
          </div>

          {/* GPUs, Disks, Displays */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-orange-400 uppercase tracking-wider">
                <Monitor className="w-4 h-4" /> Graphics Adapters &amp; Displays
              </div>
              <div className="space-y-2">
                {specs.gpus.map((g, idx) => (
                  <div key={idx} className="rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-white">{g.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          g.isDiscrete
                            ? "bg-orange-500/20 text-orange-300 border border-orange-500/40"
                            : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {g.isDiscrete ? "DISCRETE / PRO" : "INTEGRATED"}
                      </span>
                    </div>
                    <div className="text-slate-400 mt-1 font-mono">
                      Vendor: {g.vendor}
                      {g.vramMb ? ` • VRAM: ${g.vramMb} MB` : ""}
                      {g.driverVersion ? ` • Driver: ${g.driverVersion}` : ""}
                    </div>
                  </div>
                ))}
              </div>
              {specs.displays.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-1.5">
                  <div className="text-[11px] text-slate-400 font-semibold">Detected Panels</div>
                  {specs.displays.map((d, i) => (
                    <div key={i} className="text-xs text-slate-200 flex justify-between font-mono">
                      <span className="truncate">{d.name}</span>
                      <span className="text-cyan-300 shrink-0">
                        {d.resolution}
                        {d.refreshRateHz ? ` @ ${d.refreshRateHz}Hz` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-400 uppercase tracking-wider">
                <HardDrive className="w-4 h-4" /> Installed Storage Drives
              </div>
              <div className="space-y-2">
                {specs.disks.length === 0 ? (
                  <div className="text-xs text-slate-400">No physical disks enumerated.</div>
                ) : (
                  specs.disks.map((d, idx) => (
                    <div key={idx} className="rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-white">{d.model}</span>
                        <span className="font-mono text-cyan-300">{d.sizeGb.toFixed(0)} GB</span>
                      </div>
                      <div className="text-slate-400 mt-1 font-mono">
                        {d.interfaceType} • {d.mediaType}
                        {d.serialNumber ? ` • S/N: ${d.serialNumber}` : ""}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
