import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatteryHealthReport,
  BiometricsHardwareReport,
  ErrorLogsReport,
  GpuStressResult,
  ModuleRecord,
  PerfBenchResult,
  PortsSpeakerSignoff,
  RamTestResult,
  SecurityAuditReport,
  ShopProfile,
  StepModuleId,
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
import { PortsSpeakersView } from "./tests/PortsSpeakersView";

const STEP_ORDER: StepModuleId[] = [
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
  "ports_speakers",
];

const INITIAL_MODULES: Record<StepModuleId, ModuleRecord> = {
  specs: { id: "specs", stepNumber: 1, name: "All-Hardware Specs", category: "System", status: "pending", summary: "", notes: "" },
  security: { id: "security", stepNumber: 2, name: "Lock, MDM & License", category: "System", status: "pending", summary: "", notes: "" },
  battery: { id: "battery", stepNumber: 3, name: "Battery & Charging", category: "System", status: "pending", summary: "", notes: "" },
  logs: { id: "logs", stepNumber: 4, name: "System Error Logs", category: "System", status: "pending", summary: "", notes: "" },
  storage: { id: "storage", stepNumber: 5, name: "SSD SMART & Speed", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  display: { id: "display", stepNumber: 6, name: "Display Fullscreen", category: "Interactive", status: "pending", summary: "", notes: "" },
  keyboard: { id: "keyboard", stepNumber: 7, name: "Keyboard Test", category: "Interactive", status: "pending", summary: "", notes: "" },
  biometrics: { id: "biometrics", stepNumber: 8, name: "Fingerprint & Face ID", category: "Interactive", status: "pending", summary: "", notes: "" },
  media: { id: "media", stepNumber: 9, name: "Camera & Microphone", category: "Interactive", status: "pending", summary: "", notes: "" },
  ram: { id: "ram", stepNumber: 10, name: "RAM Stress (TM5)", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  performance: { id: "performance", stepNumber: 11, name: "Performance (PM11)", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  gpu: { id: "gpu", stepNumber: 12, name: "GPU Stress (FurMark)", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  ports_speakers: { id: "ports_speakers", stepNumber: 13, name: "Ports & Speakers", category: "Final Verification", status: "pending", summary: "", notes: "" },
};

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TestModuleId>("dashboard");
  const [unlockedIndex, setUnlockedIndex] = useState<number>(0);
  const [modules, setModules] = useState<Record<StepModuleId, ModuleRecord>>(INITIAL_MODULES);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  const [shopProfile, setShopProfile] = useState<ShopProfile>({
    shopName: "",
    technicianName: "",
    logoDataUrl: null,
    defaultOutputDir: null,
  });

  const [signoff, setSignoff] = useState<PortsSpeakerSignoff>({
    portsChecked: false,
    portsNotes: "",
    speakersChecked: false,
    speakersNotes: "",
  });

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
    (id: StepModuleId, status: TestStatus, summary?: string, notes?: string) => {
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

  // Advance one step forward strictly one-by-one
  const advanceFrom = useCallback((currentId: StepModuleId) => {
    const idx = STEP_ORDER.indexOf(currentId);
    if (idx >= 0 && idx + 1 < STEP_ORDER.length) {
      setUnlockedIndex((prev) => Math.max(prev, idx + 1));
      setActiveTab(STEP_ORDER[idx + 1]);
    } else {
      setReportModalOpen(true);
    }
  }, []);

  // Explicit technician Skip Step button
  const skipStep = useCallback(
    (currentId: StepModuleId) => {
      updateModule(currentId, "skipped", "Explicitly skipped by technician via Skip Step button.");
      advanceFrom(currentId);
    },
    [updateModule, advanceFrom]
  );

  const fetchSpecs = useCallback(async () => {
    updateModule("specs", "running", "Enumerating all hardware subsystems...");
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
    try {
      const rep = await invoke<BatteryHealthReport>("get_battery_health");
      setBatteryReport(rep);
      // Keep status pending until technician confirms live Charge/Discharge (unless no battery present)
      if (!rep.present) {
        updateModule("battery", "notApplicable", rep.notes);
      } else {
        setModules((prev) => ({
          ...prev,
          battery: {
            ...prev.battery,
            summary: `${rep.healthPercent != null ? `${rep.healthPercent.toFixed(1)}% health` : "Detected"}${
              rep.cycleCount != null ? `, ${rep.cycleCount} cycles` : ""
            } — verify live Charge/Discharge.`,
          },
        }));
      }
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
    try {
      const rep = await invoke<StorageSmartReport>("scan_storage_smart");
      setSmartReport(rep);
      setModules((prev) => ({
        ...prev,
        storage: {
          ...prev.storage,
          summary: `${rep.summary} Run SSD Speed Benchmark to complete Step 5.`,
        },
      }));
    } catch (e) {
      updateModule("storage", "warn", `SMART scan error: ${String(e)}`);
    }
  }, [updateModule]);

  const fetchBiometricsHw = useCallback(async () => {
    try {
      const rep = await invoke<BiometricsHardwareReport>("detect_biometrics_hardware");
      setBioHwReport(rep);
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
    invoke<ShopProfile>("load_shop_profile").then(setShopProfile).catch(() => {});
    runAllAutoChecks();
  }, [runAllAutoChecks]);

  const allStepsDone = STEP_ORDER.every((id) => {
    const st = modules[id].status;
    return st !== "pending" && st !== "running";
  });

  const totalSteps = STEP_ORDER.length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-black">
      <Sidebar
        activeTab={activeTab}
        onSelect={setActiveTab}
        stepOrder={STEP_ORDER}
        unlockedIndex={unlockedIndex}
        modules={modules}
        isGamingCapable={specs?.isGamingCapable ?? false}
        allStepsDone={allStepsDone}
        onOpenReportModal={() => setReportModalOpen(true)}
      />

      <main className="flex-1 overflow-y-auto p-6 bg-zinc-50/40">
        <div className="max-w-6xl mx-auto">
          {activeTab === "dashboard" && (
            <DashboardView
              specs={specs}
              stepOrder={STEP_ORDER}
              unlockedIndex={unlockedIndex}
              modules={modules}
              autoRunning={autoRunning}
              allStepsDone={allStepsDone}
              onRunAutoChecks={runAllAutoChecks}
              onStartOrResume={() => setActiveTab(STEP_ORDER[Math.min(unlockedIndex, STEP_ORDER.length - 1)])}
              onSelectModule={setActiveTab}
              onOpenReport={() => setReportModalOpen(true)}
            />
          )}

          {activeTab === "specs" && (
            <SpecsView
              specs={specs}
              loading={modules.specs.status === "running"}
              status={modules.specs.status}
              stepNumber={1}
              totalSteps={totalSteps}
              onRefresh={fetchSpecs}
              onNext={() => advanceFrom("specs")}
              onSkip={() => skipStep("specs")}
            />
          )}

          {activeTab === "security" && (
            <SecurityAuditView
              report={securityReport}
              loading={modules.security.status === "running"}
              status={modules.security.status}
              stepNumber={2}
              totalSteps={totalSteps}
              onRefresh={fetchSecurity}
              onNext={() => advanceFrom("security")}
              onSkip={() => skipStep("security")}
            />
          )}

          {activeTab === "battery" && (
            <BatteryView
              report={batteryReport}
              loading={modules.battery.status === "running"}
              status={modules.battery.status}
              stepNumber={3}
              totalSteps={totalSteps}
              onRefresh={fetchBattery}
              onUpdateStatus={(st, sum) => updateModule("battery", st, sum)}
              onNext={() => advanceFrom("battery")}
              onSkip={() => skipStep("battery")}
            />
          )}

          {activeTab === "logs" && (
            <ErrorLogsView
              report={errorLogsReport}
              loading={modules.logs.status === "running"}
              status={modules.logs.status}
              stepNumber={4}
              totalSteps={totalSteps}
              onScan={fetchErrorLogs}
              onNext={() => advanceFrom("logs")}
              onSkip={() => skipStep("logs")}
            />
          )}

          {activeTab === "storage" && (
            <StorageView
              smartReport={smartReport}
              benchResult={storageBench}
              loadingSmart={modules.storage.status === "running"}
              status={modules.storage.status}
              stepNumber={5}
              totalSteps={totalSteps}
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
                updateModule("storage", combined, `${smartReport?.summary ?? "SMART OK"} | ${res.summary}`);
              }}
              onNext={() => advanceFrom("storage")}
              onSkip={() => skipStep("storage")}
            />
          )}

          {activeTab === "display" && (
            <DisplayTestView
              status={modules.display.status}
              notes={modules.display.notes}
              stepNumber={6}
              totalSteps={totalSteps}
              onVerdict={(st, sum, notes) => updateModule("display", st, sum, notes)}
              onNext={() => advanceFrom("display")}
              onSkip={() => skipStep("display")}
            />
          )}

          {activeTab === "keyboard" && (
            <KeyboardTestView
              osFamily={specs?.osFamily ?? "windows"}
              status={modules.keyboard.status}
              notes={modules.keyboard.notes}
              stepNumber={7}
              totalSteps={totalSteps}
              onVerdict={(st, sum, notes) => updateModule("keyboard", st, sum, notes)}
              onNext={() => advanceFrom("keyboard")}
              onSkip={() => skipStep("keyboard")}
            />
          )}

          {activeTab === "biometrics" && (
            <BiometricsView
              hwReport={bioHwReport}
              loading={false}
              status={modules.biometrics.status}
              stepNumber={8}
              totalSteps={totalSteps}
              onRefresh={fetchBiometricsHw}
              onVerdict={(st, sum) => updateModule("biometrics", st, sum)}
              onNext={() => advanceFrom("biometrics")}
              onSkip={() => skipStep("biometrics")}
            />
          )}

          {activeTab === "media" && (
            <MediaTestView
              status={modules.media.status}
              notes={modules.media.notes}
              stepNumber={9}
              totalSteps={totalSteps}
              onVerdict={(st, sum, notes) => updateModule("media", st, sum, notes)}
              onNext={() => advanceFrom("media")}
              onSkip={() => skipStep("media")}
            />
          )}

          {activeTab === "ram" && (
            <RamTestView
              memoryTypeHint={specs?.ramModules[0]?.memoryType ?? "DDR4"}
              result={ramResult}
              status={modules.ram.status}
              stepNumber={10}
              totalSteps={totalSteps}
              onRunningChange={(r) => {
                if (r) updateModule("ram", "running", "Running TestMem5 multi-threaded RAM stress...");
              }}
              onComplete={(res) => {
                setRamResult(res);
                updateModule("ram", res.status, res.summary);
              }}
              onNext={() => advanceFrom("ram")}
              onSkip={() => skipStep("ram")}
            />
          )}

          {activeTab === "performance" && (
            <PerformanceView
              result={perfResult}
              status={modules.performance.status}
              stepNumber={11}
              totalSteps={totalSteps}
              onRunningChange={(r) => {
                if (r) updateModule("performance", "running", "Running PassMark 11-style 10-stage benchmark...");
              }}
              onComplete={(res) => {
                setPerfResult(res);
                updateModule("performance", res.status, res.summary);
              }}
              onNext={() => advanceFrom("performance")}
              onSkip={() => skipStep("performance")}
            />
          )}

          {activeTab === "gpu" && (
            <GpuStressView
              isGamingCapable={specs?.isGamingCapable ?? false}
              result={gpuResult}
              status={modules.gpu.status}
              stepNumber={12}
              totalSteps={totalSteps}
              onRunningChange={(r) => {
                if (r) updateModule("gpu", "running", "Running native wgpu FurMark-style GPU stress...");
              }}
              onComplete={(res) => {
                setGpuResult(res);
                updateModule("gpu", res.status, res.summary);
              }}
              onMarkNA={() =>
                updateModule("gpu", "notApplicable", "Marked N/A — integrated office laptop GPU.")
              }
              onNext={() => advanceFrom("gpu")}
              onSkip={() => skipStep("gpu")}
            />
          )}

          {activeTab === "ports_speakers" && (
            <PortsSpeakersView
              status={modules.ports_speakers.status}
              signoff={signoff}
              stepNumber={13}
              totalSteps={totalSteps}
              onUpdateSignoff={setSignoff}
              onVerdict={(st, sum) => updateModule("ports_speakers", st, sum)}
              onFinish={() => setReportModalOpen(true)}
              onSkip={() => {
                updateModule("ports_speakers", "skipped", "Explicitly skipped by technician.");
                setReportModalOpen(true);
              }}
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
        stepOrder={STEP_ORDER}
        modules={modules}
        signoff={signoff}
      />
    </div>
  );
};

export default App;
