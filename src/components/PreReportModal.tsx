import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  PlugZap,
  Volume2,
  X,
} from "lucide-react";
import type {
  ExportReportPayload,
  ExportedReportPaths,
  ModuleRecord,
  PortsSpeakerSignoff,
  ShopProfile,
  SystemSpecs,
  TestModuleId,
} from "../types";

interface PreReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shopProfile: ShopProfile;
  onUpdateProfile: (profile: ShopProfile) => void;
  specs: SystemSpecs | null;
  modules: Record<Exclude<TestModuleId, "dashboard">, ModuleRecord>;
}

function playStereoChime(channel: "left" | "right" | "both") {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type = "sine";
    osc.frequency.setValueAtTime(channel === "left" ? 440 : channel === "right" ? 587.33 : 523.25, ctx.currentTime);
    panner.pan.setValueAtTime(channel === "left" ? -1 : channel === "right" ? 1 : 0, ctx.currentTime);

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.65);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.7);
    setTimeout(() => ctx.close(), 850);
  } catch {
    // Ignore audio context restriction errors
  }
}

export const PreReportModal: React.FC<PreReportModalProps> = ({
  isOpen,
  onClose,
  shopProfile,
  onUpdateProfile,
  specs,
  modules,
}) => {
  const [profile, setProfile] = useState<ShopProfile>(shopProfile);
  useEffect(() => {
    setProfile(shopProfile);
  }, [shopProfile, isOpen]);
  const [signoff, setSignoff] = useState<PortsSpeakerSignoff>({
    portsChecked: false,
    portsNotes: "",
    speakersChecked: false,
    speakersNotes: "",
  });
  const [customerOrSku, setCustomerOrSku] = useState("");
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportedReportPaths | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const list = Object.values(modules);
  const failCount = list.filter((m) => m.status === "fail").length;
  const warnCount = list.filter((m) => m.status === "warn").length;
  const pendingCount = list.filter((m) => m.status === "pending" || m.status === "running").length;

  const overallVerdict =
    failCount > 0
      ? "FAILED"
      : pendingCount > 0
      ? "INCOMPLETE"
      : warnCount > 0
      ? "PASSED WITH WARNINGS"
      : "PASSED";

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setProfile((p) => ({ ...p, logoDataUrl: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setProfile((p) => ({ ...p, defaultOutputDir: selected }));
      }
    } catch {
      // Dialog cancelled
    }
  };

  const handleExport = async () => {
    if (!profile.shopName.trim() && !profile.technicianName.trim()) {
      setError("Please enter at least a Shop Name or Technician Username.");
      return;
    }
    setError(null);
    setExporting(true);
    try {
      onUpdateProfile(profile);
      const payload: ExportReportPayload = {
        shopProfile: profile,
        customerOrSku,
        technicianNotes,
        overallVerdict,
        specs,
        tests: list.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          status: m.status,
          summary: m.summary || "Not run",
          metrics: [],
          notes: m.notes,
        })),
        signoff,
        outputDir: profile.defaultOutputDir,
      };
      const result = await invoke<ExportedReportPaths>("export_qc_report", { payload });
      setExported(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Pre-Report Reminder &amp; Final QC Certificate</h2>
            <p className="text-xs text-slate-400">
              Confirm physical ports &amp; speakers, enter shop identity, and export PDF + HTML + JSON.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {/* Overall Verdict Banner */}
          <div
            className={`rounded-xl border px-4 py-3 flex items-center justify-between ${
              overallVerdict === "PASSED"
                ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
                : overallVerdict === "FAILED"
                ? "bg-rose-500/10 border-rose-500/40 text-rose-200"
                : "bg-amber-500/10 border-amber-500/40 text-amber-200"
            }`}
          >
            <div>
              <div className="text-xs uppercase tracking-wider opacity-80">Computed Overall Verdict</div>
              <div className="text-base font-bold">{overallVerdict}</div>
            </div>
            <div className="text-xs text-right font-mono">
              <div>{failCount} Fail • {warnCount} Warn • {pendingCount} Pending</div>
              <div className="opacity-80">
                {specs ? `${specs.model} (${specs.serialNumber})` : "Hardware detected"}
              </div>
            </div>
          </div>

          {/* Mandatory Alert Reminder: Ports & Speakers */}
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2 text-amber-300 font-semibold text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Technician Reminder: Physical Ports &amp; Speaker Verification
            </div>

            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={signoff.portsChecked}
                  onChange={(e) => setSignoff((s) => ({ ...s, portsChecked: e.target.checked }))}
                  className="mt-1 accent-emerald-500 w-4 h-4"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-100 flex items-center gap-1.5">
                    <PlugZap className="w-3.5 h-3.5 text-cyan-400" />
                    All Physical Ports Tested (USB-A, USB-C / Thunderbolt, HDMI / DP, Charging Port, Audio Jack, SD/LAN)
                  </div>
                  <input
                    type="text"
                    placeholder="Optional port notes (e.g. All 3 USB + HDMI verified)"
                    value={signoff.portsNotes}
                    onChange={(e) => setSignoff((s) => ({ ...s, portsNotes: e.target.value }))}
                    className="mt-1.5 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </label>

              <div className="border-t border-slate-800/80 pt-2.5">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={signoff.speakersChecked}
                    onChange={(e) => setSignoff((s) => ({ ...s, speakersChecked: e.target.checked }))}
                    className="mt-1 accent-emerald-500 w-4 h-4"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-100 flex items-center justify-between flex-wrap gap-2">
                      <span className="flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                        Speakers Verified (Left, Right, Volume &amp; No Crackling)
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            playStereoChime("left");
                          }}
                          className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-cyan-300"
                        >
                          Test Left
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            playStereoChime("right");
                          }}
                          className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-cyan-300"
                        >
                          Test Right
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            playStereoChime("both");
                          }}
                          className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-emerald-300"
                        >
                          Stereo
                        </button>
                      </div>
                    </div>
                    <input
                      type="text"
                      placeholder="Optional speaker notes (e.g. Stereo clear, no rattle)"
                      value={signoff.speakersNotes}
                      onChange={(e) => setSignoff((s) => ({ ...s, speakersNotes: e.target.value }))}
                      className="mt-1.5 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Shop & Technician Branding */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Shop Name (Saved as default)
              </label>
              <input
                type="text"
                value={profile.shopName}
                onChange={(e) => setProfile((p) => ({ ...p, shopName: e.target.value }))}
                placeholder="e.g. ProTech Laptop Store"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Technician Username (Saved as default)
              </label>
              <input
                type="text"
                value={profile.technicianName}
                onChange={(e) => setProfile((p) => ({ ...p, technicianName: e.target.value }))}
                placeholder="e.g. tech_alex"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Customer Name / Inventory SKU (Optional)
              </label>
              <input
                type="text"
                value={customerOrSku}
                onChange={(e) => setCustomerOrSku(e.target.value)}
                placeholder="e.g. SKU-2026-041 or Customer Name"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Shop Logo (Optional, for HTML report)
              </label>
              <div className="flex items-center gap-2">
                <label className="flex-1 cursor-pointer flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 hover:border-cyan-500 text-xs text-slate-300">
                  <ImageIcon className="w-4 h-4 text-cyan-400" />
                  {profile.logoDataUrl ? "Change Logo" : "Upload PNG/JPG"}
                  <input type="file" accept="image/png,image/jpeg" onChange={handleLogoUpload} className="hidden" />
                </label>
                {profile.logoDataUrl && (
                  <img
                    src={profile.logoDataUrl}
                    alt="Logo"
                    className="h-9 w-9 rounded object-contain bg-white p-0.5"
                  />
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Final Technician Notes (Optional)
            </label>
            <textarea
              rows={2}
              value={technicianNotes}
              onChange={(e) => setTechnicianNotes(e.target.value)}
              placeholder="e.g. Cleaned fans, Grade A chassis, ready for showroom display."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Export Output Directory */}
          <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400">Output Directory</div>
              <div className="text-xs text-slate-200 truncate font-mono">
                {profile.defaultOutputDir || "Documents/LaptopBenchQC/Reports (Default)"}
              </div>
            </div>
            <button
              type="button"
              onClick={handleChooseFolder}
              className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Browse
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-500/15 border border-rose-500/40 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          {exported && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/40 p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-emerald-300 font-semibold text-sm">
                <CheckCircle2 className="w-4 h-4" />
                QC Certificate Exported Successfully!
              </div>
              <div className="text-xs text-slate-300 font-mono break-all">
                Folder: {exported.directory}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => openPath(exported.pdfPath)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" /> Open PDF Certificate
                </button>
                <button
                  onClick={() => openPath(exported.htmlPath)}
                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 font-semibold text-xs"
                >
                  Open Branded HTML
                </button>
                <button
                  onClick={() => openPath(exported.directory)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center gap-1.5"
                >
                  <FolderOpen className="w-3.5 h-3.5" /> Open Folder
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
          >
            Close
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs shadow-lg"
          >
            {exporting ? "Exporting PDF + HTML + JSON..." : "Export Final QC Report"}
          </button>
        </div>
      </div>
    </div>
  );
};
