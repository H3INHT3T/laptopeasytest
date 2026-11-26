import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Fingerprint, RefreshCw, ScanFace, XCircle } from "lucide-react";
import type { BiometricAuthResult, BiometricsHardwareReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

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

  return (
    <div className="space-y-6">
      {/* BLOCK 1: Minimal Header + 1 Primary Button */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Fingerprint &amp; Face ID Biometrics
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • Windows Hello / Touch ID hardware &amp; live prompt
          </div>
        </div>

        <button
          type="button"
          onClick={triggerPrompt}
          disabled={prompting}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
        >
          <Fingerprint className="w-4 h-4" />
          {prompting ? "Waiting for OS prompt..." : "Trigger Live Biometric Prompt"}
        </button>
      </div>

      {/* BLOCK 2: 1 Clean Visual Result & Decision Card */}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 p-4 flex items-center gap-3.5">
            <Fingerprint className={`w-6 h-6 shrink-0 ${hwReport?.fingerprintPresent ? "text-blue-600" : "text-zinc-400"}`} />
            <div>
              <div className="text-xs text-zinc-500">
                {hwReport?.platform === "macOS" ? "Touch ID sensor" : "Fingerprint reader"}
              </div>
              <div className="text-base font-bold text-black">
                {!hwReport ? "Scanning..." : hwReport.fingerprintPresent ? "Detected" : "Not equipped"}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#F8FAFC] border border-zinc-200 p-4 flex items-center gap-3.5">
            <ScanFace className={`w-6 h-6 shrink-0 ${hwReport?.faceIrPresent ? "text-blue-600" : "text-zinc-400"}`} />
            <div>
              <div className="text-xs text-zinc-500">IR Face ID camera</div>
              <div className="text-base font-bold text-black">
                {!hwReport
                  ? "Scanning..."
                  : hwReport.platform === "macOS"
                  ? "N/A on macOS"
                  : hwReport.faceIrPresent
                  ? "Detected"
                  : "Not equipped"}
              </div>
            </div>
          </div>
        </div>

        {authResult && (
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-4 py-3 text-xs flex items-center justify-between text-black">
            <span>
              <strong>[{authResult.outcome}]</strong> {authResult.message}
            </span>
            <StatusBadge status={authResult.status} compact />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-zinc-100">
          <button
            type="button"
            onClick={() =>
              onVerdict("pass", "Biometric sensor hardware & drivers verified OK (Fresh OS — not enrolled).")
            }
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Approve Hardware OK
          </button>
          <button
            type="button"
            onClick={() => onVerdict("notApplicable", "Laptop does not include fingerprint or Face ID hardware.")}
            className={`px-4 py-2 rounded-xl border bg-white hover:border-black text-black font-semibold text-xs cursor-pointer ${
              suggested === "notApplicable" ? "border-blue-600 text-blue-700" : "border-zinc-200"
            }`}
          >
            Mark N/A (Not Equipped)
          </button>
          <button
            type="button"
            onClick={() => onVerdict("fail", "Biometric sensor failed verification or reported driver fault.")}
            className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-800 text-white font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" />
            Mark FAIL
          </button>
        </div>
      </div>

      {/* BLOCK 3: 1 Collapsed "Details" Toggle */}
      <TechnicalDetailsDrawer
        title="Details"
        subtitle={`${hwReport?.sensors.length ?? 0} sensor device(s) • Driver diagnostics`}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-600">{hwReport?.summary || "No biometric sensors detected."}</span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isSpinning}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSpinning ? "animate-spin text-blue-600" : ""}`} />
              Detect Sensors
            </button>
          </div>

          {(hwReport?.sensors.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              {hwReport!.sensors.map((s, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-white border border-zinc-200 px-3.5 py-2.5 flex items-center justify-between text-xs"
                >
                  <div>
                    <span className="text-blue-700 font-semibold mr-2">[{s.kind}]</span>
                    <span className="text-black font-medium">{s.name}</span>
                  </div>
                  <span className={s.driverOk ? "text-blue-700 font-mono font-bold" : "text-black font-mono font-bold underline"}>
                    {s.driverOk ? "Driver OK" : s.errorCode != null ? `Error ${s.errorCode}` : "Driver Fault"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </TechnicalDetailsDrawer>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Verify biometrics or mark N/A to continue."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
