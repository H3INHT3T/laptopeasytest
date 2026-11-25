import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  BatteryCharging,
  CheckCircle2,
  Play,
  Plug,
  RefreshCw,
  Square,
  Unplug,
  Zap,
} from "lucide-react";
import type {
  BatteryHealthReport,
  BatteryLiveSample,
  BatterySagProgress,
  BatterySagResult,
  TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";

interface BatteryViewProps {
  report: BatteryHealthReport | null;
  sagResult: BatterySagResult | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefresh: () => void;
  onSagComplete: (res: BatterySagResult) => void;
  onUpdateStatus: (status: TestStatus, summary: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const BatteryView: React.FC<BatteryViewProps> = ({
  report,
  sagResult,
  loading,
  status,
  stepNumber,
  totalSteps,
  onRefresh,
  onSagComplete,
  onUpdateStatus,
  onNext,
  onSkip,
}) => {
  const [monitoring, setMonitoring] = useState(false);
  const [samples, setSamples] = useState<BatteryLiveSample[]>([]);
  const [dischargeVerified, setDischargeVerified] = useState(false);
  const [chargeVerified, setChargeVerified] = useState(false);
  const [verdictLocked, setVerdictLocked] = useState(false);

  // Voltage-Sag Load Pulse state
  const [sagRunning, setSagRunning] = useState(false);
  const [sagProg, setSagProg] = useState<BatterySagProgress | null>(null);
  const [sagVoltHistory, setSagVoltHistory] = useState<number[]>([]);
  const [sagWattHistory, setSagWattHistory] = useState<number[]>([]);
  const [sagError, setSagError] = useState<string | null>(null);

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

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<BatterySagProgress>("battery:sag", (ev) => {
      const p = ev.payload;
      setSagProg(p);
      if (p.voltageMv != null) {
        setSagVoltHistory((prev) => [...prev.slice(-59), Number((p.voltageMv! / 1000).toFixed(3))]);
      }
      if (p.watts != null) {
        setSagWattHistory((prev) => [...prev.slice(-59), Math.abs(p.watts!)]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startSagPulse = async () => {
    setSagError(null);
    setSagRunning(true);
    setSagVoltHistory([]);
    setSagWattHistory([]);
    setSagProg(null);
    try {
      const res = await invoke<BatterySagResult>("run_battery_sag_pulse", { durationSecs: 15 });
      onSagComplete(res);
    } catch (e) {
      setSagError(String(e));
    } finally {
      setSagRunning(false);
    }
  };

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
        ? " | Charge & Discharge Verified"
        : chargeVerified
        ? " | Charge Verified"
        : dischargeVerified
        ? " | Discharge Verified"
        : "";
    const sagTxt = sagResult
      ? ` | Load Pulse: -${sagResult.chargeDropPct.toFixed(1)}% / ${sagResult.maxVoltageSagMv}mV sag`
      : "";
    onUpdateStatus(forcedStatus, `${healthTxt}${cycleTxt}${liveTxt}${sagTxt}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              Battery Health, Live Charge/Discharge &amp; Voltage-Sag Load Pulse
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Inspect Design vs. Full capacity, cycle count, live AC wattage, and run a 15-second controlled load pulse on battery to catch cells that collapse under load.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Refresh
        </button>
      </div>

      {!report ? (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-8 text-center font-mono text-xs text-zinc-600">
          {loading ? "READING BATTERY FIRMWARE TELEMETRY..." : "CLICK REFRESH TO INSPECT BATTERY."}
        </div>
      ) : !report.present ? (
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-8 text-center space-y-2">
          <BatteryCharging className="w-7 h-7 text-zinc-400 mx-auto" />
          <div className="text-sm font-bold text-black">No Internal Battery Detected</div>
          <div className="text-xs text-zinc-600">{report.notes}</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 border border-zinc-300 divide-x divide-y md:divide-y-0 divide-zinc-200 bg-white font-mono tabular-nums">
            <div className="p-3.5">
              <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Battery Health</div>
              <div className="text-2xl font-black mt-0.5 text-blue-700">
                {report.healthPercent != null ? `${report.healthPercent.toFixed(1)}%` : "N/A"}
              </div>
              <div className="text-[10.5px] text-zinc-500">
                Wear: {report.wearPercent != null ? `${report.wearPercent.toFixed(1)}%` : "N/A"}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Cycle Count</div>
              <div className="text-2xl font-black mt-0.5 text-black">
                {report.cycleCount != null ? report.cycleCount : "N/A"}
              </div>
              <div className="text-[10.5px] text-zinc-500">
                {report.manufacturer} ({report.chemistry})
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Full / Design Wh</div>
              <div className="text-lg font-black mt-1 text-black">
                {report.fullChargeCapacityMwh != null
                  ? `${(report.fullChargeCapacityMwh / 1000).toFixed(1)} Wh`
                  : "N/A"}
              </div>
              <div className="text-[10.5px] text-zinc-500">
                Design: {report.designCapacityMwh != null ? `${(report.designCapacityMwh / 1000).toFixed(1)} Wh` : "N/A"}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Live State</div>
              <div className="text-2xl font-black mt-0.5 text-black">{currentPct.toFixed(0)}%</div>
              <div className="text-[10.5px] text-blue-700 font-bold">
                {currentAc ? (currentCharging ? "AC CHARGING" : "AC PLUGGED") : "ON BATTERY"}
                {report.adapterWatts ? ` • ${report.adapterWatts}W` : ""}
              </div>
            </div>
          </div>

          {/* 15-Second Battery Voltage-Sag Load Pulse */}
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-xs font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                  <Activity className="w-4 h-4 text-blue-600" />
                  15-Second Battery Voltage-Sag Load Pulse (Bad-Cell Detector)
                </h2>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Unplug AC power first, then run a 15s controlled multi-core load pulse. Healthy cells hold steady; worn cells sag &gt;1.2V or drop &gt;8% instantly.
                </p>
              </div>
              {sagRunning ? (
                <button
                  onClick={() => invoke("cancel_battery_sag_pulse").catch(() => {})}
                  className="px-4 py-1.5 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" /> Abort Pulse
                </button>
              ) : (
                <button
                  onClick={startSagPulse}
                  className="px-4 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" /> Run 15s Sag Pulse
                </button>
              )}
            </div>

            {sagError && <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{sagError}</div>}

            {sagRunning && sagProg && (
              <div className="space-y-1.5 font-mono text-xs tabular-nums">
                <div className="flex justify-between font-bold">
                  <span className="text-blue-700">
                    PULSING LOAD ({sagProg.acPlugged ? "AC PLUGGED — UNPLUG FOR CELL TEST" : "ON BATTERY"})
                  </span>
                  <span className="text-black">
                    {sagProg.elapsedSecs.toFixed(0)}s / {sagProg.durationSecs}s • SAG: {sagProg.voltageDropMv} mV • DROP: -{sagProg.chargeDropPct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-200 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{ width: `${Math.min(100, (sagProg.elapsedSecs / sagProg.durationSecs) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {(sagVoltHistory.length > 0 || sagWattHistory.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {sagVoltHistory.length > 0 && (
                  <LiveChart title="Battery Cell Voltage Under Load" unit="V" data={sagVoltHistory} />
                )}
                {sagWattHistory.length > 0 && (
                  <LiveChart title="Discharge Power Draw" unit="W" data={sagWattHistory} />
                )}
              </div>
            )}

            {sagResult && !sagRunning && (
              <div
                className={`rounded-[2px] border px-3.5 py-2.5 font-mono text-xs flex items-center justify-between gap-2 ${
                  sagResult.status === "fail"
                    ? "bg-black text-white border-black"
                    : "bg-[#F8FAFC] text-black border-blue-600"
                }`}
              >
                <span>{sagResult.summary}</span>
                <StatusBadge status={sagResult.status} darkSurface={sagResult.status === "fail"} compact />
              </div>
            )}
          </div>

          {/* Live Guided Charge & Discharge */}
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3.5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-xs font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-blue-600" />
                  Live AC Charge &amp; Battery Discharge Verification
                </h2>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Start monitor, unplug AC power to confirm discharge, then replug to verify charging wattage.
                </p>
              </div>
              <button
                onClick={() => setMonitoring((m) => !m)}
                className={`px-3.5 py-1.5 rounded-[2px] font-mono text-xs font-bold uppercase transition cursor-pointer ${
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
                className={`rounded-[2px] border p-3 flex items-center justify-between ${
                  dischargeVerified ? "bg-blue-50/40 border-blue-600" : "bg-[#F8FAFC] border-zinc-300"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Unplug className={`w-4 h-4 ${dischargeVerified ? "text-blue-600" : "text-zinc-500"}`} />
                  <div>
                    <div className="text-xs font-bold text-black">Step A: Unplug Charger (Discharge)</div>
                    <div className="text-[11px] text-zinc-600">
                      {dischargeVerified ? "Verified battery-only discharge." : "Unplug AC power while monitor is active."}
                    </div>
                  </div>
                </div>
                {dischargeVerified && <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />}
              </div>

              <div
                className={`rounded-[2px] border p-3 flex items-center justify-between ${
                  chargeVerified ? "bg-blue-50/40 border-blue-600" : "bg-[#F8FAFC] border-zinc-300"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Plug className={`w-4 h-4 ${chargeVerified ? "text-blue-600" : "text-zinc-500"}`} />
                  <div>
                    <div className="text-xs font-bold text-black">Step B: Plug Charger (AC Charge)</div>
                    <div className="text-[11px] text-zinc-600">
                      {chargeVerified ? "Verified AC adapter & charging." : "Plug in AC/USB-C charger while monitor is active."}
                    </div>
                  </div>
                </div>
                {chargeVerified && <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />}
              </div>
            </div>

            <div className="rounded-[2px] bg-[#F8FAFC] border border-zinc-300 p-3.5 flex flex-col md:flex-row items-center justify-between gap-3">
              <div className="space-y-0.5 font-mono text-xs tabular-nums">
                <div className="text-zinc-600">
                  LIVE RATE:{" "}
                  <span className="text-base font-black text-blue-700">
                    {currentWatts != null ? `${currentWatts > 0 ? "+" : ""}${currentWatts.toFixed(2)} W` : "—"}
                  </span>
                </div>
                <div className="text-zinc-600 text-[11px]">
                  VOLTAGE:{" "}
                  <strong className="text-black">
                    {(latest?.voltageMv ?? report.voltageMv) != null
                      ? `${((latest?.voltageMv ?? report.voltageMv ?? 0) / 1000).toFixed(2)} V`
                      : "—"}
                  </strong>
                  {" • "}SAMPLES: <strong className="text-black">{samples.length}</strong>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => finalizeVerdict("pass")}
                  className="px-3.5 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase cursor-pointer"
                >
                  Confirm PASS
                </button>
                <button
                  onClick={() => finalizeVerdict("warn")}
                  className="px-3.5 py-1.5 rounded-[2px] border border-blue-600 bg-white hover:bg-blue-50 text-blue-700 font-mono text-xs font-bold uppercase cursor-pointer"
                >
                  Mark WARN
                </button>
                <button
                  onClick={() => finalizeVerdict("fail")}
                  className="px-3.5 py-1.5 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase cursor-pointer"
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
        requirementHint="Run live charge/discharge or 15s load pulse and click Confirm PASS/WARN/FAIL (or Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
