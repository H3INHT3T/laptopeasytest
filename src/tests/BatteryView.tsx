import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BatteryCharging, CheckCircle2, Plug, RefreshCw, Unplug, Zap } from "lucide-react";
import type { BatteryHealthReport, BatteryLiveSample, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface BatteryViewProps {
  report: BatteryHealthReport | null;
  loading: boolean;
  status: TestStatus;
  onRefresh: () => void;
  onUpdateStatus: (status: TestStatus, summary: string) => void;
  onNext?: () => void;
}

export const BatteryView: React.FC<BatteryViewProps> = ({
  report,
  loading,
  status,
  onRefresh,
  onUpdateStatus,
  onNext,
}) => {
  const [monitoring, setMonitoring] = useState(false);
  const [samples, setSamples] = useState<BatteryLiveSample[]>([]);
  const [dischargeVerified, setDischargeVerified] = useState(false);
  const [chargeVerified, setChargeVerified] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (monitoring) {
      invoke("start_battery_monitor").catch(() => {});
      listen<BatteryLiveSample>("battery:sample", (ev) => {
        const s = ev.payload;
        setSamples((prev) => [...prev.slice(-59), s]);
        if (!s.acPlugged) {
          setDischargeVerified(true);
        }
        if (s.acPlugged && (s.isCharging || s.chargePercent >= 98)) {
          setChargeVerified(true);
        }
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
      if (monitoring) {
        invoke("stop_battery_monitor").catch(() => {});
      }
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

  const finalizeBatteryVerdict = (forcedStatus?: TestStatus) => {
    const baseSt = forcedStatus ?? report?.status ?? "pass";
    const healthTxt = report?.healthPercent != null ? `${report.healthPercent.toFixed(1)}% health` : "Health detected";
    const cycleTxt = report?.cycleCount != null ? `, ${report.cycleCount} cycles` : "";
    const liveTxt =
      chargeVerified && dischargeVerified
        ? " | Live Charge & Discharge Verified"
        : chargeVerified
        ? " | Charge Verified"
        : dischargeVerified
        ? " | Discharge Verified"
        : "";
    onUpdateStatus(baseSt, `${healthTxt}${cycleTxt}${liveTxt}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Battery Health &amp; Charge/Discharge</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Inspect Design vs Full capacity, wear %, cycle count, and verify live AC charging &amp; battery discharge wattage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
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

      {!report ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-400">
          {loading ? "Reading battery firmware telemetry..." : "Click Refresh to scan battery."}
        </div>
      ) : !report.present ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-6 text-center space-y-2">
          <BatteryCharging className="w-8 h-8 text-slate-500 mx-auto" />
          <div className="text-base font-bold text-white">No Internal Battery Detected</div>
          <div className="text-xs text-slate-400">{report.notes}</div>
        </div>
      ) : (
        <>
          {/* Health Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">Battery Health</div>
              <div
                className={`text-2xl font-bold mt-1 font-mono ${
                  (report.healthPercent ?? 100) >= 80
                    ? "text-emerald-400"
                    : (report.healthPercent ?? 100) >= 65
                    ? "text-amber-400"
                    : "text-rose-400"
                }`}
              >
                {report.healthPercent != null ? `${report.healthPercent.toFixed(1)}%` : "N/A"}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Wear: {report.wearPercent != null ? `${report.wearPercent.toFixed(1)}%` : "N/A"}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">Cycle Count</div>
              <div className="text-2xl font-bold mt-1 font-mono text-white">
                {report.cycleCount != null ? report.cycleCount : "N/A"}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {report.manufacturer} ({report.chemistry})
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">Full / Design Capacity</div>
              <div className="text-lg font-bold mt-1 font-mono text-cyan-300">
                {report.fullChargeCapacityMwh != null
                  ? `${(report.fullChargeCapacityMwh / 1000).toFixed(1)} Wh`
                  : "N/A"}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Design:{" "}
                {report.designCapacityMwh != null
                  ? `${(report.designCapacityMwh / 1000).toFixed(1)} Wh`
                  : "N/A"}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">Current Charge &amp; Power</div>
              <div className="text-2xl font-bold mt-1 font-mono text-white">
                {currentPct.toFixed(0)}%
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {currentAc ? (currentCharging ? "AC Charging" : "AC Plugged") : "On Battery"}
                {report.adapterWatts ? ` • ${report.adapterWatts}W Adapter` : ""}
              </div>
            </div>
          </div>

          {/* Guided Live Charge & Discharge Test */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Guided Live Charge &amp; Discharge Verification
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Start live monitoring, unplug the AC charger to verify stable battery discharge, then replug to confirm AC charging wattage.
                </p>
              </div>
              <button
                onClick={() => setMonitoring((m) => !m)}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition ${
                  monitoring
                    ? "bg-rose-500/20 border border-rose-500/50 text-rose-200 hover:bg-rose-500/30"
                    : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
                }`}
              >
                {monitoring ? "Stop Live Monitor" : "Start Live Charge/Discharge Monitor"}
              </button>
            </div>

            {/* Two Step Guided Badges */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div
                className={`rounded-xl border p-3.5 flex items-center justify-between ${
                  dischargeVerified
                    ? "bg-emerald-500/10 border-emerald-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Unplug className={`w-5 h-5 ${dischargeVerified ? "text-emerald-400" : "text-slate-400"}`} />
                  <div>
                    <div className="text-xs font-bold text-white">Step 1: Unplug Charger (Discharge)</div>
                    <div className="text-[11px] text-slate-400">
                      {dischargeVerified
                        ? "Observed stable battery-only discharge."
                        : "Unplug AC power while live monitor is running."}
                    </div>
                  </div>
                </div>
                {dischargeVerified && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
              </div>

              <div
                className={`rounded-xl border p-3.5 flex items-center justify-between ${
                  chargeVerified
                    ? "bg-emerald-500/10 border-emerald-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Plug className={`w-5 h-5 ${chargeVerified ? "text-emerald-400" : "text-slate-400"}`} />
                  <div>
                    <div className="text-xs font-bold text-white">Step 2: Plug Charger (AC Charge)</div>
                    <div className="text-[11px] text-slate-400">
                      {chargeVerified
                        ? "Observed AC adapter power & charging state."
                        : "Plug in AC/USB-C charger while monitor is running."}
                    </div>
                  </div>
                </div>
                {chargeVerified && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
              </div>
            </div>

            {/* Live Wattage Readout & Mini Chart */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="space-y-1 font-mono text-xs">
                <div className="text-slate-400">
                  Live Power Rate:{" "}
                  <span className="text-lg font-bold text-cyan-300">
                    {currentWatts != null ? `${currentWatts > 0 ? "+" : ""}${currentWatts.toFixed(2)} W` : "—"}
                  </span>
                </div>
                <div className="text-slate-400">
                  Voltage:{" "}
                  <span className="text-slate-200">
                    {(latest?.voltageMv ?? report.voltageMv) != null
                      ? `${((latest?.voltageMv ?? report.voltageMv ?? 0) / 1000).toFixed(2)} V`
                      : "—"}
                  </span>
                  {" • "}Samples: <span className="text-slate-200">{samples.length}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => finalizeBatteryVerdict("pass")}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold"
                >
                  Approve PASS
                </button>
                <button
                  onClick={() => finalizeBatteryVerdict("warn")}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-xs font-semibold"
                >
                  Mark WARN
                </button>
                <button
                  onClick={() => finalizeBatteryVerdict("fail")}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 text-xs font-semibold"
                >
                  Mark FAIL
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
