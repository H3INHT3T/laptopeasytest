import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Fingerprint, RefreshCw, ScanFace, ShieldCheck, XCircle } from "lucide-react";
import type { BiometricAuthResult, BiometricsHardwareReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface BiometricsViewProps {
  hwReport: BiometricsHardwareReport | null;
  loading: boolean;
  status: TestStatus;
  onRefresh: () => void;
  onVerdict: (status: TestStatus, summary: string) => void;
  onNext?: () => void;
}

export const BiometricsView: React.FC<BiometricsViewProps> = ({
  hwReport,
  loading,
  status,
  onRefresh,
  onVerdict,
  onNext,
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
      setAuthResult({
        outcome: "Error",
        status: "warn",
        message: String(e),
      });
    } finally {
      setPrompting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Fingerprint &amp; Face ID Biometrics</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Two-stage verification: checks sensor hardware &amp; driver health first, then optionally triggers Windows Hello / macOS Touch ID.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Detect Sensors
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

      {/* Stage 1: Hardware Detection */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            Stage 1: Biometric Hardware &amp; Driver Detection
          </h2>
          {hwReport && <StatusBadge status={hwReport.suggestedStatus} />}
        </div>

        {!hwReport ? (
          <div className="text-xs text-slate-400 py-4">Scanning biometric sensors...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3.5 flex items-center gap-3">
                <Fingerprint className={`w-6 h-6 ${hwReport.fingerprintPresent ? "text-emerald-400" : "text-slate-600"}`} />
                <div>
                  <div className="text-xs font-bold text-white">
                    {hwReport.platform === "macOS" ? "Touch ID Sensor" : "Fingerprint Reader"}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {hwReport.fingerprintPresent ? "Hardware Detected" : "Not Equipped / Not Found"}
                  </div>
                </div>
              </div>
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3.5 flex items-center gap-3">
                <ScanFace className={`w-6 h-6 ${hwReport.faceIrPresent ? "text-emerald-400" : "text-slate-600"}`} />
                <div>
                  <div className="text-xs font-bold text-white">Face ID / Windows Hello IR Camera</div>
                  <div className="text-[11px] text-slate-400">
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
                    className="rounded-lg bg-slate-950/80 border border-slate-800 px-3 py-2 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="text-cyan-300 font-semibold mr-2">[{s.kind}]</span>
                      <span className="text-slate-200">{s.name}</span>
                    </div>
                    <span className={s.driverOk ? "text-emerald-400 font-mono" : "text-rose-400 font-mono"}>
                      {s.driverOk ? "Driver OK" : `Error Code ${s.errorCode}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-slate-400">{hwReport.summary}</div>
          </>
        )}
      </div>

      {/* Stage 2: Live OS Biometric Verification */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-white">Stage 2: Live OS Biometric Prompt (Optional)</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Triggers Windows Hello / macOS Touch ID if enrolled. Freshly wiped laptops with healthy drivers can be approved below.
            </p>
          </div>
          <button
            onClick={triggerPrompt}
            disabled={prompting}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center gap-1.5"
          >
            <Fingerprint className="w-4 h-4" />
            {prompting ? "Waiting for OS Biometric Prompt..." : "Trigger Live Biometric Prompt"}
          </button>
        </div>

        {authResult && (
          <div
            className={`rounded-lg border px-4 py-3 text-xs flex items-center justify-between ${
              authResult.status === "pass"
                ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
                : authResult.status === "notApplicable"
                ? "bg-slate-800 border-slate-700 text-slate-300"
                : "bg-amber-500/10 border-amber-500/40 text-amber-200"
            }`}
          >
            <span>
              <strong>[{authResult.outcome}]</strong> {authResult.message}
            </span>
            <StatusBadge status={authResult.status} compact />
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
          <button
            onClick={() =>
              onVerdict("pass", "Biometric sensor hardware & drivers verified OK (Not enrolled on fresh OS).")
            }
            className="px-3.5 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-semibold text-xs flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve Hardware OK (Fresh Laptop)
          </button>
          <button
            onClick={() => onVerdict("notApplicable", "Laptop model does not include fingerprint or Face ID hardware.")}
            className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs"
          >
            Mark N/A (Not Equipped)
          </button>
          <button
            onClick={() => onVerdict("fail", "Biometric sensor failed verification or reported driver fault.")}
            className="px-3.5 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-semibold text-xs flex items-center gap-1.5"
          >
            <XCircle className="w-3.5 h-3.5" /> Mark FAIL
          </button>
        </div>
      </div>
    </div>
  );
};
