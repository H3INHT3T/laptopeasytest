import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatteryHealthReport,
  BiometricsHardwareReport,
  ErrorLogsReport,
  GpuStressResult,
  ModuleRecord,
  PerfBenchResult,
  RamTestResult,
  SecurityAuditReport,
  ShopProfile,
  StorageBenchResult,
  StorageSmartReport,
  SystemSpecs,
  TestModuleId,
  TestStatus,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { PreReportModal } from "./components/PreReportModal";
import { DashboardView } from "./tests/DashboardView";
import { SpecsView } from "./tests/SpecsView";
import { SecurityAuditView } from "./tests/SecurityAuditView";
import { BatteryView } from "./tests/BatteryView";
import { ErrorLogsView } from "./tests/ErrorLogsView";
import { DisplayTestView } from "./tests/DisplayTestView";
import { KeyboardTestView } from "./tests/KeyboardTestView";
import { StorageView } from "./tests/StorageView";
import { RamTestView } from "./tests/RamTestView";
import { BiometricsView } from "./tests/BiometricsView";
import { MediaTestView } from "./tests/MediaTestView";
import { PerformanceView } from "./tests/PerformanceView";
import { GpuStressView } from "./tests/GpuStressView";

const GUIDED_ORDER: Exclude<TestModuleId, "dashboard">[] = [
  "specs",
  "security",
  "battery",
  "logs",
  "storage",
  "display",
  "keyboard",
  "biometrics",
  "media",
  "ram",
  "performance",
  "gpu",
];

