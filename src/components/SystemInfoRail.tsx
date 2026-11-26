import React from "react";
import {
  Battery,
  Cpu,
  HardDrive,
  Info,
  MemoryStick,
  Monitor,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import type {
  BatteryHealthReport,
  SecurityAuditReport,
  SystemSpecs,
} from "../types";

interface SystemInfoRailProps {
  specs: SystemSpecs | null;
  battery: BatteryHealthReport | null;
  security: SecurityAuditReport | null;
}

export const SystemInfoRail: React.FC<SystemInfoRailProps> = ({
  specs,
  battery,
  security,
}) => {
  const primaryGpu = specs?.gpus.find((g) => g.isDiscrete) ?? specs?.gpus[0] ?? null;
  const primaryDisk = specs?.disks[0] ?? null;
  const primaryDisplay = specs?.displays[0] ?? null;
  const ramType = specs?.ramModules[0]?.memoryType || "RAM";
  const ramSpeed = specs?.ramModules[0]?.speedMhz;

  const biosText =
    security?.biosLocked === true || security?.biosLockStatus === "LOCKED"
      ? "BIOS: Locked"
      : security?.biosLocked === false || security?.biosLockStatus === "UNLOCKED"
      ? "BIOS: Unlocked"
      : security
      ? "BIOS: Check in Setup"
      : "Scanning...";

  const mdmText =
    security?.mdmEnrolled === true
      ? "MDM Enrolled"
      : security?.mdmEnrolled === false
      ? "MDM Clean"
      : "Pending";

  return (
    <aside className="hidden xl:flex w-56 shrink-0 bg-white border-l border-zinc-200 flex-col h-full select-none">
      <div className="h-11 px-4 border-b border-zinc-200 flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
        <span>System Info</span>
        <Info className="w-3.5 h-3.5 text-zinc-400" />
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
        {/* CPU */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <Cpu className="w-4 h-4 text-blue-600 shrink-0" />
            <span>CPU</span>
          </div>
          <div className="text-zinc-900 font-medium leading-snug">
            {specs?.cpuBrand || "Detecting processor..."}
          </div>
          {specs && (
            <div className="text-[11px] text-zinc-500 font-mono">
              {specs.cpuPhysicalCores}C / {specs.cpuLogicalCores}T • {(specs.cpuBaseMhz / 1000).toFixed(2)} GHz
            </div>
          )}
        </div>

        {/* GPU */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <Monitor className="w-4 h-4 text-blue-600 shrink-0" />
            <span>GPU</span>
          </div>
          <div className="text-zinc-900 font-medium leading-snug">
            {primaryGpu?.name || "Detecting graphics..."}
          </div>
          {primaryGpu && (
            <div className="text-[11px] text-zinc-500 font-mono">
              {primaryGpu.vramMb
                ? `${(primaryGpu.vramMb / 1024).toFixed(primaryGpu.vramMb >= 1024 ? 1 : 2)} GB`
                : primaryGpu.isDiscrete
                ? "Discrete GPU"
                : "Integrated GPU"}
              {primaryDisplay ? ` • ${primaryDisplay.resolution}` : ""}
            </div>
          )}
        </div>

        {/* Memory */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <MemoryStick className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Memory</span>
          </div>
          <div className="text-zinc-900 font-medium">
            {specs
              ? `${Math.round(specs.totalRamGb)} GB ${ramType}${ramSpeed ? `-${ramSpeed}` : ""}`
              : "Detecting memory..."}
          </div>
          {specs?.ramChannelMode && (
            <div className="text-[11px] text-zinc-500">{specs.ramChannelMode}</div>
          )}
        </div>

        {/* Storage */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <HardDrive className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Storage</span>
          </div>
          <div className="text-zinc-900 font-medium leading-snug">
            {primaryDisk?.model || "Detecting storage..."}
          </div>
          {primaryDisk && (
            <div className="text-[11px] text-zinc-500 font-mono">
              {primaryDisk.sizeGb.toFixed(0)} GB {primaryDisk.interfaceType}
            </div>
          )}
        </div>

        {/* Battery */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <Battery className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Battery</span>
          </div>
          <div className="text-zinc-900 font-medium">
            {battery
              ? battery.present
                ? `Health: ${battery.healthPercent != null ? `${battery.healthPercent.toFixed(0)}%` : "Unknown"}`
                : "No Battery (AC Only)"
              : "Checking battery..."}
          </div>
          {battery?.present && (
            <div className="text-[11px] text-zinc-500 font-mono">
              {battery.currentChargePercent != null ? `${battery.currentChargePercent.toFixed(0)}%` : "—"} •{" "}
              {battery.acPlugged ? "Plugged In" : "On Battery"}
              {battery.cycleCount != null ? ` • ${battery.cycleCount} cyc` : ""}
            </div>
          )}
        </div>

        {/* Wi-Fi */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-bold text-black">
            <Wifi className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Wireless</span>
          </div>
          <div className="text-zinc-900 font-medium truncate">
            {specs?.wifiSsid || "Not Connected"}
          </div>
          {specs?.wifiSignalPct != null && (
            <div className="text-[11px] text-zinc-500 font-mono">
              Signal {specs.wifiSignalPct}%
              {specs.wifiRssiDbm != null ? ` (${specs.wifiRssiDbm} dBm)` : ""}
            </div>
          )}
        </div>

        {/* Security & BIOS */}
        <div className="space-y-1 pt-2 border-t border-zinc-200">
          <div className="flex items-center gap-2 font-bold text-black">
            <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Security &amp; BIOS</span>
          </div>
          <div className="text-zinc-900 font-medium">{biosText}</div>
          <div className="text-[11px] text-zinc-500">{mdmText}</div>
        </div>
      </div>
    </aside>
  );
};
