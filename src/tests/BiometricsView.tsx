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
  onRefresh: () => void;
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
  const [authResult, setAuthResult] = useState<BiometricAuthResult | null>(null);

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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
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
          onClick={onRefresh}
          disabled={loading}
          className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          Detect Sensors
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
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
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3.5 flex items-center gap-3">
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
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3.5 flex items-center gap-3">
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
                    className="rounded-lg bg-zinc-50 border border-zinc-200 px-3 py-2 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="text-blue-700 font-bold mr-2">[{s.kind}]</span>
                      <span className="text-black font-medium">{s.name}</span>
                    </div>
                    <span className={s.driverOk ? "text-blue-700 font-mono font-bold" : "text-black font-mono font-bold"}>
                      {s.driverOk ? "Driver OK" : `Error Code ${s.errorCode}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-zinc-600">{hwReport.summary}</div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
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
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Fingerprint className="w-4 h-4" />
            {prompting ? "Waiting for OS Prompt..." : "Trigger Live Biometric Prompt"}
          </button>
        </div>

        {authResult && (
          <div className="rounded-lg border border-blue-600 bg-blue-50 px-4 py-3 text-xs flex items-center justify-between text-black">
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
            className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve Hardware OK
          </button>
          <button
            onClick={() => onVerdict("notApplicable", "Laptop does not include fingerprint or Face ID hardware.")}
            className="px-3.5 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 text-black font-bold text-xs cursor-pointer"
          >
            Mark N/A (Not Equipped)
          </button>
          <button
            onClick={() => onVerdict("fail", "Biometric sensor failed verification or reported driver fault.")}
            className="px-3.5 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" /> Mark FAIL
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Verify biometrics or confirm N/A to unlock Step 9 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
