import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Fingerprint, RefreshCw, ScanFace, ShieldCheck, XCircle } from "lucide-react";
import type { BiometricAuthResult, BiometricsHardwareReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface BiometricsViewProps {
  hwReport: BiometricsHardwareReport | null;
  loading: boolean;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onRefresh: () => void | Promise<void>;
  onVerdict: (status: TestStatus, summary: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const BiometricsView: React.FC<BiometricsViewProps> = ({
  hwReport,
  loading,
  status,
  stepNumber,
  totalSteps,
  onRefresh,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const [prompting, setPrompting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [authResult, setAuthResult] = useState<BiometricAuthResult | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      setRefreshing(false);
    }
  };

  const triggerPrompt = async () => {
    setPrompting(true);
    try {
      const res = await invoke<BiometricAuthResult>("trigger_biometric_prompt");
      setAuthResult(res);
      onVerdict(res.status, res.message);
    } catch (e) {
      setAuthResult({ outcome: "Error", status: "warn", message: String(e) });
    } finally {
      setPrompting(false);
    }
  };

  const isSpinning = Boolean(loading || refreshing);
  const suggested = hwReport?.suggestedStatus;
  const hasAnySensor = Boolean(hwReport && (hwReport.fingerprintPresent || hwReport.faceIrPresent));
  const faultSensors = hwReport?.sensors.filter((s) => !s.driverOk) ?? [];

  let buyerTitle = "Awaiting Biometric Sensor Audit";
  let buyerText =
    "Run sensor detection or trigger a live OS biometric prompt to verify fingerprint / IR Face ID hardware health.";
  if (authResult?.outcome === "Verified") {
    buyerTitle = "Live Biometric Verification Passed";
    buyerText =
      "End-to-end OS biometric authentication succeeded. The sensor hardware, driver stack, and Windows Hello / Touch ID enclave are fully operational.";
  } else if (authResult?.outcome === "NotEnrolled") {
    buyerTitle = "Hardware Ready (Fresh OS — Not Enrolled)";
    buyerText =
      "Biometric hardware and OS services are healthy, and no prior user fingerprint or face profile is enrolled — expected on a freshly wiped second-hand laptop.";
  } else if (authResult?.outcome === "NotPresent") {
    buyerTitle = "No Biometric Sensor Equipped";
    buyerText =
      "OS reports no biometric hardware present. Confirm whether this model was sold without fingerprint/IR hardware (mark N/A or Skip Step), or inspect for a disconnected sensor if a pad is visibly built into the chassis.";
  } else if (faultSensors.length > 0 || suggested === "fail") {
    buyerTitle = "Biometric Driver / Hardware Fault Detected";
    buyerText =
      `Device Manager reported ${faultSensors.length || 1} sensor fault(s). Fingerprint/Face unlock may fail until the driver is repaired or the sensor ribbon/module is replaced.`;
  } else if (hwReport && !hasAnySensor && suggested === "notApplicable") {
    buyerTitle = "Non-Biometric Configuration (N/A)";
    buyerText =
      "No fingerprint reader or IR Face ID camera was detected. On non-biometric laptops this is normal — click Mark N/A or Skip Step. If a physical fingerprint pad is visibly present, check BIOS/Device Manager.";
  } else if (hwReport && hasAnySensor) {
    buyerTitle = "Biometric Hardware & Drivers Healthy";
    buyerText =
      "Sensor hardware and drivers passed Stage 1 inspection. Trigger the live OS prompt to test enrollment readiness, or Approve Hardware OK for freshly wiped units.";
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-xs font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Fingerprint &amp; Face ID Biometrics
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Two-stage check: inspects sensor hardware &amp; drivers first, then optionally triggers Windows Hello / macOS Touch ID.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isSpinning}
          className="px-3.5 py-2 rounded-[2px] border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSpinning ? "animate-spin text-blue-600" : ""}`} />
          {isSpinning ? "Scanning..." : "Detect Sensors"}
        </button>
      </div>

      <div className="rounded-[2px] border border-zinc-300 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-black flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            Stage 1: Biometric Hardware &amp; Driver Audit
          </h2>
          {hwReport && <StatusBadge status={hwReport.suggestedStatus} />}
        </div>

        {!hwReport ? (
          <div className="text-xs text-zinc-500 py-4">Scanning biometric sensors...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-[2px] bg-[#F8FAFC] border border-zinc-300 p-3.5 flex items-center gap-3">
                <Fingerprint className={`w-6 h-6 ${hwReport.fingerprintPresent ? "text-blue-600" : "text-zinc-400"}`} />
                <div>
                  <div className="text-xs font-bold text-black">
                    {hwReport.platform === "macOS" ? "Touch ID Sensor" : "Fingerprint Reader"}
                  </div>
                  <div className="text-[11px] text-zinc-600">
                    {hwReport.fingerprintPresent ? "Hardware Detected" : "Not Equipped / Not Found"}
                  </div>
                </div>
              </div>
              <div className="rounded-[2px] bg-[#F8FAFC] border border-zinc-300 p-3.5 flex items-center gap-3">
                <ScanFace className={`w-6 h-6 ${hwReport.faceIrPresent ? "text-blue-600" : "text-zinc-400"}`} />
                <div>
                  <div className="text-xs font-bold text-black">Face ID / Windows Hello IR Camera</div>
                  <div className="text-[11px] text-zinc-600">
                    {hwReport.platform === "macOS"
                      ? "N/A on macOS laptops"
                      : hwReport.faceIrPresent
                      ? "IR Face Hardware Detected"
                      : "Not Equipped / Not Found"}
                  </div>
                </div>
              </div>
            </div>

            {hwReport.sensors.length > 0 && (
              <div className="space-y-1.5">
                {hwReport.sensors.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-[2px] bg-[#F8FAFC] border border-zinc-300 px-3 py-2 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="text-blue-700 font-bold mr-2">[{s.kind}]</span>
                      <span className="text-black font-medium">{s.name}</span>
                    </div>
                    <span className={s.driverOk ? "text-blue-700 font-mono font-bold" : "text-black font-mono font-bold underline"}>
                      {s.driverOk
                        ? "Driver OK"
                        : s.errorCode != null
                        ? `Error Code ${s.errorCode}`
                        : "Driver Fault"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-zinc-600">{hwReport.summary}</div>
          </>
        )}
      </div>

      {/* Plain-Language Interpretation */}
      <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-1.5">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
          What This Means for Long-Term Use — {buyerTitle}
        </div>
        <div className="text-xs text-black">{buyerText}</div>
      </div>

      <div className="rounded-[2px] border border-zinc-300 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-black">Stage 2: Live OS Biometric Verification</h2>
            <p className="text-xs text-zinc-600 mt-0.5">
              Triggers native Windows Hello / macOS Touch ID when enrolled, or confirm Hardware OK / N/A below.
            </p>
          </div>
          <button
            onClick={triggerPrompt}
            disabled={prompting}
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Fingerprint className="w-4 h-4" />
            {prompting ? "Waiting for OS Prompt..." : "Trigger Live Biometric Prompt"}
          </button>
        </div>

        {authResult && (
          <div className="rounded-[2px] border border-blue-600 bg-blue-50/40 px-4 py-3 text-xs flex items-center justify-between text-black">
            <span>
              <strong>[{authResult.outcome}]</strong> {authResult.message}
            </span>
            <StatusBadge status={authResult.status} compact />
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-200">
          <button
            onClick={() =>
              onVerdict("pass", "Biometric sensor hardware & drivers verified OK (Fresh OS — not enrolled).")
            }
            className={`px-3.5 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer ${
              suggested === "pass" ? "ring-2 ring-blue-600 ring-offset-1" : ""
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve Hardware OK
            {suggested === "pass" && <span className="font-mono text-[9.5px] uppercase ml-1">[Recommended]</span>}
          </button>
          <button
            onClick={() => onVerdict("notApplicable", "Laptop does not include fingerprint or Face ID hardware.")}
            className={`px-3.5 py-2 rounded-[2px] border bg-white hover:bg-zinc-100 text-black font-bold text-xs flex items-center gap-1.5 cursor-pointer ${
              suggested === "notApplicable" ? "border-2 border-blue-600" : "border-zinc-300"
            }`}
          >
            Mark N/A (Not Equipped)
            {suggested === "notApplicable" && (
              <span className="font-mono text-[9.5px] uppercase text-blue-700">[Recommended]</span>
            )}
          </button>
          <button
            onClick={() => onVerdict("fail", "Biometric sensor failed verification or reported driver fault.")}
            className={`px-3.5 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer ${
              suggested === "fail" ? "ring-2 ring-black ring-offset-1" : ""
            }`}
          >
            <XCircle className="w-3.5 h-3.5" /> Mark FAIL
            {suggested === "fail" && <span className="font-mono text-[9.5px] uppercase ml-1">[Recommended]</span>}
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint={`Verify biometrics or confirm N/A to unlock Stage ${String(Math.min(stepNumber + 1, totalSteps)).padStart(2, "0")} (or click Skip Step).`}
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
