import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BatteryCharging, CheckCircle2, Plug, RefreshCw, Unplug, Zap } from "lucide-react";
import type { BatteryHealthReport, BatteryLiveSample, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface BatteryViewProps {
  report: BatteryHealthReport | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefresh: () => void;
  onUpdateStatus: (status: TestStatus, summary: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const BatteryView: React.FC<BatteryViewProps> = ({
  report,
  loading,
  status,
  stepNumber,
  totalSteps,
  onRefresh,
  onUpdateStatus,
  onNext,
  onSkip,
}) => {
  const [monitoring, setMonitoring] = useState(false);
  const [samples, setSamples] = useState<BatteryLiveSample[]>([]);
  const [dischargeVerified, setDischargeVerified] = useState(false);
  const [chargeVerified, setChargeVerified] = useState(false);
  const [verdictLocked, setVerdictLocked] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (monitoring) {
      invoke("start_battery_monitor").catch(() => {});
      listen<BatteryLiveSample>("battery:sample", (ev) => {
        const s = ev.payload;
        setSamples((prev) => [...prev.slice(-59), s]);
        if (!s.acPlugged) setDischargeVerified(true);
        if (s.acPlugged && (s.isCharging || s.chargePercent >= 98)) setChargeVerified(true);
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
      if (monitoring) invoke("stop_battery_monitor").catch(() => {});
    };
  }, [monitoring]);

  const latest = samples[samples.length - 1];
  const currentAc = latest ? latest.acPlugged : report?.acPlugged ?? false;
  const currentCharging = latest ? latest.isCharging : report?.isCharging ?? false;
  const currentPct = latest ? latest.chargePercent : report?.currentChargePercent ?? 0;
  const currentWatts =
    latest?.watts != null
      ? latest.watts
      : report?.rateMw != null
      ? Number((report.rateMw / 1000).toFixed(2))
      : null;

  const finalizeVerdict = (forcedStatus: TestStatus) => {
    setVerdictLocked(true);
    const healthTxt = report?.healthPercent != null ? `${report.healthPercent.toFixed(1)}% health` : "Detected";
    const cycleTxt = report?.cycleCount != null ? `, ${report.cycleCount} cycles` : "";
    const liveTxt =
      chargeVerified && dischargeVerified
        ? " | Live Charge & Discharge Verified"
        : chargeVerified
        ? " | Charge Verified"
        : dischargeVerified
        ? " | Discharge Verified"
        : "";
    onUpdateStatus(forcedStatus, `${healthTxt}${cycleTxt}${liveTxt}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Battery Health &amp; Live Charge / Discharge
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Inspect Design vs Full capacity, wear %, cycle count, and verify live AC charging &amp; battery-only discharge wattage.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Refresh
        </button>
      </div>

      {!report ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-10 text-center text-sm text-zinc-600">
          {loading ? "Reading battery firmware telemetry..." : "Click Refresh to inspect battery."}
        </div>
      ) : !report.present ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-8 text-center space-y-2">
          <BatteryCharging className="w-8 h-8 text-zinc-400 mx-auto" />
          <div className="text-base font-bold text-black">No Internal Battery Detected</div>
          <div className="text-xs text-zinc-600">{report.notes}</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="text-xs text-zinc-500">Battery Health</div>
              <div className="text-2xl font-black mt-1 font-mono text-blue-600">
                {report.healthPercent != null ? `${report.healthPercent.toFixed(1)}%` : "N/A"}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1 font-mono">
                Wear: {report.wearPercent != null ? `${report.wearPercent.toFixed(1)}%` : "N/A"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="text-xs text-zinc-500">Cycle Count</div>
              <div className="text-2xl font-black mt-1 font-mono text-black">
                {report.cycleCount != null ? report.cycleCount : "N/A"}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">
                {report.manufacturer} ({report.chemistry})
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="text-xs text-zinc-500">Full / Design Capacity</div>
              <div className="text-lg font-black mt-1 font-mono text-black">
                {report.fullChargeCapacityMwh != null
                  ? `${(report.fullChargeCapacityMwh / 1000).toFixed(1)} Wh`
                  : "N/A"}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1 font-mono">
                Design:{" "}
                {report.designCapacityMwh != null
                  ? `${(report.designCapacityMwh / 1000).toFixed(1)} Wh`
                  : "N/A"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="text-xs text-zinc-500">Live Charge State</div>
              <div className="text-2xl font-black mt-1 font-mono text-black">{currentPct.toFixed(0)}%</div>
              <div className="text-[11px] text-blue-700 font-semibold mt-1">
                {currentAc ? (currentCharging ? "AC Charging" : "AC Plugged") : "On Battery"}
                {report.adapterWatts ? ` • ${report.adapterWatts}W` : ""}
              </div>
            </div>
          </div>

          {/* Live Guided Charge & Discharge */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-sm font-bold text-black flex items-center gap-2">
                  <Zap className="w-4 h-4 text-blue-600" />
                  Live Charge &amp; Discharge Verification
                </h2>
                <p className="text-xs text-zinc-600 mt-0.5">
                  Start the monitor, unplug AC power to confirm stable discharge, then replug to verify charging wattage.
                </p>
              </div>
              <button
                onClick={() => setMonitoring((m) => !m)}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition cursor-pointer ${
                  monitoring
                    ? "bg-black hover:bg-zinc-800 text-white"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {monitoring ? "Stop Live Monitor" : "Start Live Monitor"}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div
                className={`rounded-xl border p-3.5 flex items-center justify-between ${
                  dischargeVerified ? "bg-blue-50 border-blue-600" : "bg-zinc-50 border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Unplug className={`w-5 h-5 ${dischargeVerified ? "text-blue-600" : "text-zinc-500"}`} />
                  <div>
                    <div className="text-xs font-bold text-black">Step A: Unplug Charger (Discharge)</div>
                    <div className="text-[11px] text-zinc-600">
                      {dischargeVerified ? "Verified battery-only discharge." : "Unplug AC power while monitor is active."}
                    </div>
                  </div>
                </div>
                {dischargeVerified && <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />}
              </div>

              <div
                className={`rounded-xl border p-3.5 flex items-center justify-between ${
                  chargeVerified ? "bg-blue-50 border-blue-600" : "bg-zinc-50 border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Plug className={`w-5 h-5 ${chargeVerified ? "text-blue-600" : "text-zinc-500"}`} />
                  <div>
                    <div className="text-xs font-bold text-black">Step B: Plug Charger (AC Charge)</div>
                    <div className="text-[11px] text-zinc-600">
                      {chargeVerified ? "Verified AC adapter & charging." : "Plug in AC/USB-C charger while monitor is active."}
                    </div>
                  </div>
                </div>
                {chargeVerified && <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />}
              </div>
            </div>

            <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="space-y-1 font-mono text-xs">
                <div className="text-zinc-600">
                  Live Power Rate:{" "}
                  <span className="text-lg font-black text-blue-700">
                    {currentWatts != null ? `${currentWatts > 0 ? "+" : ""}${currentWatts.toFixed(2)} W` : "—"}
                  </span>
                </div>
                <div className="text-zinc-600">
                  Voltage:{" "}
                  <strong className="text-black">
                    {(latest?.voltageMv ?? report.voltageMv) != null
                      ? `${((latest?.voltageMv ?? report.voltageMv ?? 0) / 1000).toFixed(2)} V`
                      : "—"}
                  </strong>
                  {" • "}Samples: <strong className="text-black">{samples.length}</strong>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => finalizeVerdict("pass")}
                  className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer"
                >
                  Confirm PASS
                </button>
                <button
                  onClick={() => finalizeVerdict("warn")}
                  className="px-3.5 py-2 rounded-lg border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 text-xs font-bold cursor-pointer"
                >
                  Mark WARN
                </button>
                <button
                  onClick={() => finalizeVerdict("fail")}
                  className="px-3.5 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-bold cursor-pointer"
                >
                  Mark FAIL
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={verdictLocked || !report?.present || (dischargeVerified && chargeVerified)}
        requirementHint="Run live charge/discharge check and click Confirm PASS/WARN/FAIL (or Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
