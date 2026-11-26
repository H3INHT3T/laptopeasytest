import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  CheckSquare,
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
import { NovabenchScoreBar } from "../components/NovabenchScoreBar";

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
    <span className="font-mono font-semibold text-black text-right break-all">
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

  const isSolderedOrLpddr = specs
    ? specs.ramModules.length === 0 ||
      specs.ramModules.every(
        (m) =>
          /lpddr/i.test(m.memoryType) || /onboard|soldered|unified/i.test(m.formFactor)
      ) ||
      /unified|soldered/i.test(specs.ramChannelMode ?? "")
    : false;

  const freeRamSlots =
    specs && specs.ramSlotsTotal != null
      ? Math.max(0, specs.ramSlotsTotal - specs.ramModules.length)
      : 0;

  const ramUpgradeBadge = !specs
    ? ""
    : isSolderedOrLpddr
    ? "SOLDERED / NON-UPGRADEABLE"
    : freeRamSlots > 0
    ? `UPGRADEABLE (${freeRamSlots} FREE SLOT${freeRamSlots > 1 ? "S" : ""})`
    : "SLOTS FULL (REPLACEMENT UPGRADE)";

  const fallbackPlainSummary = specs
    ? `${specs.manufacturer} ${specs.model} equipped with ${specs.cpuBrand} (${specs.cpuPhysicalCores}C/${specs.cpuLogicalCores}T), ${specs.totalRamGb.toFixed(1)} GB ${specs.ramChannelMode ?? "RAM"}, and ${specs.disks.length} physical storage drive${specs.disks.length === 1 ? "" : "s"}.`
    : "";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-xs font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Complete Hardware Specifications
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Deep inventory of Chassis, Motherboard, BIOS, CPU Cache/Clocks, RAM DIMMs, 64-bit GPU VRAM, Physical Disks, Volumes, Displays, Network &amp; Peripherals.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3.5 py-2 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Re-scan All Hardware
        </button>
      </div>

      {!specs ? (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-10 text-center text-sm text-zinc-600">
          {loading ? "Enumerating all laptop hardware subsystems..." : "Click Re-scan All Hardware to inspect specifications."}
        </div>
      ) : (
        <div className="space-y-4">
          {!specs.isElevated && specs.osFamily === "windows" && (
            <div className="rounded-[2px] border border-blue-600 bg-blue-50/40 px-4 py-3 flex items-center gap-3 text-xs text-black">
              <ShieldAlert className="w-4 h-4 shrink-0 text-blue-600" />
              <span>
                Running without Administrator elevation. Release builds automatically prompt UAC for complete SMART, BitLocker, and System Event Logs.
              </span>
            </div>
          )}

          {/* Plain-Language Specs Interpretation & Reliability Notes */}
          <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
              Plain-Language Specs Interpretation
            </div>
            <div className="text-xs text-black font-medium">
              {specs.plainSummary || fallbackPlainSummary}
            </div>
            {(specs.reliabilityNotes?.length ?? 0) > 0 && (
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-3 space-y-1">
                <div className="font-mono text-[10px] font-bold uppercase text-zinc-600">
                  Reliability &amp; Hardware Audit Notes
                </div>
                <ul className="space-y-1 text-xs text-zinc-700">
                  {specs.reliabilityNotes!.map((note, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <CheckSquare className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Hidden Hardware Faults & Panel EDID Authenticity Audit (v2.8.0) */}
          {hardwareFaults ? (
            <div className="space-y-2.5">
              <NovabenchScoreBar
                scoreLabel="FAULTS"
                scoreValue={
                  hardwareFaults.criticalFaultCount > 0
                    ? `${hardwareFaults.criticalFaultCount} FAIL`
                    : hardwareFaults.warningFaultCount > 0 || hardwareFaults.pcieDowngradeCount > 0
                    ? "WARN"
                    : "0 ERR"
                }
                title="Hidden Hardware Faults, PCIe Lanes & Panel EDID"
                takeaway={hardwareFaults.plainSummary}
                percent={
                  hardwareFaults.criticalFaultCount > 0
                    ? 15
                    : hardwareFaults.warningFaultCount > 0 || hardwareFaults.pcieDowngradeCount > 0
                    ? 65
                    : 100
                }
                medianLabel="Shop Hardware Integrity Target"
                medianPercent={95}
                badge={
                  hardwareFaults.panels[0]
                    ? `${hardwareFaults.panels[0].manufacturerCode}${
                        hardwareFaults.panels[0].mfgYear ? ` ${hardwareFaults.panels[0].mfgYear}` : ""
                      }${hardwareFaults.replacementPanelNoted ? " • INFO: Replaced" : ""}`
                    : `${hardwareFaults.pcieLinks.length} PCIe Links`
                }
                monochrome={hardwareFaults.status !== "pass"}
              />

              <TechnicalDetailsDrawer
                title="Device Manager Faults, PCIe Link Width & Display Panel EDID"
                subtitle={`${hardwareFaults.deviceFaults.length} PnP error(s) • ${hardwareFaults.pcieLinks.length} PCIe link(s) • ${hardwareFaults.panels.length} panel EDID`}
                defaultOpen={hardwareFaults.status !== "pass"}
              >
                <div className="space-y-3">
                  {/* Device Manager PnP Faults */}
                  <div className="rounded-xl border border-zinc-200 bg-white p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10.5px] font-bold uppercase text-black">
                        Device Manager / PnP Health ({hardwareFaults.deviceFaults.length} error{hardwareFaults.deviceFaults.length === 1 ? "" : "s"})
                      </span>
                      {onRefreshFaults && (
                        <button
                          type="button"
                          disabled={loadingFaults}
                          onClick={() => onRefreshFaults()}
                          className="text-[10.5px] font-mono font-bold text-blue-700 hover:underline cursor-pointer"
                        >
                          {loadingFaults ? "Scanning..." : "Re-scan"}
                        </button>
                      )}
                    </div>
                    {hardwareFaults.deviceFaults.length === 0 ? (
                      <div className="text-xs text-zinc-600">
                        Zero Device Manager error codes (no Code 43 dead GPU, Code 10 init failures, or Code 28 missing drivers).
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-100 text-xs">
                        {hardwareFaults.deviceFaults.map((f, idx) => (
                          <div key={idx} className="py-2 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-bold text-black">
                                {f.name}{" "}
                                <span className="font-mono text-[10px] text-zinc-500">[{f.pnpClass}]</span>
                              </div>
                              <div className="text-[11px] text-zinc-600">{f.errorLabel}</div>
                            </div>
                            <span
                              className={`shrink-0 px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                                f.severity === "critical"
                                  ? "bg-black text-white"
                                  : "border border-zinc-300 bg-[#F8FAFC] text-black"
                              }`}
                            >
                              Code {f.errorCode} • {f.severity === "critical" ? "FAIL" : "WARN"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* PCIe Link Width & Gen Audit */}
                  {hardwareFaults.pcieLinks.length > 0 && (
                    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 space-y-2">
                      <div className="font-mono text-[10.5px] font-bold uppercase text-black">
                        PCIe Link Width &amp; Speed Audit (ASPM-Aware)
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {hardwareFaults.pcieLinks.map((p, idx) => (
                          <div
                            key={idx}
                            className={`rounded-lg border p-2.5 text-xs ${
                              p.verdict === "LANE_DOWNGRADE"
                                ? "border-black bg-zinc-50"
                                : "border-zinc-200 bg-[#F8FAFC]"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-black truncate">{p.name}</strong>
                              <span
                                className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  p.verdict === "LANE_DOWNGRADE"
                                    ? "bg-black text-white"
                                    : "bg-blue-50 text-blue-700"
                                }`}
                              >
                                {p.currentWidth != null && p.maxWidth != null
                                  ? `x${p.currentWidth} / x${p.maxWidth}`
                                  : p.verdict}
                              </span>
                            </div>
                            <div className="text-[11px] text-zinc-600 mt-1">{p.detail}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Display Panel EDID Authenticity */}
                  {hardwareFaults.panels.length > 0 && (
                    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 space-y-2">
                      <div className="font-mono text-[10.5px] font-bold uppercase text-black">
                        Display Panel EDID Hardware Identity
                      </div>
                      <div className="space-y-2">
                        {hardwareFaults.panels.map((pan, idx) => (
                          <div key={idx} className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-2.5 text-xs space-y-1">
                            <div className="flex items-center justify-between flex-wrap gap-2">
                              <span className="font-bold text-black">
                                {pan.manufacturerName} — <span className="font-mono">{pan.panelModel}</span>
                              </span>
                              <div className="flex items-center gap-1.5 font-mono text-[10px]">
                                {pan.diagonalInches && (
                                  <span className="px-1.5 py-0.5 rounded bg-white border border-zinc-200 text-black">
                                    {pan.diagonalInches.toFixed(1)}&quot;
                                  </span>
                                )}
                                {pan.mfgYear && (
                                  <span className="px-1.5 py-0.5 rounded bg-white border border-zinc-200 text-black">
                                    Mfg {pan.mfgYear}{pan.mfgWeek ? ` Wk ${pan.mfgWeek}` : ""}
                                  </span>
                                )}
                                {pan.replacementSuspected && (
                                  <span className="px-1.5 py-0.5 rounded bg-blue-600 text-white font-bold">
                                    INFO: REPLACEMENT PANEL
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="text-[11px] text-zinc-600">{pan.disclosureNote}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </TechnicalDetailsDrawer>
            </div>
          ) : loadingFaults ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs font-mono text-zinc-500">
              Scanning Device Manager error codes, PCIe lane widths &amp; display panel EDID...
            </div>
          ) : null}

          {/* System, Motherboard, BIOS & CPU */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-[2px] border border-zinc-300 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider mb-3">
                <Laptop className="w-4 h-4" /> System, Chassis &amp; Motherboard
              </div>
              <Row label="Manufacturer" value={specs.manufacturer} />
              <Row label="Model / SKU" value={specs.systemSku ? `${specs.model} (${specs.systemSku})` : specs.model} />
              <Row label="Chassis Type" value={specs.chassisType} />
              <Row label="Serial Number" value={specs.serialNumber} />
              <Row label="System UUID" value={specs.systemUuid} />
              <Row label="Motherboard" value={`${specs.motherboardVendor} ${specs.motherboardProduct}`.trim()} />
              <Row label="Board Serial" value={specs.motherboardSerial} />
              <Row label="BIOS / Firmware" value={`${specs.biosVendor} ${specs.biosVersion} ${specs.biosDate ? `(${specs.biosDate})` : ""}`.trim()} />
              <Row label="Operating System" value={`${specs.osName} (${specs.architecture})`} />
              <Row label="OS Build / Kernel" value={specs.osBuild} />
              <Row label="Hostname" value={specs.hostname} />
            </div>

            <div className="rounded-[2px] border border-zinc-300 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider mb-3">
                <Cpu className="w-4 h-4" /> Processor (CPU) Architecture
              </div>
              <Row label="Processor Brand" value={specs.cpuBrand} />
              <Row label="Socket / Package" value={specs.cpuSocket} />
              <Row label="Physical / Logical Cores" value={`${specs.cpuPhysicalCores} Cores / ${specs.cpuLogicalCores} Threads`} />
              <Row label="Base Clock" value={`${specs.cpuBaseMhz} MHz`} />
              <Row label="Max Rated Clock" value={specs.cpuMaxMhz ? `${specs.cpuMaxMhz} MHz` : "Auto Boost"} />
              <Row label="L2 Cache" value={specs.cpuL2Kb ? `${(specs.cpuL2Kb / 1024).toFixed(1)} MB (${specs.cpuL2Kb} KB)` : "—"} />
              <Row label="L3 Cache" value={specs.cpuL3Kb ? `${(specs.cpuL3Kb / 1024).toFixed(1)} MB (${specs.cpuL3Kb} KB)` : "—"} />
              <Row
                label="Hardware Virtualization"
                value={specs.cpuVirtualization == null ? "—" : specs.cpuVirtualization ? "Enabled (VT-x / AMD-V)" : "Disabled"}
              />
              <Row
                label="Laptop Thermal Class"
                value={specs.isGamingCapable ? "Gaming / Pro Discrete GPU" : "Office / Standard Notebook"}
              />
              <Row label="System Uptime" value={`${Math.floor(specs.uptimeSeconds / 3600)}h ${Math.floor((specs.uptimeSeconds % 3600) / 60)}m`} />
              <Row label="Privilege Mode" value={specs.isElevated ? "Administrator / Elevated" : "Standard User"} />
            </div>
          </div>

          {/* RAM Mismatch / Single-Channel & Wi-Fi Antenna RSSI Audit Alerts */}
          {(specs.ramConfigWarning || specs.wifiAntennaWarning) && (
            <div className="space-y-2">
              {specs.ramConfigWarning && (
                <div className="rounded-[2px] border-2 border-black bg-white px-4 py-3 flex items-start gap-3 text-xs">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-blue-600 mt-0.5" />
                  <div>
                    <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-blue-700">
                      RAM CONFIGURATION AUDIT ({specs.ramChannelMode ?? "DETECTED"})
                    </div>
                    <div className="font-semibold text-black mt-0.5">{specs.ramConfigWarning}</div>
                  </div>
                </div>
              )}
              {specs.wifiAntennaWarning && (
                <div className="rounded-[2px] border-2 border-black bg-black text-white px-4 py-3 flex items-start gap-3 text-xs">
                  <Wifi className="w-4 h-4 shrink-0 text-blue-400 mt-0.5" />
                  <div>
                    <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-blue-400">
                      WI-FI ANTENNA / COAX RSSI ALERT
                    </div>
                    <div className="mt-0.5">{specs.wifiAntennaWarning}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Memory (RAM) Full DIMM Table */}
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider flex-wrap">
                <MemoryStick className="w-4 h-4" /> Memory (RAM) — {specs.totalRamGb.toFixed(1)} GB Installed
                {specs.ramChannelMode && (
                  <span className="px-1.5 py-0.5 rounded-[2px] bg-[#F8FAFC] border border-zinc-300 text-black font-mono text-[10px]">
                    {specs.ramChannelMode}
                  </span>
                )}
                <span
                  className={`px-1.5 py-0.5 rounded-[2px] font-mono text-[10px] font-bold border ${
                    isSolderedOrLpddr
                      ? "bg-black text-white border-black"
                      : freeRamSlots > 0
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-[#F8FAFC] text-black border-zinc-300"
                  }`}
                >
                  {ramUpgradeBadge}
                </span>
              </div>
              <div className="text-xs font-mono text-zinc-600">
                Slots Used: <strong className="text-black">{specs.ramModules.length}</strong>
                {specs.ramSlotsTotal ? ` / ${specs.ramSlotsTotal}` : ""}
                {specs.ramMaxCapacityGb ? ` • Max Supported: ${specs.ramMaxCapacityGb.toFixed(0)} GB` : ""}
              </div>
            </div>
            {(specs.ramReliabilityNote || isSolderedOrLpddr) && (
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] px-3 py-2 text-xs text-zinc-700">
                <span className="font-mono text-[10px] font-bold uppercase text-black mr-2">
                  Upgradeability Note:
                </span>
                {isSolderedOrLpddr && !/soldered|non-upgradeable|integrated/i.test(specs.ramReliabilityNote ?? "")
                  ? `Onboard / Soldered LPDDR/Unified memory (${specs.totalRamGb.toFixed(1)} GB) is permanently soldered to the motherboard and cannot be upgraded later.`
                  : specs.ramReliabilityNote}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F8FAFC] border-y border-zinc-200 text-zinc-500 uppercase text-[10px]">
                  <tr>
                    <th className="py-2 px-3">Slot</th>
                    <th className="py-2 px-3">Capacity</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Speed</th>
                    <th className="py-2 px-3">Form Factor</th>
                    <th className="py-2 px-3">Manufacturer</th>
                    <th className="py-2 px-3">Part Number</th>
                    <th className="py-2 px-3">Serial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 font-mono">
                  {specs.ramModules.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-3 px-3 text-zinc-500">
                        Unified / Integrated Memory ({specs.totalRamGb.toFixed(1)} GB — Onboard / Soldered)
                      </td>
                    </tr>
                  ) : (
                    specs.ramModules.map((m, i) => (
                      <tr key={i} className="hover:bg-blue-50/40">
                        <td className="py-2 px-3 font-bold text-black">{m.slot}</td>
                        <td className="py-2 px-3 text-blue-700 font-bold">{m.capacityGb} GB</td>
                        <td className="py-2 px-3">{m.memoryType}</td>
                        <td className="py-2 px-3">{m.speedMhz ? `${m.speedMhz} MHz` : "—"}</td>
                        <td className="py-2 px-3">{m.formFactor}</td>
                        <td className="py-2 px-3">{m.manufacturer}</td>
                        <td className="py-2 px-3">{m.partNumber || "—"}</td>
                        <td className="py-2 px-3">{m.serialNumber || "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Graphics & Display Panels */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
                <Monitor className="w-4 h-4" /> Graphics Adapters (GPUs)
              </div>
              <div className="space-y-2.5">
                {specs.gpus.map((g, idx) => (
                  <div key={idx} className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-black">{g.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded-[2px] text-[10px] font-bold ${
                          g.isDiscrete ? "bg-blue-600 text-white" : "bg-white border border-zinc-300 text-zinc-700"
                        }`}
                      >
                        {g.isDiscrete ? "DISCRETE / PRO" : "INTEGRATED"}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-zinc-600">
                      Vendor: {g.vendor}
                      {g.vramMb ? ` • VRAM: ${g.vramMb >= 1024 ? `${(g.vramMb / 1024).toFixed(1)} GB` : `${g.vramMb} MB`}` : ""}
                    </div>
                    <div className="font-mono text-[11px] text-zinc-600">
                      Driver: {g.driverVersion || "—"} {g.driverDate ? `(${g.driverDate})` : ""}
                    </div>
                    {g.pnpDeviceId && (
                      <div className="font-mono text-[10px] text-zinc-400 truncate">{g.pnpDeviceId}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
                <Monitor className="w-4 h-4" /> Display Panels (EDID)
              </div>
              <div className="space-y-2.5">
                {specs.displays.length === 0 ? (
                  <div className="text-xs text-zinc-500">Default Active Display</div>
                ) : (
                  specs.displays.map((d, i) => (
                    <div key={i} className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-black">{d.name}</span>
                        <span className="font-mono font-bold text-blue-700">
                          {d.resolution}
                          {d.refreshRateHz ? ` @ ${d.refreshRateHz} Hz` : ""}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-zinc-600 mt-1">
                        Manufacturer: {d.manufacturer || "—"}
                        {d.diagonalInches ? ` • Physical Size: ~${d.diagonalInches}" Diagonal` : ""}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Storage Drives & Volumes */}
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
              <HardDrive className="w-4 h-4" /> Physical Storage Drives &amp; Partitions
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F8FAFC] border-y border-zinc-200 text-zinc-500 uppercase text-[10px]">
                  <tr>
                    <th className="py-2 px-3">Drive Model</th>
                    <th className="py-2 px-3">Capacity</th>
                    <th className="py-2 px-3">Interface</th>
                    <th className="py-2 px-3">Media</th>
                    <th className="py-2 px-3">Firmware</th>
                    <th className="py-2 px-3">Serial Number</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 font-mono">
                  {specs.disks.map((d, idx) => (
                    <tr key={idx}>
                      <td className="py-2 px-3 font-bold text-black">{d.model}</td>
                      <td className="py-2 px-3 text-blue-700 font-bold">{d.sizeGb.toFixed(0)} GB</td>
                      <td className="py-2 px-3">{d.interfaceType}</td>
                      <td className="py-2 px-3">{d.mediaType}</td>
                      <td className="py-2 px-3">{d.firmware || "—"}</td>
                      <td className="py-2 px-3">{d.serialNumber || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {specs.volumes.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-2">
                {specs.volumes.map((vol, i) => {
                  const usedPct = vol.totalGb > 0 ? Math.round(((vol.totalGb - vol.freeGb) / vol.totalGb) * 100) : 0;
                  return (
                    <div key={i} className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5 text-xs font-mono">
                      <div className="flex justify-between font-bold text-black">
                        <span>{vol.mount} {vol.label ? `(${vol.label})` : ""}</span>
                        <span className="text-blue-700">{vol.fileSystem}</span>
                      </div>
                      <div className="text-[11px] text-zinc-600 mt-1">
                        {vol.freeGb.toFixed(1)} GB free / {vol.totalGb.toFixed(1)} GB total ({usedPct}% used)
                      </div>
                      <div className="h-1.5 rounded-[2px] bg-zinc-200 mt-1.5 overflow-hidden">
                        <div className="h-full bg-blue-600" style={{ width: `${usedPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live Network & Wi-Fi Stability Diagnostics */}
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
                <Activity className="w-4 h-4" /> Live Network &amp; Wi-Fi Stability Diagnostics
                {effectiveNetReport && (
                  <>
                    <StatusBadge status={effectiveNetReport.status} compact />
                    <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10px] font-bold text-black">
                      {effectiveNetReport.verdict}
                    </span>
                  </>
                )}
              </div>
              <button
                onClick={handleRunNetworkCheck}
                disabled={effectiveNetLoading}
                className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${effectiveNetLoading ? "animate-spin text-blue-600" : ""}`} />
                {effectiveNetLoading ? "Checking Network..." : "Run Network Check"}
              </button>
            </div>

            {netError && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{netError}</div>
            )}

            {!effectiveNetReport ? (
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] px-3 py-3 text-xs text-zinc-600 font-mono">
                {effectiveNetLoading
                  ? "PROBING ACTIVE INTERFACE, GATEWAY PING, PACKET LOSS & DNS..."
                  : "Click Run Network Check to verify link speed, Wi-Fi RSSI, gateway latency, packet loss, and DNS resolution."}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border border-zinc-300 rounded-[2px] divide-x divide-y lg:divide-y-0 divide-zinc-200 font-mono tabular-nums text-xs">
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">Interface</div>
                    <div className="text-xs font-black text-black mt-0.5 truncate" title={effectiveNetReport.interfaceName}>
                      {effectiveNetReport.interfaceName || "—"}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">Link Speed</div>
                    <div className="text-sm font-black text-blue-700 mt-0.5">
                      {effectiveNetReport.linkSpeedMbps != null ? `${effectiveNetReport.linkSpeedMbps} Mbps` : "—"}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">Wi-Fi SSID / Signal</div>
                    <div className="text-xs font-black text-black mt-0.5 truncate">
                      {effectiveNetReport.wifiSsid || "Wired / N/A"}
                    </div>
                    {effectiveNetReport.wifiSignalPct != null && (
                      <div className="text-[10px] text-zinc-500">
                        {effectiveNetReport.wifiSignalPct}% ({effectiveNetReport.rssiDbm ?? "—"} dBm)
                      </div>
                    )}
                  </div>
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">Gateway Ping</div>
                    <div className="text-sm font-black text-black mt-0.5">
                      {effectiveNetReport.gatewayPingMs != null
                        ? `${effectiveNetReport.gatewayPingMs.toFixed(1)} ms`
                        : "—"}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">Packet Loss</div>
                    <div className={`text-sm font-black mt-0.5 ${effectiveNetReport.packetLossPct > 0 ? "text-black underline" : "text-blue-700"}`}>
                      {effectiveNetReport.packetLossPct.toFixed(0)}%
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#F8FAFC]">
                    <div className="text-[9.5px] uppercase text-zinc-500">DNS Status</div>
                    <div className={`text-sm font-black mt-0.5 ${effectiveNetReport.dnsResolveOk ? "text-blue-700" : "text-black underline"}`}>
                      {effectiveNetReport.dnsResolveOk ? "OK" : "Failed"}
                    </div>
                  </div>
                </div>
                <div className="rounded-[2px] border border-zinc-200 border-l-[3px] border-l-blue-600 bg-white px-3 py-2 text-xs text-black">
                  {effectiveNetReport.plainSummary}
                </div>
              </div>
            )}
          </div>

          {/* Network & Peripherals (Collapsible Technical Details) */}
          <TechnicalDetailsDrawer
            title="Network Adapters & Peripheral Controllers"
            subtitle={`${specs.networkAdapters.length} adapter(s) • ${specs.peripherals.length} device(s)`}
          >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
                  <Wifi className="w-4 h-4" /> Network Adapters &amp; Wi-Fi Antenna RSSI
                </div>
                {specs.wifiSignalPct != null && (
                  <span
                    className={`px-2 py-0.5 rounded-[2px] font-mono text-[10px] font-bold border ${
                      specs.wifiSignalPct < 45
                        ? "bg-black text-white border-black"
                        : "bg-blue-50 text-blue-700 border-blue-600"
                    }`}
                  >
                    RSSI {specs.wifiSignalPct}% ({specs.wifiRssiDbm ?? "—"} dBm)
                  </span>
                )}
              </div>
              {specs.wifiSsid && (
                <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] px-3 py-1.5 font-mono text-[11px] flex items-center justify-between">
                  <span>SSID: <strong className="text-black">{specs.wifiSsid}</strong></span>
                  <span className="text-zinc-600">{specs.wifiRadioType ?? "802.11"}</span>
                </div>
              )}
              {specs.networkAdapters.length === 0 ? (
                <div className="text-xs text-zinc-500">No physical network adapters enumerated.</div>
              ) : (
                <div className="space-y-2">
                  {specs.networkAdapters.map((n, i) => (
                    <div key={i} className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-black">{n.name}</span>
                        <span className="px-1.5 py-0.5 rounded-[2px] bg-white border border-zinc-300 font-mono text-[10px] font-bold">
                          {n.kind}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-zinc-600 mt-1">
                        MAC: {n.macAddress} • Link: {n.linkSpeed} • {n.status}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-blue-600 uppercase tracking-wider">
                <Usb className="w-4 h-4" /> Audio, Camera, Bluetooth &amp; USB Controllers
              </div>
              <div className="max-h-60 overflow-y-auto divide-y divide-zinc-100">
                {specs.peripherals.length === 0 ? (
                  <div className="text-xs text-zinc-500">No peripheral controllers listed.</div>
                ) : (
                  specs.peripherals.map((p, i) => (
                    <div key={i} className="py-1.5 flex items-center justify-between gap-2 text-xs">
                      <div className="min-w-0">
                        <span className="inline-block px-1.5 py-0.5 rounded-[2px] bg-blue-50 text-blue-800 border border-blue-200 font-mono text-[10px] font-bold mr-2">
                          {p.category}
                        </span>
                        <span className="font-medium text-black">{p.name}</span>
                      </div>
                      <span className="font-mono text-[10px] text-zinc-500 shrink-0">{p.status}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          </TechnicalDetailsDrawer>
        </div>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(specs)}
        requirementHint="Wait for full hardware scan to complete before advancing."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
