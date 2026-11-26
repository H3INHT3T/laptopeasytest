import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Cpu,
  HardDrive,
  Laptop,
  MemoryStick,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Usb,
  Wifi,
} from "lucide-react";
import type { HardwareFaultsReport, NetworkDiagnosticsReport, SystemSpecs, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface SpecsViewProps {
  specs: SystemSpecs | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  networkReport?: NetworkDiagnosticsReport | null;
  loadingNetwork?: boolean;
  hardwareFaults?: HardwareFaultsReport | null;
  loadingFaults?: boolean;
  onRefreshFaults?: () => Promise<HardwareFaultsReport | null>;
  onRunNetworkDiagnostics?: () => Promise<NetworkDiagnosticsReport | null>;
  onNetworkComplete?: (rep: NetworkDiagnosticsReport) => void;
  onRefresh: () => void;
  onNext: () => void;
  onSkip: () => void;
}

const Row: React.FC<{ label: string; value: string | number | null | undefined }> = ({
  label,
  value,
}) => (
  <div className="flex items-start justify-between gap-4 py-1.5 border-b border-zinc-100 last:border-0 text-xs">
    <span className="text-zinc-500 shrink-0">{label}</span>
    <span className="font-mono font-medium text-black text-right break-all">
      {value !== null && value !== undefined && String(value).trim() !== "" ? String(value) : "—"}
    </span>
  </div>
);

export const SpecsView: React.FC<SpecsViewProps> = ({
  specs,
  loading,
  status,
  stepNumber,
  totalSteps,
  networkReport = null,
  loadingNetwork = false,
  hardwareFaults = null,
  loadingFaults = false,
  onRefreshFaults,
  onRunNetworkDiagnostics,
  onNetworkComplete,
  onRefresh,
  onNext,
  onSkip,
}) => {
  const [localNetReport, setLocalNetReport] = useState<NetworkDiagnosticsReport | null>(null);
  const [localNetLoading, setLocalNetLoading] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);

  const effectiveNetReport = networkReport ?? localNetReport;
  const effectiveNetLoading = Boolean(loadingNetwork || localNetLoading);

  const handleRunNetworkCheck = async () => {
    setNetError(null);
    setLocalNetLoading(true);
    try {
      const rep = onRunNetworkDiagnostics
        ? await onRunNetworkDiagnostics()
        : await invoke<NetworkDiagnosticsReport>("run_network_diagnostics");
      if (rep) {
        setLocalNetReport(rep);
        onNetworkComplete?.(rep);
      }
    } catch (e) {
      setNetError(String(e));
    } finally {
      setLocalNetLoading(false);
    }
  };

  const primaryDisk = specs?.disks[0] ?? null;
  const primaryPanel = hardwareFaults?.panels?.[0] ?? null;
  const primaryDisplay = specs?.displays[0] ?? null;

  const hasCriticalFault = Boolean((hardwareFaults?.criticalFaultCount ?? 0) > 0);
  const hasAnyWarning = Boolean(
    specs?.ramConfigWarning ||
      specs?.wifiAntennaWarning ||
      (hardwareFaults?.warningFaultCount ?? 0) > 0 ||
      (hardwareFaults?.pcieDowngradeCount ?? 0) > 0
  );

  const healthPct = hasCriticalFault ? 20 : hasAnyWarning ? 72 : 100;
  const healthLabel = hasCriticalFault
    ? `${hardwareFaults?.criticalFaultCount} critical fault(s)`
    : hasAnyWarning
    ? "Warnings detected"
    : "All hardware healthy";

  const shortCpu = specs
    ? specs.cpuBrand
        .replace(/\(R\)|\(TM\)|CPU|@.*$/gi, "")
        .replace(/\b1\dth Gen\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
    : "—";

  const alerts: string[] = [];
  if (hardwareFaults && hardwareFaults.criticalFaultCount > 0) {
    alerts.push(hardwareFaults.plainSummary);
  }
  if (hardwareFaults && hardwareFaults.pcieDowngradeCount > 0) {
    alerts.push(`${hardwareFaults.pcieDowngradeCount} PCIe lane downgrade(s) detected`);
  }
  if (specs?.ramConfigWarning) alerts.push(specs.ramConfigWarning);
  if (specs?.wifiAntennaWarning) alerts.push(specs.wifiAntennaWarning);

  return (
    <div className="space-y-6">
      {/* BLOCK 1: Minimal Header + 1 Primary Button */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Complete Hardware Specifications
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps}
            {specs ? ` • ${specs.manufacturer} ${specs.model} • S/N ${specs.serialNumber}` : ""}
          </div>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 transition cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Re-scan
        </button>
      </div>

      {/* BLOCK 2: 1 Clean Visual Result Block */}
      {!specs ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500">
          {loading ? "Scanning hardware subsystems..." : "Click Re-scan to inspect hardware."}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-6">
          {/* 4 Big Key Hardware Tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <Cpu className="w-3.5 h-3.5 text-blue-600" />
                Processor
              </div>
              <div className="text-sm font-bold text-black truncate" title={specs.cpuBrand}>
                {shortCpu}
              </div>
              <div className="text-xs font-mono text-zinc-500">
                {specs.cpuPhysicalCores}C / {specs.cpuLogicalCores}T
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <MemoryStick className="w-3.5 h-3.5 text-blue-600" />
                Memory
              </div>
              <div className="text-xl font-bold text-black tabular-nums leading-tight">
                {Math.round(specs.totalRamGb)} GB
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {specs.ramChannelMode || specs.ramModules[0]?.memoryType || "Installed"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <HardDrive className="w-3.5 h-3.5 text-blue-600" />
                Storage
              </div>
              <div className="text-xl font-bold text-black tabular-nums leading-tight">
                {primaryDisk ? `${primaryDisk.sizeGb.toFixed(0)} GB` : "—"}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {primaryDisk ? primaryDisk.interfaceType : "No drive"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <Monitor className="w-3.5 h-3.5 text-blue-600" />
                Display panel
              </div>
              <div className="text-sm font-bold text-black truncate">
                {primaryPanel
                  ? `${primaryPanel.manufacturerCode}${primaryPanel.mfgYear ? ` (${primaryPanel.mfgYear})` : ""}`
                  : primaryDisplay?.resolution || "Detected"}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {primaryPanel?.replacementSuspected
                  ? "Info: Replacement date"
                  : primaryDisplay?.resolution || "EDID verified"}
              </div>
            </div>
          </div>

          {/* 1 Clean Integrity Bar (Device Manager + PCIe + Network) */}
          <div className="space-y-2.5 pt-2 border-t border-zinc-100">
            <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-black">Hardware health &amp; fault check</span>
                <span className="text-zinc-500">
                  •{" "}
                  {loadingFaults
                    ? "Scanning Device Manager & PCIe..."
                    : hardwareFaults
                    ? `${hardwareFaults.deviceFaults.length} PnP errors • ${
                        hardwareFaults.pcieDowngradeCount === 0
                          ? "PCIe full width"
                          : `${hardwareFaults.pcieDowngradeCount} PCIe downgrade`
                      }`
                    : "Specs verified"}
                  {effectiveNetReport ? ` • Network ${effectiveNetReport.verdict.toLowerCase()}` : ""}
                </span>
              </div>
              <span
                className={`font-semibold ${
                  hasCriticalFault ? "text-black" : hasAnyWarning ? "text-zinc-700" : "text-blue-700"
                }`}
              >
                {healthLabel}
              </span>
            </div>

            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  hasCriticalFault || hasAnyWarning ? "bg-black" : "bg-blue-600"
                }`}
                style={{ width: `${healthPct}%` }}
              />
            </div>

            {alerts.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-4 py-3 space-y-1 text-xs text-black">
                {alerts.map((msg, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <ShieldAlert className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                    <span>{msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* BLOCK 3: 1 Collapsed "Details" Toggle (All Technical Tables Live Here) */}
      {specs && (
        <TechnicalDetailsDrawer
          title="Details"
          subtitle="Chassis & BIOS, RAM slots, GPUs, Disks, Network check, Device Manager, PCIe & EDID"
        >
          <div className="space-y-4">
            {/* Hidden Hardware Faults, PCIe & EDID */}
            {hardwareFaults && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-black">
                    Device Manager, PCIe lanes &amp; Panel EDID
                  </span>
                  {onRefreshFaults && (
                    <button
                      type="button"
                      disabled={loadingFaults}
                      onClick={() => onRefreshFaults()}
                      className="text-xs font-semibold text-blue-700 hover:underline cursor-pointer"
                    >
                      {loadingFaults ? "Scanning..." : "Re-scan faults"}
                    </button>
                  )}
                </div>

                {hardwareFaults.deviceFaults.length === 0 ? (
                  <div className="text-xs text-zinc-600">
                    Zero Device Manager error codes detected (no Code 43, Code 10, or missing drivers).
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 text-xs">
                    {hardwareFaults.deviceFaults.map((f, idx) => (
                      <div key={idx} className="py-2 flex items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold text-black">{f.name}</div>
                          <div className="text-zinc-500">{f.errorLabel}</div>
                        </div>
                        <span className="px-2 py-0.5 rounded-lg bg-black text-white font-mono text-[10px] font-bold">
                          Code {f.errorCode}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {hardwareFaults.pcieLinks.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                    {hardwareFaults.pcieLinks.map((p, idx) => (
                      <div key={idx} className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-black truncate">{p.name}</span>
                          <span className="font-mono text-[11px] font-bold text-blue-700">
                            {p.currentWidth != null && p.maxWidth != null ? `x${p.currentWidth}/x${p.maxWidth}` : p.verdict}
                          </span>
                        </div>
                        <div className="text-zinc-500 mt-1">{p.detail}</div>
                      </div>
                    ))}
                  </div>
                )}

                {hardwareFaults.panels.length > 0 && (
                  <div className="space-y-2 pt-1">
                    {hardwareFaults.panels.map((pan, idx) => (
                      <div key={idx} className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 text-xs">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <span className="font-semibold text-black">
                            {pan.manufacturerName} • <span className="font-mono">{pan.panelModel}</span>
                          </span>
                          <span className="font-mono text-[11px] text-zinc-600">
                            {pan.diagonalInches ? `${pan.diagonalInches.toFixed(1)}" • ` : ""}
                            {pan.mfgYear ? `Mfg ${pan.mfgYear}${pan.mfgWeek ? ` Wk ${pan.mfgWeek}` : ""}` : "EDID"}
                          </span>
                        </div>
                        <div className="text-zinc-500 mt-1">{pan.disclosureNote}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* System & CPU */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-black mb-2">
                  <Laptop className="w-4 h-4 text-blue-600" /> System &amp; BIOS
                </div>
                <Row label="Model" value={specs.systemSku ? `${specs.model} (${specs.systemSku})` : specs.model} />
                <Row label="Serial number" value={specs.serialNumber} />
                <Row label="Motherboard" value={`${specs.motherboardVendor} ${specs.motherboardProduct}`.trim()} />
                <Row label="BIOS" value={`${specs.biosVendor} ${specs.biosVersion} ${specs.biosDate ? `(${specs.biosDate})` : ""}`.trim()} />
                <Row label="OS" value={`${specs.osName} (${specs.architecture})`} />
              </div>

              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-black mb-2">
                  <Cpu className="w-4 h-4 text-blue-600" /> Processor
                </div>
                <Row label="Brand" value={specs.cpuBrand} />
                <Row label="Cores / Threads" value={`${specs.cpuPhysicalCores} / ${specs.cpuLogicalCores}`} />
                <Row label="Base / Max clock" value={`${specs.cpuBaseMhz} MHz / ${specs.cpuMaxMhz ? `${specs.cpuMaxMhz} MHz` : "Auto"}`} />
                <Row label="L2 / L3 cache" value={`${specs.cpuL2Kb ? `${(specs.cpuL2Kb / 1024).toFixed(1)} MB` : "—"} / ${specs.cpuL3Kb ? `${(specs.cpuL3Kb / 1024).toFixed(1)} MB` : "—"}`} />
                <Row label="Virtualization" value={specs.cpuVirtualization == null ? "—" : specs.cpuVirtualization ? "Enabled" : "Disabled"} />
              </div>
            </div>

            {/* RAM DIMMs */}
            <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-black flex items-center gap-2">
                  <MemoryStick className="w-4 h-4 text-blue-600" /> Memory modules ({specs.ramModules.length}
                  {specs.ramSlotsTotal ? ` / ${specs.ramSlotsTotal} slots` : ""})
                </span>
                {specs.ramChannelMode && <span className="font-mono text-zinc-500">{specs.ramChannelMode}</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500 border-b border-zinc-200">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Slot</th>
                      <th className="py-1.5 pr-3 font-medium">Size</th>
                      <th className="py-1.5 pr-3 font-medium">Type</th>
                      <th className="py-1.5 pr-3 font-medium">Speed</th>
                      <th className="py-1.5 pr-3 font-medium">Vendor</th>
                      <th className="py-1.5 font-medium">Part</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 font-mono">
                    {specs.ramModules.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-2 text-zinc-500 font-sans">
                          Unified / soldered memory ({specs.totalRamGb.toFixed(1)} GB)
                        </td>
                      </tr>
                    ) : (
                      specs.ramModules.map((m, i) => (
                        <tr key={i}>
                          <td className="py-1.5 pr-3 text-black">{m.slot}</td>
                          <td className="py-1.5 pr-3 text-blue-700 font-bold">{m.capacityGb} GB</td>
                          <td className="py-1.5 pr-3">{m.memoryType}</td>
                          <td className="py-1.5 pr-3">{m.speedMhz ? `${m.speedMhz} MHz` : "—"}</td>
                          <td className="py-1.5 pr-3">{m.manufacturer}</td>
                          <td className="py-1.5">{m.partNumber || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* GPUs & Disks */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2">
                <div className="text-xs font-bold text-black flex items-center gap-2">
                  <Monitor className="w-4 h-4 text-blue-600" /> Graphics adapters
                </div>
                {specs.gpus.map((g, idx) => (
                  <div key={idx} className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 text-xs">
                    <div className="font-semibold text-black">{g.name}</div>
                    <div className="font-mono text-[11px] text-zinc-500 mt-0.5">
                      {g.isDiscrete ? "Discrete" : "Integrated"}
                      {g.vramMb ? ` • ${(g.vramMb / 1024).toFixed(1)} GB VRAM` : ""}
                      {g.driverVersion ? ` • Driver ${g.driverVersion}` : ""}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2">
                <div className="text-xs font-bold text-black flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-blue-600" /> Storage drives
                </div>
                {specs.disks.map((d, idx) => (
                  <div key={idx} className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-black truncate">{d.model}</span>
                      <span className="font-mono font-bold text-blue-700 shrink-0">{d.sizeGb.toFixed(0)} GB</span>
                    </div>
                    <div className="font-mono text-[11px] text-zinc-500 mt-0.5">
                      {d.interfaceType} • {d.mediaType}
                      {d.serialNumber ? ` • S/N ${d.serialNumber}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Live Network Diagnostics */}
            <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold text-black flex items-center gap-2">
                  <Activity className="w-4 h-4 text-blue-600" /> Network diagnostics
                </span>
                <button
                  type="button"
                  onClick={handleRunNetworkCheck}
                  disabled={effectiveNetLoading}
                  className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${effectiveNetLoading ? "animate-spin text-blue-600" : ""}`} />
                  {effectiveNetLoading ? "Checking..." : "Run Network Check"}
                </button>
              </div>
              {netError && <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{netError}</div>}
              {effectiveNetReport && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                  <div className="rounded-lg bg-[#F8FAFC] border border-zinc-200 p-2.5">
                    <div className="text-[10px] text-zinc-500 font-sans">Interface</div>
                    <div className="font-bold text-black truncate">{effectiveNetReport.interfaceName}</div>
                  </div>
                  <div className="rounded-lg bg-[#F8FAFC] border border-zinc-200 p-2.5">
                    <div className="text-[10px] text-zinc-500 font-sans">Link speed</div>
                    <div className="font-bold text-blue-700">
                      {effectiveNetReport.linkSpeedMbps != null ? `${effectiveNetReport.linkSpeedMbps} Mbps` : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#F8FAFC] border border-zinc-200 p-2.5">
                    <div className="text-[10px] text-zinc-500 font-sans">Gateway ping</div>
                    <div className="font-bold text-black">
                      {effectiveNetReport.gatewayPingMs != null ? `${effectiveNetReport.gatewayPingMs.toFixed(1)} ms` : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#F8FAFC] border border-zinc-200 p-2.5">
                    <div className="text-[10px] text-zinc-500 font-sans">DNS / Loss</div>
                    <div className="font-bold text-black">
                      {effectiveNetReport.dnsResolveOk ? "OK" : "Fail"} • {effectiveNetReport.packetLossPct.toFixed(0)}%
                    </div>
                  </div>
                </div>
              )}
              {specs.wifiSsid && (
                <div className="text-xs text-zinc-500 flex items-center gap-2">
                  <Wifi className="w-3.5 h-3.5 text-blue-600" />
                  <span>
                    SSID: <strong className="text-black">{specs.wifiSsid}</strong>
                    {specs.wifiSignalPct != null ? ` • Signal ${specs.wifiSignalPct}% (${specs.wifiRssiDbm ?? "—"} dBm)` : ""}
                  </span>
                </div>
              )}
            </div>

            {/* Peripherals */}
            {specs.peripherals.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2">
                <div className="text-xs font-bold text-black flex items-center gap-2">
                  <Usb className="w-4 h-4 text-blue-600" /> Peripherals ({specs.peripherals.length})
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-zinc-100 text-xs">
                  {specs.peripherals.map((p, i) => (
                    <div key={i} className="py-1.5 flex items-center justify-between gap-2">
                      <span className="text-black truncate">{p.name}</span>
                      <span className="font-mono text-[11px] text-zinc-500 shrink-0">{p.category}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TechnicalDetailsDrawer>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(specs)}
        requirementHint="Waiting for hardware scan to finish."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
