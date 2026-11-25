import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Send,
  X,
} from "lucide-react";
import type {
  ExportReportPayload,
  ExportedReportPaths,
  ModuleRecord,
  PortsSpeakerSignoff,
  ShopProfile,
  StepModuleId,
  SystemSpecs,
} from "../types";

interface PreReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shopProfile: ShopProfile;
  onUpdateProfile: (profile: ShopProfile) => void;
  specs: SystemSpecs | null;
  stepOrder: StepModuleId[];
  modules: Record<StepModuleId, ModuleRecord>;
  signoff: PortsSpeakerSignoff;
}

export const PreReportModal: React.FC<PreReportModalProps> = ({
  isOpen,
  onClose,
  shopProfile,
  onUpdateProfile,
  specs,
  stepOrder,
  modules,
  signoff,
}) => {
  const [profile, setProfile] = useState<ShopProfile>(shopProfile);
  useEffect(() => {
    setProfile(shopProfile);
  }, [shopProfile, isOpen]);

  const [customerOrSku, setCustomerOrSku] = useState("");
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportedReportPaths | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const list = stepOrder.map((id) => modules[id]);
  const failCount = list.filter((m) => m.status === "fail").length;
  const warnCount = list.filter((m) => m.status === "warn").length;
  const skippedCount = list.filter((m) => m.status === "skipped").length;
  const pendingCount = list.filter((m) => m.status === "pending" || m.status === "running").length;

  const overallVerdict =
    failCount > 0
      ? "FAILED"
      : pendingCount > 0
      ? "INCOMPLETE"
      : warnCount > 0 || skippedCount > 0
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
      // Cancelled
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
          name: `${m.stepNumber}. ${m.name}`,
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
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white border border-black rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-black text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black tracking-tight">Final Branded QC Certificate</h2>
            <p className="text-xs text-zinc-400">
              Export offline PDF Certificate + Branded HTML + JSON Archive with your Shop Name &amp; Username.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          <div
            className={`rounded-xl border px-4 py-3 flex items-center justify-between ${
              overallVerdict === "FAILED"
                ? "bg-black border-black text-white"
                : "bg-blue-50 border-blue-600 text-black"
            }`}
          >
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold opacity-75">
                Computed Overall Verdict
              </div>
              <div className="text-lg font-black">{overallVerdict}</div>
            </div>
            <div className="text-xs text-right font-mono">
              <div>
                {failCount} Fail • {warnCount} Warn • {skippedCount} Skipped
              </div>
              <div className="opacity-80">
                {specs ? `${specs.model} (${specs.serialNumber})` : "Hardware detected"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-bold text-black mb-1">Shop Name (Saved)</label>
              <input
                type="text"
                value={profile.shopName}
                onChange={(e) => setProfile((p) => ({ ...p, shopName: e.target.value }))}
                placeholder="e.g. ProTech Laptop Store"
                className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-sm text-black focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-black mb-1">Technician Username (Saved)</label>
              <input
                type="text"
                value={profile.technicianName}
                onChange={(e) => setProfile((p) => ({ ...p, technicianName: e.target.value }))}
                placeholder="e.g. Hein Htet Zaw"
                className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-sm text-black focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-black mb-1">Customer / Inventory SKU (Optional)</label>
              <input
                type="text"
                value={customerOrSku}
                onChange={(e) => setCustomerOrSku(e.target.value)}
                placeholder="e.g. SKU-2026-041"
                className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-sm text-black focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-black mb-1">Shop Logo (Optional)</label>
              <div className="flex items-center gap-2">
                <label className="flex-1 cursor-pointer flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 border border-zinc-300 hover:border-blue-600 text-xs font-semibold text-black">
                  <ImageIcon className="w-4 h-4 text-blue-600" />
                  {profile.logoDataUrl ? "Change Logo" : "Upload PNG/JPG"}
                  <input type="file" accept="image/png,image/jpeg" onChange={handleLogoUpload} className="hidden" />
                </label>
                {profile.logoDataUrl && (
                  <img
                    src={profile.logoDataUrl}
                    alt="Logo"
                    className="h-9 w-9 rounded object-contain border border-zinc-300 p-0.5"
                  />
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-black mb-1">Final Technician Notes (Optional)</label>
            <textarea
              rows={2}
              value={technicianNotes}
              onChange={(e) => setTechnicianNotes(e.target.value)}
              placeholder="e.g. Grade A unit, all tests verified."
              className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-sm text-black focus:outline-none focus:border-blue-600"
            />
          </div>

          <div className="flex items-center justify-between gap-2 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500">Output Directory</div>
              <div className="text-xs text-black truncate font-mono">
                {profile.defaultOutputDir || "Documents/LaptopBenchQC/Reports (Default)"}
              </div>
            </div>
            <button
              type="button"
              onClick={handleChooseFolder}
              className="shrink-0 px-3 py-1.5 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" /> Browse
            </button>
          </div>

          {error && <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>}

          {exported && (
            <div className="rounded-xl bg-blue-50 border border-blue-600 p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-blue-800 font-bold text-sm">
                <CheckCircle2 className="w-4 h-4 text-blue-600" />
                QC Certificate Exported Successfully!
              </div>
              <div className="text-xs text-zinc-700 font-mono break-all">Folder: {exported.directory}</div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => openPath(exported.pdfPath)}
                  className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" /> Open PDF Certificate
                </button>
                <button
                  onClick={() => openPath(exported.htmlPath)}
                  className="px-3.5 py-1.5 rounded-lg border border-black bg-white hover:bg-zinc-100 text-black font-bold text-xs cursor-pointer"
                >
                  Open Branded HTML
                </button>
                <button
                  onClick={() => openPath(exported.directory)}
                  className="px-3.5 py-1.5 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" /> Open Folder
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between gap-2.5">
          <div className="text-[11px] text-zinc-600 flex items-center gap-1">
            Created by <strong className="text-black">Hein Htet Zaw</strong>
            <span className="text-blue-600 font-mono inline-flex items-center gap-0.5">
              (<Send className="w-2.5 h-2.5" />@ich8g92)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 text-xs font-bold text-black cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs cursor-pointer"
            >
              {exporting ? "Exporting PDF + HTML + JSON..." : "Export Final QC Report"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
