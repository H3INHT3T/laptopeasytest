import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BatteryHealthReport,
  BatterySagResult,
  BiometricsHardwareReport,
  ErrorLogsReport,
  GpuStressResult,
  LiveTelemetrySnapshot,
  ModuleRecord,
  PerfBenchProgress,
  PerfBenchResult,
  PortsSpeakerSignoff,
  PowerTortureProgress,
  PowerTortureResult,
  RamTestResult,
  SavedSessionPayload,
  SecurityAuditReport,
  ShopProfile,
  StepModuleId,
  StorageBenchResult,
  StorageSmartReport,
  SystemSpecs,
  TestModuleId,
  TestStatus,
  VramTestResult,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { TopTelemetryStrip } from "./components/TopTelemetryStrip";
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
  keyboard: { id: "keyboard", stepNumber: 7, name: "Keyboard & Touchpad", category: "Interactive", status: "pending", summary: "", notes: "" },
  biometrics: { id: "biometrics", stepNumber: 8, name: "Fingerprint & Face ID", category: "Interactive", status: "pending", summary: "", notes: "" },
  media: { id: "media", stepNumber: 9, name: "Camera & Microphone", category: "Interactive", status: "pending", summary: "", notes: "" },
  ram: { id: "ram", stepNumber: 10, name: "RAM Stress (TM5)", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  performance: { id: "performance", stepNumber: 11, name: "360° Perf & Creator", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  gpu: { id: "gpu", stepNumber: 12, name: "GPU, VRAM & Power", category: "Deep Stress", status: "pending", summary: "", notes: "" },
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
  const [liveTelemetry, setLiveTelemetry] = useState<LiveTelemetrySnapshot | null>(null);
  const [activeStressStage, setActiveStressStage] = useState<string | null>(null);
  const [savedSession, setSavedSession] = useState<SavedSessionPayload | null>(null);
  const [crashAlert, setCrashAlert] = useState<string | null>(null);
  const sessionCheckedRef = useRef<boolean>(false);

  const [securityReport, setSecurityReport] = useState<SecurityAuditReport | null>(null);
  const [batteryReport, setBatteryReport] = useState<BatteryHealthReport | null>(null);
  const [batterySagResult, setBatterySagResult] = useState<BatterySagResult | null>(null);
  const [errorLogsReport, setErrorLogsReport] = useState<ErrorLogsReport | null>(null);
  const [smartReport, setSmartReport] = useState<StorageSmartReport | null>(null);
  const [storageBench, setStorageBench] = useState<StorageBenchResult | null>(null);
  const [ramResult, setRamResult] = useState<RamTestResult | null>(null);
  const [bioHwReport, setBioHwReport] = useState<BiometricsHardwareReport | null>(null);
  const [perfResult, setPerfResult] = useState<PerfBenchResult | null>(null);
  const [gpuResult, setGpuResult] = useState<GpuStressResult | null>(null);
  const [vramResult, setVramResult] = useState<VramTestResult | null>(null);
  const [tortureResult, setTortureResult] = useState<PowerTortureResult | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);

  // Crash-Safe Session Checkpoint Saver
  const persistSession = useCallback(
    (
      nextUnlocked: number,
      nextModules: Record<StepModuleId, ModuleRecord>,
      nextSignoff: PortsSpeakerSignoff,
      stressTag: string | null
    ) => {
      if (!specs?.serialNumber) return;
      const stateJson = JSON.stringify({
        unlockedIndex: nextUnlocked,
        modules: nextModules,
        signoff: nextSignoff,
      });
      invoke("save_qc_session", {
        serial: specs.serialNumber,
        model: `${specs.manufacturer} ${specs.model}`.trim(),
        activeStressStage: stressTag,
        stateJson,
      }).catch(() => {});
    },
    [specs]
  );

  const updateModule = useCallback(
    (id: StepModuleId, status: TestStatus, summary?: string, notes?: string) => {
      setModules((prev) => {
        const next = {
          ...prev,
          [id]: {
            ...prev[id],
            status,
            summary: summary !== undefined ? summary : prev[id].summary,
            notes: notes !== undefined ? notes : prev[id].notes,
          },
        };
        if (status !== "running") {
          persistSession(unlockedIndex, next, signoff, null);
        }
        return next;
      });
    },
    [persistSession, unlockedIndex, signoff]
  );

  const setStressActive = useCallback(
    (stageTag: string | null) => {
      setActiveStressStage(stageTag);
      persistSession(unlockedIndex, modules, signoff, stageTag);
    },
    [persistSession, unlockedIndex, modules, signoff]
  );

  const advanceFrom = useCallback(
    (currentId: StepModuleId) => {
      const idx = STEP_ORDER.indexOf(currentId);
      if (idx >= 0 && idx + 1 < STEP_ORDER.length) {
        const nextUnlocked = Math.max(unlockedIndex, idx + 1);
        setUnlockedIndex(nextUnlocked);
        setActiveTab(STEP_ORDER[idx + 1]);
        persistSession(nextUnlocked, modules, signoff, null);
      } else {
        setReportModalOpen(true);
      }
    },
    [unlockedIndex, modules, signoff, persistSession]
  );

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
      const warns = [sp.ramConfigWarning, sp.wifiAntennaWarning].filter(Boolean);
      updateModule(
        "specs",
        warns.length > 0 ? "warn" : "pass",
        `${sp.manufacturer} ${sp.model} | ${sp.cpuBrand} | ${sp.totalRamGb.toFixed(0)} GB RAM | S/N ${sp.serialNumber}${
          warns.length > 0 ? ` | ALERT: ${warns[0]}` : ""
        }`
      );
      // Check crash-safe persisted session once per boot
      if (!sessionCheckedRef.current && sp.serialNumber) {
        sessionCheckedRef.current = true;
        const prev = await invoke<SavedSessionPayload | null>("load_qc_session", {
          serial: sp.serialNumber,
        }).catch(() => null);
        if (prev) {
          try {
            const parsed = JSON.parse(prev.stateJson) as { unlockedIndex?: number };
            if ((parsed.unlockedIndex ?? 0) > 0 || prev.activeStressStage) {
              setSavedSession(prev);
            }
          } catch {
            // Corrupt session file ignored
          }
        }
      }
    } catch (e) {
      updateModule("specs", "warn", `Spec scan error: ${String(e)}`);
    }
  }, [updateModule]);

  const handleResumeSession = useCallback(() => {
    if (!savedSession) return;
    try {
      const parsed = JSON.parse(savedSession.stateJson) as {
        unlockedIndex: number;
        modules: Record<StepModuleId, ModuleRecord>;
        signoff: PortsSpeakerSignoff;
      };
      const restoredModules = { ...INITIAL_MODULES, ...parsed.modules };
      // If laptop hard-crashed / BSOD'd mid-stress, automatically flag FAIL on that stage!
      if (savedSession.activeStressStage) {
        const tag = savedSession.activeStressStage;
        const msg = `UNEXPECTED SHUTDOWN / CRASH DETECTED DURING ${tag} (prior session at ${savedSession.savedAt})!`;
        setCrashAlert(msg);
        const targetId: StepModuleId = tag.includes("10")
          ? "ram"
          : tag.includes("11")
          ? "performance"
          : tag.includes("12")
          ? "gpu"
          : "storage";
        restoredModules[targetId] = {
          ...restoredModules[targetId],
          status: "fail",
          summary: msg,
        };
      }
      setUnlockedIndex(parsed.unlockedIndex ?? 0);
      setModules(restoredModules);
      if (parsed.signoff) setSignoff(parsed.signoff);
      setSavedSession(null);
      persistSession(parsed.unlockedIndex ?? 0, restoredModules, parsed.signoff ?? signoff, null);
    } catch {
      setSavedSession(null);
    }
  }, [savedSession, persistSession, signoff]);

  const handleDiscardSession = useCallback(() => {
    if (specs?.serialNumber) {
      invoke("clear_qc_session", { serial: specs.serialNumber }).catch(() => {});
    }
    setSavedSession(null);
    setCrashAlert(null);
  }, [specs]);

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
      if (!rep.present) {
        updateModule("battery", "notApplicable", rep.notes);
      } else {
        setModules((prev) => ({
          ...prev,
          battery: {
            ...prev.battery,
            summary: `${rep.healthPercent != null ? `${rep.healthPercent.toFixed(1)}% health` : "Detected"}${
              rep.cycleCount != null ? `, ${rep.cycleCount} cycles` : ""
            } — verify live Charge/Discharge or 15s Sag Pulse.`,
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
          summary: `${rep.summary} Run Direct-IO SSD Benchmark to complete Stage 05.`,
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

  // Persistent Live Docked Telemetry Polling — PAUSES automatically during active stress benchmarks
  // to eliminate background probe jitter, while feeding directly from active benchmark streams!
  useEffect(() => {
    if (activeStressStage !== null) {
      return;
    }
    let active = true;
    const poll = () => {
      invoke<LiveTelemetrySnapshot>("sample_live_telemetry")
        .then((snap) => {
          if (active) setLiveTelemetry(snap);
        })
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 3500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [activeStressStage]);

  // Feed TopTelemetryStrip directly from active Performance / Power Torture streams!
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      if (ev.payload.telemetry) setLiveTelemetry(ev.payload.telemetry);
    }).then((fn) => unlisteners.push(fn));
    listen<PowerTortureProgress>("torture:progress", (ev) => {
      if (ev.payload.telemetry) setLiveTelemetry(ev.payload.telemetry);
    }).then((fn) => unlisteners.push(fn));
    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const completedCount = STEP_ORDER.filter((id) => {
    const st = modules[id].status;
    return st !== "pending" && st !== "running";
  }).length;
  const allStepsDone = completedCount === STEP_ORDER.length;
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

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <TopTelemetryStrip
          specs={specs}
          telemetry={liveTelemetry}
          completedCount={completedCount}
          totalSteps={totalSteps}
        />

        <main className="flex-1 overflow-y-auto p-5 bg-[#FAFAFA]">
          <div className="max-w-6xl mx-auto">
            {activeTab === "dashboard" && (
              <DashboardView
                specs={specs}
                stepOrder={STEP_ORDER}
                unlockedIndex={unlockedIndex}
                modules={modules}
                autoRunning={autoRunning}
                allStepsDone={allStepsDone}
                savedSession={savedSession}
                crashAlert={crashAlert}
                onResumeSession={handleResumeSession}
                onDiscardSession={handleDiscardSession}
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
                sagResult={batterySagResult}
                loading={modules.battery.status === "running"}
                status={modules.battery.status}
                stepNumber={3}
                totalSteps={totalSteps}
                onRefresh={fetchBattery}
                onSagComplete={(res) => {
                  setBatterySagResult(res);
                  if (res.status === "fail") {
                    updateModule("battery", "fail", res.summary);
                  }
                }}
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
                telemetry={liveTelemetry}
                volumes={specs?.volumes ?? []}
                smartReport={smartReport}
                benchResult={storageBench}
                loadingSmart={modules.storage.status === "running"}
                status={modules.storage.status}
                stepNumber={5}
                totalSteps={totalSteps}
                onRefreshSmart={fetchSmart}
                onRunningChange={(r) => setStressActive(r ? "Stage 05: SSD Direct-IO" : null)}
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
                telemetry={liveTelemetry}
                memoryTypeHint={specs?.ramModules[0]?.memoryType ?? "DDR4"}
                result={ramResult}
                status={modules.ram.status}
                stepNumber={10}
                totalSteps={totalSteps}
                onRunningChange={(r) => {
                  setStressActive(r ? "Stage 10: RAM TestMem5 Stress" : null);
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
                telemetry={liveTelemetry}
                manufacturer={specs?.manufacturer}
                model={specs?.model}
                result={perfResult}
                status={modules.performance.status}
                stepNumber={11}
                totalSteps={totalSteps}
                onRunningChange={(r) => {
                  setStressActive(r ? "Stage 11: 360° Performance Suite" : null);
                  if (r) updateModule("performance", "running", "Running 14-Stage All-Scope Performance & Creator Suite...");
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
                telemetry={liveTelemetry}
                isGamingCapable={specs?.isGamingCapable ?? false}
                result={gpuResult}
                vramResult={vramResult}
                tortureResult={tortureResult}
                status={modules.gpu.status}
                stepNumber={12}
                totalSteps={totalSteps}
                onRunningChange={(r) => {
                  setStressActive(r ? "Stage 12: GPU / VRAM / Power Torture" : null);
                  if (r) updateModule("gpu", "running", "Running native wgpu GPU / VRAM / Combined Power Stress...");
                }}
                onComplete={(res) => {
                  setGpuResult(res);
                  const statuses = [res.status, vramResult?.status, tortureResult?.status].filter(Boolean) as TestStatus[];
                  const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
                  const parts = [res.summary, vramResult?.summary, tortureResult?.summary].filter(Boolean).join(" | ");
                  updateModule("gpu", merged, parts);
                }}
                onVramComplete={(res) => {
                  setVramResult(res);
                  const statuses = [gpuResult?.status, res.status, tortureResult?.status].filter(Boolean) as TestStatus[];
                  const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
                  const parts = [gpuResult?.summary, res.summary, tortureResult?.summary].filter(Boolean).join(" | ");
                  updateModule("gpu", merged, parts);
                }}
                onTortureComplete={(res) => {
                  setTortureResult(res);
                  const statuses = [gpuResult?.status, vramResult?.status, res.status].filter(Boolean) as TestStatus[];
                  const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
                  const parts = [gpuResult?.summary, vramResult?.summary, res.summary].filter(Boolean).join(" | ");
                  updateModule("gpu", merged, parts);
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
      </div>

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
        securityReport={securityReport}
        batteryReport={batteryReport}
        batterySagResult={batterySagResult}
        errorLogsReport={errorLogsReport}
        smartReport={smartReport}
        storageBench={storageBench}
        ramResult={ramResult}
        perfResult={perfResult}
        gpuResult={gpuResult}
        vramResult={vramResult}
        tortureResult={tortureResult}
      />
    </div>
  );
};

export default App;
