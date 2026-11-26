import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Play,
  Plug,
  RefreshCw,
  Square,
  Unplug,
  Zap,
} from "lucide-react";
import {
  BATTERY_DISCHARGE_MAX_SECS,
  BATTERY_LOW_SOC_ABORT_PCT,
  type BatteryDischargeProgress,
  type BatteryDischargeResult,
  type BatteryHealthReport,
  type BatteryLiveSample,
  type BatterySagProgress,
  type BatterySagResult,
  type SystemSpecs,
  type TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { NovabenchScoreBar } from "../components/NovabenchScoreBar";

interface BatteryViewProps {
  report: BatteryHealthReport | null;
  sagResult: BatterySagResult | null;
  dischargeResult?: BatteryDischargeResult | null;
  specs?: SystemSpecs | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefresh: () => void;
  onSagComplete: (res: BatterySagResult) => void;
  onDischargeComplete?: (res: BatteryDischargeResult) => void;
  onUpdateStatus: (status: TestStatus, summary: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const BatteryView: React.FC<BatteryViewProps> = ({
  report,
  sagResult,
  dischargeResult,
  specs,
  loading,
  status,
  stepNumber,
  totalSteps,
  onRefresh,
  onSagComplete,
  onDischargeComplete,
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

  // Two-Phase Battery Discharge Normality state (R3)
  const [dischargeRunning, setDischargeRunning] = useState(false);
  const [dischargeDur, setDischargeDur] = useState<number>(55);
  const [dischargeProg, setDischargeProg] = useState<BatteryDischargeProgress | null>(null);
  const [dischargeWattHistory, setDischargeWattHistory] = useState<number[]>([]);
  const [dischargeVoltHistory, setDischargeVoltHistory] = useState<number[]>([]);
  const [dischargeError, setDischargeError] = useState<string | null>(null);

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
    let unlistenSag: (() => void) | null = null;
    let unlistenDischarge: (() => void) | null = null;

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
      unlistenSag = fn;
    });

    listen<BatteryDischargeProgress>("battery:discharge", (ev) => {
      const p = ev.payload;
      setDischargeProg(p);
      if (p.watts != null) {
        setDischargeWattHistory((prev) => [...prev.slice(-89), Math.abs(p.watts!)]);
      }
      if (p.voltageMv != null) {
        setDischargeVoltHistory((prev) => [
          ...prev.slice(-89),
          Number((p.voltageMv! / 1000).toFixed(3)),
        ]);
      }
    }).then((fn) => {
      unlistenDischarge = fn;
    });

    return () => {
      if (unlistenSag) unlistenSag();
      if (unlistenDischarge) unlistenDischarge();
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

  const startDischargeTest = async () => {
    setDischargeError(null);
    setDischargeRunning(true);
    setDischargeProg(null);
    setDischargeWattHistory([]);
    setDischargeVoltHistory([]);
    try {
      const boundedDur = Math.max(20, Math.min(BATTERY_DISCHARGE_MAX_SECS, dischargeDur));
      const res = await invoke<BatteryDischargeResult>("run_battery_discharge_test", {
        durationSecs: boundedDur,
      });
      if (res.samples && res.samples.length > 0) {
        const sampleWatts = res.samples
          .map((s) => (s.watts != null ? Math.abs(s.watts) : null))
          .filter((v): v is number => v != null);
        const sampleVolts = res.samples
          .map((s) => (s.voltageMv != null ? Number((s.voltageMv / 1000).toFixed(3)) : null))
          .filter((v): v is number => v != null);
        setDischargeWattHistory((prev) => (prev.length >= sampleWatts.length ? prev : sampleWatts));
        setDischargeVoltHistory((prev) => (prev.length >= sampleVolts.length ? prev : sampleVolts));
      }
      onDischargeComplete?.(res);
    } catch (e) {
      setDischargeError(String(e));
    } finally {
      setDischargeRunning(false);
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

  const isLowBatteryPreFlight = report?.present && currentPct <= BATTERY_LOW_SOC_ABORT_PCT;

  const effectiveDischargeWatts =
    dischargeWattHistory.length > 0
      ? dischargeWattHistory
      : (dischargeResult?.samples ?? [])
          .map((s) => (s.watts != null ? Math.abs(s.watts) : null))
          .filter((v): v is number => v != null);

  const effectiveDischargeVolts =
    dischargeVoltHistory.length > 0
      ? dischargeVoltHistory
      : (dischargeResult?.samples ?? [])
          .map((s) => (s.voltageMv != null ? Number((s.voltageMv / 1000).toFixed(3)) : null))
          .filter((v): v is number => v != null);

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
    const dischargeTxt = dischargeResult
      ? ` | Discharge Normality: ${dischargeResult.verdict} (${dischargeResult.plainSummary})`
      : "";
    onUpdateStatus(forcedStatus, `${healthTxt}${cycleTxt}${liveTxt}${sagTxt}${dischargeTxt}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Battery Health &amp; Discharge
              <span className="sr-only"> — Battery Health, Discharge Normality &amp; Voltage-Sag Load Pulse</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps}
            {specs?.model ? ` • ${specs.manufacturer} ${specs.model}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-4 py-2 rounded-xl border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black inline-flex items-center gap-1.5 cursor-pointer"
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
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-8 text-center space-y-2.5">
          <BatteryCharging className="w-7 h-7 text-zinc-500 mx-auto" />
          <div className="text-sm font-black text-black">No Internal Battery Detected</div>
          <div className="inline-block px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[10.5px] font-bold text-black">
            NOT_APPLICABLE — AC-Only / Desktop Configuration
          </div>
          <div className="text-xs text-zinc-600 max-w-lg mx-auto">
            {report.notes || "No internal battery was reported by ACPI/SMBus firmware. Battery Discharge Normality is NOT_APPLICABLE for this device."}
          </div>
        </div>
      ) : (
        <>
          <NovabenchScoreBar
            scoreLabel="HEALTH"
            scoreValue={report.healthPercent != null ? `${report.healthPercent.toFixed(0)}%` : "OK"}
            title={`Battery Health — ${report.manufacturer} (${report.chemistry})`}
            takeaway={
              report.healthPercent != null
                ? report.healthPercent >= 80
                  ? `Healthy battery holding ${report.healthPercent.toFixed(1)}% of original factory capacity (${report.cycleCount ?? "—"} cycles).`
                  : `Noticeable battery wear (${report.healthPercent.toFixed(1)}% remaining). Plan for replacement if long unplugged runtime is required.`
                : "Battery detected and reporting live charge telemetry."
            }
            percent={report.healthPercent ?? 85}
            medianLabel="Healthy Resale Threshold"
            medianPercent={80}
            badge={
              dischargeResult
                ? `Discharge: ${dischargeResult.verdict}`
                : report.cycleCount != null
                ? `${report.cycleCount} Cycles`
                : undefined
            }
            monochrome={(report.healthPercent ?? 100) < 75 || dischargeResult?.verdict === "ABNORMAL"}
          />

          <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl border border-zinc-200 overflow-hidden divide-x divide-y md:divide-y-0 divide-zinc-200 bg-white font-mono tabular-nums">
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

          {/* Two-Phase Battery Discharge Normality Test (R3) */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-xs font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                  <Activity className="w-4 h-4 text-blue-600" />
                  Battery Discharge Normality Test (Idle -&gt; Load Stability Audit)
                </h2>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Samples live discharge wattage, voltage sag, 5-second SoC cliffs, and BMS capacity drift across an idle baseline and controlled load phase (max {BATTERY_DISCHARGE_MAX_SECS}s, auto-aborts at &le;{BATTERY_LOW_SOC_ABORT_PCT}% SoC).
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={dischargeDur}
                  disabled={dischargeRunning}
                  onChange={(e) => setDischargeDur(Number(e.target.value))}
                  aria-label="Discharge test duration"
                  className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value={30}>Quick Audit (30s)</option>
                  <option value={45}>Balanced Audit (45s)</option>
                  <option value={55}>Standard Normality (55s)</option>
                  <option value={90}>Extended Audit (90s max)</option>
                </select>
                {dischargeRunning ? (
                  <button
                    type="button"
                    onClick={() => invoke("cancel_battery_discharge_test").catch(() => {})}
                    className="px-4 py-1.5 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Abort Discharge Test
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startDischargeTest}
                    disabled={sagRunning}
                    className="px-4 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Run Discharge Normality Test
                  </button>
                )}
              </div>
            </div>

            {currentAc && !dischargeRunning && (
              <div className="rounded-[2px] border border-black bg-[#F8FAFC] px-3 py-2 flex items-center gap-2 text-xs text-black">
                <Unplug className="w-4 h-4 text-blue-600 shrink-0" />
                <span>
                  <strong>AC Charger Detected:</strong> Unplug AC power before running the discharge normality test so the battery discharges naturally (running while plugged in will report <span className="font-mono font-bold">AC_CONNECTED</span>).
                </span>
              </div>
            )}

            {isLowBatteryPreFlight && !dischargeRunning && (
              <div className="rounded-[2px] border border-black bg-black text-white px-3 py-2 flex items-center gap-2 text-xs">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                <span>
                  <strong>Low Battery Guard ({currentPct.toFixed(0)}% &le; {BATTERY_LOW_SOC_ABORT_PCT}%):</strong> Charge above {BATTERY_LOW_SOC_ABORT_PCT}% before running to prevent deep-discharge shutdown (starting below {BATTERY_LOW_SOC_ABORT_PCT}% returns <span className="font-mono font-bold">ABORTED_LOW_BATTERY</span>).
                </span>
              </div>
            )}

            {dischargeError && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">
                {dischargeError}
              </div>
            )}

            {dischargeRunning && dischargeProg && (
              <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-3 space-y-2 font-mono text-xs tabular-nums">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="font-bold text-blue-700 uppercase">
                    PHASE: {dischargeProg.phase} ({dischargeProg.acPlugged ? "AC PLUGGED" : "ON BATTERY"})
                  </span>
                  <span className="text-black font-bold">
                    {dischargeProg.elapsedSecs.toFixed(0)}s / {dischargeProg.durationSecs}s •{" "}
                    {dischargeProg.watts != null ? `${Math.abs(dischargeProg.watts).toFixed(1)} W` : "— W"} •{" "}
                    SoC {dischargeProg.chargePercent.toFixed(1)}% • Sag {dischargeProg.voltageSagMv} mV • Drop -{dischargeProg.chargeDropPct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-200 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        (dischargeProg.elapsedSecs / Math.max(dischargeProg.durationSecs, 1)) * 100
                      )}%`,
                    }}
                  />
                </div>
                {dischargeProg.note && (
                  <div className="font-sans text-[11px] text-zinc-700">{dischargeProg.note}</div>
                )}
              </div>
            )}

            {(effectiveDischargeWatts.length > 0 || effectiveDischargeVolts.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <LiveChart
                  title="Idle -> Load Discharge Power Draw"
                  unit="W"
                  data={effectiveDischargeWatts}
                  plainHint="Steady idle watts followed by consistent load watts indicates healthy VRM & cell delivery."
                />
                <LiveChart
                  title="Battery Pack Voltage Stability"
                  unit="V"
                  data={effectiveDischargeVolts}
                  higherIsBetter={false}
                  plainHint="Sharp voltage collapses under load signal high internal cell resistance."
                />
              </div>
            )}

            {dischargeResult && !dischargeRunning && (
              <div
                className={`rounded-[2px] border p-3.5 space-y-3 ${
                  dischargeResult.verdict === "ABNORMAL" || dischargeResult.status === "fail"
                    ? "border-black bg-black text-white"
                    : dischargeResult.verdict === "NORMAL"
                    ? "border-blue-600 bg-[#F8FAFC] text-black"
                    : "border-black bg-white text-black"
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`px-2 py-0.5 rounded-[2px] font-mono text-xs font-black uppercase ${
                          dischargeResult.verdict === "ABNORMAL"
                            ? "bg-white text-black"
                            : dischargeResult.verdict === "NORMAL"
                            ? "bg-blue-600 text-white"
                            : "bg-black text-white"
                        }`}
                      >
                        {dischargeResult.verdict}
                      </span>
                      <StatusBadge
                        status={dischargeResult.status}
                        darkSurface={dischargeResult.verdict === "ABNORMAL" || dischargeResult.status === "fail"}
                        compact
                      />
                      <span className="font-mono text-[10.5px] opacity-80 tabular-nums">
                        {dischargeResult.socStartPct.toFixed(1)}% -&gt; {dischargeResult.socEndPct.toFixed(1)}% ({dischargeResult.durationSecs.toFixed(0)}s)
                      </span>
                    </div>
                    <div className="text-xs font-medium leading-relaxed">
                      {dischargeResult.plainSummary}
                    </div>
                  </div>
                </div>

                <div
                  className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 border divide-x divide-y md:divide-y-0 font-mono tabular-nums text-xs ${
                    dischargeResult.verdict === "ABNORMAL" || dischargeResult.status === "fail"
                      ? "border-zinc-700 divide-zinc-700 bg-zinc-900"
                      : "border-zinc-300 divide-zinc-200 bg-white"
                  }`}
                >
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Idle Avg</div>
                    <div className="font-black mt-0.5">{dischargeResult.idleAvgWatts.toFixed(1)} W</div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Load Avg</div>
                    <div className="font-black mt-0.5">{dischargeResult.loadAvgWatts.toFixed(1)} W</div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Power CV</div>
                    <div className="font-black mt-0.5">{dischargeResult.powerCvPct.toFixed(1)}%</div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Voltage Sag</div>
                    <div className="font-black mt-0.5">{dischargeResult.voltageSagMv.toFixed(0)} mV</div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Max 5s Cliff</div>
                    <div className="font-black mt-0.5">{dischargeResult.maxStepDropPct.toFixed(1)}%</div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase opacity-70">Wear / BMS Drift</div>
                    <div className="font-black mt-0.5">
                      {dischargeResult.wearPct.toFixed(1)}% • {dischargeResult.cycleCount}c • {dischargeResult.bmsDriftRatio.toFixed(2)}x
                    </div>
                  </div>
                </div>

                {dischargeResult.reasons.length > 0 && (
                  <div className="space-y-1 text-xs">
                    <div className="font-mono text-[9.5px] font-bold uppercase tracking-wider opacity-75">
                      Diagnostic Reasoning
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {dischargeResult.reasons.map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
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
                  disabled={dischargeRunning}
                  className="px-4 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
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
        canProceed={
          verdictLocked ||
          !report?.present ||
          (dischargeVerified && chargeVerified) ||
          Boolean(dischargeResult && !dischargeRunning)
        }
        requirementHint="Run the Discharge Normality Test, 15s Sag Pulse, or live charge/discharge check and record verdict (or Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
