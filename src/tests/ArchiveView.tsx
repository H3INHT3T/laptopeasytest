import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Archive,
  Download,
  FileText,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { QcArchiveRecord } from "../types";

export const ArchiveView: React.FC = () => {
  const [records, setRecords] = useState<QcArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"ALL" | "PASSED" | "WARN" | "FAILED">("ALL");
  const [banner, setBanner] = useState<string | null>(null);

  const loadArchive = async () => {
    setLoading(true);
    try {
      const list = await invoke<QcArchiveRecord[]>("list_qc_archive");
      setRecords(Array.isArray(list) ? list : []);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadArchive();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (verdictFilter === "PASSED" && r.overallVerdict !== "PASSED") return false;
      if (verdictFilter === "WARN" && !r.overallVerdict.includes("WARN")) return false;
      if (verdictFilter === "FAILED" && r.overallVerdict !== "FAILED") return false;
      if (!q) return true;
      return (
        r.serialNumber.toLowerCase().includes(q) ||
        r.model.toLowerCase().includes(q) ||
        r.manufacturer.toLowerCase().includes(q) ||
        r.customerOrSku.toLowerCase().includes(q) ||
        r.certId.toLowerCase().includes(q)
      );
    });
  }, [records, query, verdictFilter]);

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_qc_archive_entry", { id });
      setRecords((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setBanner(String(e));
    }
  };

  const handleExport = async () => {
    const path = await saveDialog({
      title: "Export Tested-Laptop Warranty Archive",
      defaultPath: "laptopbench_qc_archive.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) {
      const n = await invoke<number>("export_qc_archive", { targetPath: path });
      setBanner(`Exported ${n} certified laptop record(s) to ${path}`);
    }
  };

  const handleImport = async () => {
    const path = await openDialog({
      title: "Import & Merge Warranty Archive JSON",
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (typeof path === "string") {
      const added = await invoke<number>("import_qc_archive", { sourcePath: path });
      setBanner(`Imported ${added} new laptop record(s).`);
      await loadArchive();
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-black tracking-tight flex items-center gap-2">
            <Archive className="w-6 h-6 text-blue-600" />
            Warranty &amp; Tested-Laptop Archive
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Every issued QC Certificate is auto-archived by Serial Number for instant warranty lookup and return-unit anti-fraud checks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadArchive}
            className="px-3 py-2 rounded-lg border border-zinc-200 bg-white hover:border-black text-xs font-semibold text-black inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : "text-zinc-500"}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Backup JSON
          </button>
          <button
            type="button"
            onClick={handleImport}
            className="px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:border-black text-black text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-blue-600" /> Import
          </button>
        </div>
      </div>

      {banner && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-2.5 text-xs font-medium text-blue-900">
          {banner}
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Serial Number, Model, Customer/SKU, or Cert ID..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-zinc-200 bg-[#F8FAFC] text-xs text-black focus:outline-none focus:border-blue-600"
          />
        </div>
        <div className="inline-flex rounded-lg border border-zinc-200 bg-[#F8FAFC] p-0.5 text-xs">
          {(["ALL", "PASSED", "WARN", "FAILED"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setVerdictFilter(f)}
              className={`px-3 py-1.5 rounded-md font-semibold cursor-pointer ${
                verdictFilter === f ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Archive Table */}
      <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-200 flex items-center justify-between text-xs">
          <span className="font-bold text-black">
            {filtered.length} Record{filtered.length === 1 ? "" : "s"}
          </span>
          <span className="font-mono text-zinc-400">Stored locally in qc_archive.json</span>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-500">
            {loading
              ? "Loading warranty archive..."
              : "No archived laptop certificates found. Issue a QC Certificate to save your first unit automatically."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#F8FAFC] border-b border-zinc-200 text-[11px] text-zinc-500">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">Date &amp; Cert ID</th>
                  <th className="py-2.5 px-3 font-semibold">Laptop &amp; Serial</th>
                  <th className="py-2.5 px-3 font-semibold">Customer / SKU</th>
                  <th className="py-2.5 px-3 font-semibold">Hardware Proof</th>
                  <th className="py-2.5 px-3 font-semibold">Verdict / Grades</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Files</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {filtered.map((rec) => (
                  <tr key={rec.id} className="hover:bg-zinc-50">
                    <td className="py-3 px-4 font-mono text-[11px]">
                      <div className="font-bold text-black">{rec.testedAt}</div>
                      <div className="text-zinc-400">{rec.certId}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-bold text-black">
                        {rec.manufacturer} {rec.model}
                      </div>
                      <div className="font-mono text-[11px] text-blue-700">S/N: {rec.serialNumber}</div>
                    </td>
                    <td className="py-3 px-3 font-mono text-zinc-700">
                      {rec.customerOrSku || "—"}
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-zinc-600">
                      <div>
                        RAM: {rec.ramGb != null ? `${Math.round(rec.ramGb)}GB` : "—"} • Bat:{" "}
                        {rec.batteryHealthPct != null ? `${rec.batteryHealthPct.toFixed(0)}%` : "—"}
                      </div>
                      <div className="truncate max-w-[200px]" title={rec.ssdSerial || ""}>
                        SSD: {rec.ssdSerial || "—"}
                        {rec.ssdWearPct != null ? ` (${rec.ssdWearPct}% wear)` : ""}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold ${
                          rec.overallVerdict === "PASSED"
                            ? "bg-blue-600 text-white"
                            : rec.overallVerdict === "FAILED"
                            ? "bg-black text-white"
                            : "bg-blue-50 text-blue-700 border border-blue-200"
                        }`}
                      >
                        {rec.overallVerdict}
                      </span>
                      <div className="font-mono text-[10px] text-zinc-500 mt-1">
                        {rec.durabilityGrade ? `Dur ${rec.durabilityGrade}` : ""}
                        {rec.cosmeticGrade ? ` • Cos ${rec.cosmeticGrade}` : ""}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openPath(rec.pdfPath).catch(() => {})}
                          className="px-2 py-1 rounded border border-zinc-200 bg-white hover:border-blue-600 font-mono text-[10px] font-bold text-black inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3 h-3 text-blue-600" /> PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => openPath(rec.htmlPath).catch(() => {})}
                          className="px-2 py-1 rounded border border-zinc-200 bg-white hover:border-black font-mono text-[10px] font-bold text-black cursor-pointer"
                        >
                          HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(rec.id)}
                          title="Delete archive record"
                          className="p-1 rounded border border-zinc-200 bg-white hover:border-black text-zinc-500 hover:text-black cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