const INITIAL_MODULES: Record<Exclude<TestModuleId, "dashboard">, ModuleRecord> = {
  specs: { id: "specs", name: "Specifications", category: "Automated", status: "pending", summary: "", notes: "" },
  security: { id: "security", name: "Lock, MDM & License", category: "Automated", status: "pending", summary: "", notes: "" },
  battery: { id: "battery", name: "Battery & Charging", category: "Automated", status: "pending", summary: "", notes: "" },
  logs: { id: "logs", name: "System Error Logs", category: "Automated", status: "pending", summary: "", notes: "" },
  storage: { id: "storage", name: "SSD SMART & Speed", category: "Automated", status: "pending", summary: "", notes: "" },
  display: { id: "display", name: "Display Check", category: "Interactive", status: "pending", summary: "", notes: "" },
  keyboard: { id: "keyboard", name: "Keyboard Test", category: "Interactive", status: "pending", summary: "", notes: "" },
  biometrics: { id: "biometrics", name: "Fingerprint & Face ID", category: "Interactive", status: "pending", summary: "", notes: "" },
  media: { id: "media", name: "Camera & Microphone", category: "Interactive", status: "pending", summary: "", notes: "" },
  ram: { id: "ram", name: "RAM Stress Test", category: "Stress", status: "pending", summary: "", notes: "" },
  performance: { id: "performance", name: "Performance Bench", category: "Stress", status: "pending", summary: "", notes: "" },
  gpu: { id: "gpu", name: "Gaming GPU Stress", category: "Stress", status: "pending", summary: "", notes: "" },
};

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TestModuleId>("dashboard");
  const [guidedMode, setGuidedMode] = useState(false);
  const [modules, setModules] = useState(INITIAL_MODULES);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  const [shopProfile, setShopProfile] = useState<ShopProfile>({
    shopName: "",
    technicianName: "",
    logoDataUrl: null,
    defaultOutputDir: null,
  });

  // Module Data States
  const [specs, setSpecs] = useState<SystemSpecs | null>(null);
  const [securityReport, setSecurityReport] = useState<SecurityAuditReport | null>(null);
  const [batteryReport, setBatteryReport] = useState<BatteryHealthReport | null>(null);
  const [errorLogsReport, setErrorLogsReport] = useState<ErrorLogsReport | null>(null);
  const [smartReport, setSmartReport] = useState<StorageSmartReport | null>(null);
  const [storageBench, setStorageBench] = useState<StorageBenchResult | null>(null);
  const [ramResult, setRamResult] = useState<RamTestResult | null>(null);
  const [bioHwReport, setBioHwReport] = useState<BiometricsHardwareReport | null>(null);
  const [perfResult, setPerfResult] = useState<PerfBenchResult | null>(null);
  const [gpuResult, setGpuResult] = useState<GpuStressResult | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);

  const updateModule = useCallback(
    (
      id: Exclude<TestModuleId, "dashboard">,
      status: TestStatus,
      summary?: string,
      notes?: string
    ) => {
      setModules((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          status,
          summary: summary !== undefined ? summary : prev[id].summary,
          notes: notes !== undefined ? notes : prev[id].notes,
        },
      }));
    },
    []
  );

  const fetchSpecs = useCallback(async () => {
    updateModule("specs", "running", "Collecting hardware specifications...");
    try {
      const sp = await invoke<SystemSpecs>("get_system_specs");
      setSpecs(sp);
      updateModule(
        "specs",
        "pass",
        `${sp.manufacturer} ${sp.model} | ${sp.cpuBrand} | ${sp.totalRamGb.toFixed(0)} GB RAM | S/N ${sp.serialNumber}`
      );
    } catch (e) {
      updateModule("specs", "warn", `Spec scan error: ${String(e)}`);
    }
  }, [updateModule]);

  const fetchSecurity = useCallback(async () => {
    updateModule("security", "running", "Auditing MDM, Activation Lock, Encryption & License...");
    try {
      const rep = await invoke<SecurityAuditReport>("run_security_audit");
      setSecurityReport(rep);
      updateModule("security", rep.overallStatus, rep.summary);
    } catch (e) {
      updateModule("security", "warn", `Security audit error: ${String(e)}`);
    }
  }, [updateModule]);

  const fetchBattery = useCallback(async () => {
    updateModule("battery", "running", "Reading battery health & cycle count...");
    try {
      const rep = await invoke<BatteryHealthReport>("get_battery_health");
      setBatteryReport(rep);
      const summary = rep.present
        ? `${rep.healthPercent != null ? `${rep.healthPercent.toFixed(1)}% health` : "Detected"}${
            rep.cycleCount != null ? `, ${rep.cycleCount} cycles` : ""
          } (${rep.acPlugged ? "AC Plugged" : "On Battery"})`
        : rep.notes;
      updateModule("battery", rep.status, summary);
    } catch (e) {
      updateModule("battery", "warn", `Battery query error: ${String(e)}`);
    }
  }, [updateModule]);

  const fetchErrorLogs = useCallback(
    async (days = 30) => {
      updateModule("logs", "running", `Scanning last ${days} days of OS crash & hardware logs...`);
      try {
        const rep = await invoke<ErrorLogsReport>("scan_error_logs", { days });
        setErrorLogsReport(rep);
        updateModule("logs", rep.status, rep.summary);
      } catch (e) {
        updateModule("logs", "warn", `Log scan error: ${String(e)}`);
      }
    },
    [updateModule]
  );

  const fetchSmart = useCallback(async () => {
    updateModule("storage", "running", "Reading NVMe/SATA SMART counters...");
    try {
      const rep = await invoke<StorageSmartReport>("scan_storage_smart");
      setSmartReport(rep);
      updateModule("storage", rep.status, rep.summary);
    } catch (e) {
      updateModule("storage", "warn", `SMART scan error: ${String(e)}`);
    }
  }, [updateModule]);

  const fetchBiometricsHw = useCallback(async () => {
    try {
      const rep = await invoke<BiometricsHardwareReport>("detect_biometrics_hardware");
      setBioHwReport(rep);
      setModules((prev) =>
        prev.biometrics.status === "pending"
          ? {
              ...prev,
              biometrics: {
                ...prev.biometrics,
                status: rep.suggestedStatus === "notApplicable" ? "notApplicable" : "pending",
                summary: rep.summary,
              },
            }
          : prev
      );
    } catch {
      // Ignore initial biometric probe error
    }
  }, []);

  const runAllAutoChecks = useCallback(async () => {
    setAutoRunning(true);
    await Promise.all([
      fetchSpecs(),
      fetchSecurity(),
      fetchBattery(),
      fetchErrorLogs(30),
      fetchSmart(),
      fetchBiometricsHw(),
    ]);
    setAutoRunning(false);
  }, [fetchSpecs, fetchSecurity, fetchBattery, fetchErrorLogs, fetchSmart, fetchBiometricsHw]);

  useEffect(() => {
    invoke<ShopProfile>("load_shop_profile")
      .then(setShopProfile)
      .catch(() => {});
    runAllAutoChecks();
  }, [runAllAutoChecks]);

  const goNextGuided = (current: Exclude<TestModuleId, "dashboard">) => {
    const idx = GUIDED_ORDER.indexOf(current);
    if (idx >= 0 && idx + 1 < GUIDED_ORDER.length) {
      setActiveTab(GUIDED_ORDER[idx + 1]);
    } else {
      setReportModalOpen(true);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      <Sidebar
        activeTab={activeTab}
        onSelect={(id) => {
          setActiveTab(id);
          if (id === "dashboard") setGuidedMode(false);
        }}
        modules={modules}
        isGamingCapable={specs?.isGamingCapable ?? false}
        guidedMode={guidedMode}
        onOpenReportModal={() => setReportModalOpen(true)}
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto">
          {activeTab === "dashboard" && (
            <DashboardView
              specs={specs}
              modules={modules}
              autoRunning={autoRunning}
              onRunAutoChecks={runAllAutoChecks}
              onStartGuided={() => {
                setGuidedMode(true);
                setActiveTab("specs");
              }}
              onSelectModule={(id) => setActiveTab(id)}
              onOpenReport={() => setReportModalOpen(true)}
            />
          )}

          {activeTab === "specs" && (
            <SpecsView
              specs={specs}
              loading={modules.specs.status === "running"}
              status={modules.specs.status}
              onRefresh={fetchSpecs}
              onNext={() => goNextGuided("specs")}
            />
          )}

          {activeTab === "security" && (
            <SecurityAuditView
              report={securityReport}
              loading={modules.security.status === "running"}
              status={modules.security.status}
              onRefresh={fetchSecurity}
              onNext={() => goNextGuided("security")}
            />
          )}

          {activeTab === "battery" && (
            <BatteryView
              report={batteryReport}
              loading={modules.battery.status === "running"}
              status={modules.battery.status}
              onRefresh={fetchBattery}
              onUpdateStatus={(st, sum) => updateModule("battery", st, sum)}
              onNext={() => goNextGuided("battery")}
            />
          )}

          {activeTab === "logs" && (
            <ErrorLogsView
              report={errorLogsReport}
              loading={modules.logs.status === "running"}
              status={modules.logs.status}
              onScan={fetchErrorLogs}
              onNext={() => goNextGuided("logs")}
            />
          )}

          {activeTab === "storage" && (
            <StorageView
              smartReport={smartReport}
              benchResult={storageBench}
              loadingSmart={modules.storage.status === "running"}
              status={modules.storage.status}
              onRefreshSmart={fetchSmart}
              onBenchComplete={(res) => {
                setStorageBench(res);
                const smartSt = smartReport?.status ?? "pass";
                const combined: TestStatus =
                  smartSt === "fail" || res.status === "fail"
                    ? "fail"
                    : smartSt === "warn" || res.status === "warn"
                    ? "warn"
                    : "pass";
                updateModule(
                  "storage",
                  combined,
                  `${smartReport?.summary ?? "SMART OK"} | ${res.summary}`
                );
              }}
              onNext={() => goNextGuided("storage")}
            />
          )}

          {activeTab === "display" && (
            <DisplayTestView
              status={modules.display.status}
              notes={modules.display.notes}
              onVerdict={(st, sum, notes) => updateModule("display", st, sum, notes)}
              onNext={() => goNextGuided("display")}
            />
          )}

          {activeTab === "keyboard" && (
            <KeyboardTestView
              osFamily={specs?.osFamily ?? "windows"}
              status={modules.keyboard.status}
              notes={modules.keyboard.notes}
              onVerdict={(st, sum, notes) => updateModule("keyboard", st, sum, notes)}
              onNext={() => goNextGuided("keyboard")}
            />
          )}

          {activeTab === "biometrics" && (
            <BiometricsView
              hwReport={bioHwReport}
              loading={false}
              status={modules.biometrics.status}
              onRefresh={fetchBiometricsHw}
              onVerdict={(st, sum) => updateModule("biometrics", st, sum)}
              onNext={() => goNextGuided("biometrics")}
            />
          )}

          {activeTab === "media" && (
            <MediaTestView
              status={modules.media.status}
              notes={modules.media.notes}
              onVerdict={(st, sum, notes) => updateModule("media", st, sum, notes)}
              onNext={() => goNextGuided("media")}
            />
          )}

          {activeTab === "ram" && (
            <RamTestView
              result={ramResult}
              status={modules.ram.status}
              onRunningChange={(r) => {
                if (r) updateModule("ram", "running", "Running multi-threaded RAM bit-pattern stress...");
              }}
              onComplete={(res) => {
                setRamResult(res);
                updateModule("ram", res.status, res.summary);
              }}
              onNext={() => goNextGuided("ram")}
            />
          )}

          {activeTab === "performance" && (
            <PerformanceView
              result={perfResult}
              status={modules.performance.status}
              onRunningChange={(r) => {
                if (r) updateModule("performance", "running", "Running CPU & Memory performance benchmark...");
              }}
              onComplete={(res) => {
                setPerfResult(res);
                updateModule("performance", res.status, res.summary);
              }}
              onNext={() => goNextGuided("performance")}
            />
          )}

          {activeTab === "gpu" && (
            <GpuStressView
              isGamingCapable={specs?.isGamingCapable ?? false}
              result={gpuResult}
              status={modules.gpu.status}
              onRunningChange={(r) => {
                if (r) updateModule("gpu", "running", "Running wgpu FurMark-style GPU thermal stress...");
              }}
              onComplete={(res) => {
                setGpuResult(res);
                updateModule("gpu", res.status, res.summary);
              }}
              onMarkNA={() =>
                updateModule("gpu", "notApplicable", "Skipped — standard office/integrated GPU notebook.")
              }
              onFinish={() => setReportModalOpen(true)}
            />
          )}
        </div>
      </main>

      <PreReportModal
        isOpen={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        shopProfile={shopProfile}
        onUpdateProfile={(p) => {
          setShopProfile(p);
          invoke("save_shop_profile", { profile: p }).catch(() => {});
        }}
        specs={specs}
        modules={modules}
      />
    </div>
  );
};

export default App;
