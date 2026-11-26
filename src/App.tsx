import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BatteryDischargeResult,
  BatteryHealthReport,
  BatterySagResult,
  BiometricsHardwareReport,
  CpuStressResult,
  ErrorLogsReport,
  GpuStressResult,
  LiveTelemetrySnapshot,
  ModuleRecord,
  NetworkDiagnosticsReport,
  PerfBenchProgress,
  PerfBenchResult,
  PortsSpeakerSignoff,
  PowerTortureProgress,
  PowerTortureResult,
  RamTestResult,
  SavedSessionPayload,
  SavedSessionState,
  SecurityAuditReport,
  ShopProfile,
  StepModuleId,
  StorageBenchResult,
  StorageSmartReport,
  SystemSpecs,
  TestModuleId,
  TestStatus,
  TouchscreenTestResult,
  UserBenchmarkComparison,
  UserBenchmarkInput,
  VramTestResult,
  WarrantyReturnDiff,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { TopTelemetryStrip } from "./components/TopTelemetryStrip";
import { SystemInfoRail } from "./components/SystemInfoRail";
import { BottomSensorsDock } from "./components/BottomSensorsDock";
import { PreReportModal } from "./components/PreReportModal";
import { DashboardView } from "./tests/DashboardView";
import { StressHubView } from "./tests/StressHubView";
import { ArchiveView } from "./tests/ArchiveView";
import { SpecsView } from "./tests/SpecsView";
import { SecurityAuditView } from "./tests/SecurityAuditView";
import { BatteryView } from "./tests/BatteryView";
import { ErrorLogsView } from "./tests/ErrorLogsView";
import { DisplayTestView } from "./tests/DisplayTestView";
import { TouchscreenTestView } from "./tests/TouchscreenTestView";
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
  "touchscreen",
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
  touchscreen: { id: "touchscreen", stepNumber: 7, name: "Touchscreen & Multi-Touch", category: "Interactive", status: "pending", summary: "", notes: "" },
  keyboard: { id: "keyboard", stepNumber: 8, name: "Keyboard & Touchpad", category: "Interactive", status: "pending", summary: "", notes: "" },
  biometrics: { id: "biometrics", stepNumber: 9, name: "Fingerprint & Face ID", category: "Interactive", status: "pending", summary: "", notes: "" },
  media: { id: "media", stepNumber: 10, name: "Camera & Microphone", category: "Interactive", status: "pending", summary: "", notes: "" },
  ram: { id: "ram", stepNumber: 11, name: "RAM Stress (TM5)", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  performance: { id: "performance", stepNumber: 12, name: "360° Perf & Creator", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  gpu: { id: "gpu", stepNumber: 13, name: "GPU, VRAM & Power", category: "Deep Stress", status: "pending", summary: "", notes: "" },
  ports_speakers: { id: "ports_speakers", stepNumber: 14, name: "Ports & Speakers", category: "Final Verification", status: "pending", summary: "", notes: "" },
};

function stepNumberOf(id: StepModuleId): number {
  return STEP_ORDER.indexOf(id) + 1;
}

function resolveCrashStageId(tag: string): StepModuleId {
  const upper = tag.toUpperCase();
  if (upper.includes("GPU") || upper.includes("VRAM") || upper.includes("TORTURE")) {
    return "gpu";
  }
  if (upper.includes("PERFORMANCE") || upper.includes("360") || upper.includes("CREATOR")) {
    return "performance";
  }
  if (upper.includes("TESTMEM") || upper.includes("TM5") || /\bRAM\b/.test(upper)) {
    return "ram";
  }
  if (upper.includes("SSD") || upper.includes("STORAGE") || upper.includes("DIRECT-IO")) {
    return "storage";
  }
  if (upper.includes("13")) {
    return "gpu";
  }
  if (upper.includes("12")) {
    return "performance";
  }
  if (upper.includes("11") || upper.includes("10")) {
    return "ram";
  }
  return "storage";
}

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
  const [, setActiveStressStage] = useState<string | null>(null);
  const [stressPaused, setStressPaused] = useState(false);
  const [savedSession, setSavedSession] = useState<SavedSessionPayload | null>(null);
  const [crashAlert, setCrashAlert] = useState<string | null>(null);
  const sessionCheckedRef = useRef<boolean>(false);

  const [securityReport, setSecurityReport] = useState<SecurityAuditReport | null>(null);
  const [batteryReport, setBatteryReport] = useState<BatteryHealthReport | null>(null);
  const [batterySagResult, setBatterySagResult] = useState<BatterySagResult | null>(null);
  const [batteryDischargeResult, setBatteryDischargeResult] = useState<BatteryDischargeResult | null>(null);
  const [errorLogsReport, setErrorLogsReport] = useState<ErrorLogsReport | null>(null);
  const [smartReport, setSmartReport] = useState<StorageSmartReport | null>(null);
  const [storageBench, setStorageBench] = useState<StorageBenchResult | null>(null);
  const [touchscreenResult, setTouchscreenResult] = useState<TouchscreenTestResult | null>(null);
  const [ramResult, setRamResult] = useState<RamTestResult | null>(null);
  const [bioHwReport, setBioHwReport] = useState<BiometricsHardwareReport | null>(null);
  const [perfResult, setPerfResult] = useState<PerfBenchResult | null>(null);
  const [cpuStressResult, setCpuStressResult] = useState<CpuStressResult | null>(null);
  const [gpuResult, setGpuResult] = useState<GpuStressResult | null>(null);
  const [vramResult, setVramResult] = useState<VramTestResult | null>(null);
  const [tortureResult, setTortureResult] = useState<PowerTortureResult | null>(null);
  const [networkReport, setNetworkReport] = useState<NetworkDiagnosticsReport | null>(null);
  const [loadingNetwork, setLoadingNetwork] = useState(false);
  const [userbenchmarkComparison, setUserbenchmarkComparison] = useState<UserBenchmarkComparison | null>(null);
  const [warrantyDiff, setWarrantyDiff] = useState<WarrantyReturnDiff | null>(null);
  const [expressQueue, setExpressQueue] = useState<{
    running: boolean;
    mode: "fast" | "deep";
    stepLabel: string;
    percent: number;
  } | null>(null);
  const expressCancelRef = useRef(false);
  const [autoRunning, setAutoRunning] = useState(false);

  // Refs to prevent stale closures in skipStep / advanceFrom / persistSession
  const modulesRef = useRef(modules);
  modulesRef.current = modules;
  const unlockedIndexRef = useRef(unlockedIndex);
  unlockedIndexRef.current = unlockedIndex;
  const signoffRef = useRef(signoff);
  signoffRef.current = signoff;
  const touchscreenResultRef = useRef(touchscreenResult);
  touchscreenResultRef.current = touchscreenResult;
  const batteryDischargeResultRef = useRef(batteryDischargeResult);
  batteryDischargeResultRef.current = batteryDischargeResult;
  const networkReportRef = useRef(networkReport);
  networkReportRef.current = networkReport;
  const userbenchmarkRef = useRef(userbenchmarkComparison);
  userbenchmarkRef.current = userbenchmarkComparison;
  const ubLatestRef = useRef<UserBenchmarkComparison | null>(userbenchmarkComparison);
  ubLatestRef.current = userbenchmarkComparison;
  const ubGenRef = useRef(0);
  const allowLiveLookupRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const specsRef = useRef(specs);
  specsRef.current = specs;
  const perfRef = useRef(perfResult);
  perfRef.current = perfResult;
  const gpuRef = useRef(gpuResult);
  gpuRef.current = gpuResult;
  const storageRef = useRef(storageBench);
  storageRef.current = storageBench;
  const ramRef = useRef(ramResult);
  ramRef.current = ramResult;

  // Crash-Safe Session Checkpoint Saver
  const persistSession = useCallback(
    (
      nextUnlocked: number,
      nextModules: Record<StepModuleId, ModuleRecord>,
      nextSignoff: PortsSpeakerSignoff,
      stressTag: string | null,
      overrides?: Partial<
        Pick<
          SavedSessionState,
          "touchscreenResult" | "batteryDischargeResult" | "networkReport" | "userbenchmarkComparison"
        >
      >
    ) => {
      if (!specs?.serialNumber) return;
      const payloadState: SavedSessionState = {
        unlockedIndex: nextUnlocked,
        modules: nextModules,
        signoff: nextSignoff,
        touchscreenResult:
          overrides && "touchscreenResult" in overrides
            ? overrides.touchscreenResult
            : touchscreenResultRef.current,
        batteryDischargeResult:
          overrides && "batteryDischargeResult" in overrides
            ? overrides.batteryDischargeResult
            : batteryDischargeResultRef.current,
        networkReport:
          overrides && "networkReport" in overrides
            ? overrides.networkReport
            : networkReportRef.current,
        userbenchmarkComparison:
          overrides && "userbenchmarkComparison" in overrides
            ? overrides.userbenchmarkComparison
            : userbenchmarkRef.current,
      };
      const stateJson = JSON.stringify(payloadState);
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
      const prev = modulesRef.current;
      const next: Record<StepModuleId, ModuleRecord> = {
        ...prev,
        [id]: {
          ...prev[id],
          status,
          summary: summary !== undefined ? summary : prev[id].summary,
          notes: notes !== undefined ? notes : prev[id].notes,
        },
      };
      modulesRef.current = next;
      setModules(next);
      if (status !== "running") {
        persistSession(unlockedIndexRef.current, next, signoffRef.current, null);
      }
      return next;
    },
    [persistSession]
  );

  const setStressActive = useCallback(
    (stageTag: string | null) => {
      setActiveStressStage(stageTag);
      persistSession(unlockedIndexRef.current, modulesRef.current, signoffRef.current, stageTag);
    },
    [persistSession]
  );

  const advanceFrom = useCallback(
    (currentId: StepModuleId) => {
      const idx = STEP_ORDER.indexOf(currentId);
      if (idx >= 0 && idx + 1 < STEP_ORDER.length) {
        const nextUnlocked = Math.max(unlockedIndexRef.current, idx + 1);
        unlockedIndexRef.current = nextUnlocked;
        setUnlockedIndex(nextUnlocked);
        setActiveTab(STEP_ORDER[idx + 1]);
        persistSession(nextUnlocked, modulesRef.current, signoffRef.current, null);
      } else {
        setReportModalOpen(true);
      }
    },
    [persistSession]
  );

  const skipStep = useCallback(
    (currentId: StepModuleId) => {
      const nextModules = updateModule(
        currentId,
        "skipped",
        "Explicitly skipped by technician via Skip Step button."
      );
      modulesRef.current = nextModules;
      advanceFrom(currentId);
    },
    [updateModule, advanceFrom]
  );

  const refreshUserbenchmarkComparison = useCallback(
    async (overrides?: Partial<UserBenchmarkInput>) => {
      const sp = overrides?.specs !== undefined ? overrides.specs : specsRef.current;
      const perf = overrides?.perf !== undefined ? overrides.perf : perfRef.current;
      const gpu = overrides?.gpu !== undefined ? overrides.gpu : gpuRef.current;
      const storage = overrides?.storage !== undefined ? overrides.storage : storageRef.current;
      const ram = overrides?.ram !== undefined ? overrides.ram : ramRef.current;

      if (!sp && !perf && !gpu && !storage && !ram && !overrides) {
        return null;
      }

      if (overrides?.allowLiveLookup !== undefined) {
        allowLiveLookupRef.current = overrides.allowLiveLookup;
      }
      const reqGen = ++ubGenRef.current;

      const input: UserBenchmarkInput = {
        cpuBrand: sp?.cpuBrand,
        cpuPhysicalCores: sp?.cpuPhysicalCores ?? null,
        cpuLogicalCores: sp?.cpuLogicalCores ?? null,
        cpuSingleCore: perf?.singleCoreScore ?? null,
        cpuMultiCore: perf?.multiCoreScore ?? null,
        cpuComposite: perf?.compositeScore ?? null,
        gpuName: gpu?.adapterName ?? sp?.gpus[0]?.name ?? null,
        gpuResolution: gpu?.resolution ?? null,
        gpuAvgFps: gpu?.avgFps ?? null,
        gpuFpsDropPct: gpu?.fpsDropPct ?? null,
        gpuThermalCutoff: gpu?.thermalCutoffTriggered ?? false,
        ssdModel: sp?.disks[0]?.model ?? null,
        ssdInterface: sp?.disks[0]?.interfaceType ?? null,
        ssdMediaType: sp?.disks[0]?.mediaType ?? null,
        ssdSeqReadMbS: storage?.seqReadMbS ?? null,
        ssdSeqWriteMbS: storage?.seqWriteMbS ?? null,
        ssdRand4kReadMbS: storage?.rand4kReadMbS ?? null,
        ssdRand4kWriteMbS: storage?.rand4kWriteMbS ?? null,
        ssdIntegrityErrors: storage?.integrityErrors ?? 0,
        ramType: sp?.ramModules[0]?.memoryType ?? null,
        ramBandwidthGbS: ram?.avgBandwidthGbS ?? perf?.memoryBandwidthGbS ?? null,
        ramLatencyNs: perf?.memoryLatencyNs ?? null,
        ramChannelMode: sp?.ramChannelMode ?? null,
        ramErrorsFound: ram?.errorsFound ?? 0,
        allowLiveLookup: overrides?.allowLiveLookup ?? allowLiveLookupRef.current,
        specs: sp ?? null,
        perf: perf ?? null,
        gpu: gpu ?? null,
        storage: storage ?? null,
        ram: ram ?? null,
        ...overrides,
      };

      try {
        const comp = await invoke<UserBenchmarkComparison>("compare_userbenchmark", { input });
        if (!isMountedRef.current || reqGen !== ubGenRef.current) {
          return null;
        }
        if (comp && typeof comp === "object") {
          const prev = ubLatestRef.current;
          const scoresChanged =
            !prev ||
            prev.gamingPct !== comp.gamingPct ||
            prev.desktopPct !== comp.desktopPct ||
            prev.workstationPct !== comp.workstationPct ||
            prev.cpu?.detectedModel !== comp.cpu?.detectedModel ||
            prev.cpu?.effectiveSpeedPct !== comp.cpu?.effectiveSpeedPct ||
            prev.gpu?.detectedModel !== comp.gpu?.detectedModel ||
            prev.gpu?.effectiveSpeedPct !== comp.gpu?.effectiveSpeedPct ||
            prev.ssd?.detectedModel !== comp.ssd?.detectedModel ||
            prev.ssd?.effectiveSpeedPct !== comp.ssd?.effectiveSpeedPct ||
            prev.ram?.detectedModel !== comp.ram?.detectedModel ||
            prev.ram?.effectiveSpeedPct !== comp.ram?.effectiveSpeedPct;

          if (
            prev?.sourceMode === "live_verified" &&
            comp.sourceMode === "offline_calibrated" &&
            overrides?.allowLiveLookup !== false &&
            !scoresChanged
          ) {
            return prev;
          }
          ubLatestRef.current = comp;
          userbenchmarkRef.current = comp;
          setUserbenchmarkComparison(comp);
          return comp;
        }
      } catch {
        // Non-blocking fallback
      }
      return null;
    },
    []
  );

  const runNetworkDiagnostics = useCallback(async () => {
    setLoadingNetwork(true);
    try {
      const rep = await invoke<NetworkDiagnosticsReport>("run_network_diagnostics");
      if (rep && typeof rep === "object") {
        setNetworkReport(rep);
        networkReportRef.current = rep;
        return rep;
      }
    } catch {
      // Non-blocking network probe
    } finally {
      setLoadingNetwork(false);
    }
    return null;
  }, []);

  const fetchSpecs = useCallback(async () => {
    updateModule("specs", "running", "Enumerating all hardware subsystems...");
    try {
      const sp = await invoke<SystemSpecs>("get_system_specs");
      setSpecs(sp);
      specsRef.current = sp;
      const warns = [sp.ramConfigWarning, sp.wifiAntennaWarning].filter(Boolean);
      updateModule(
        "specs",
        warns.length > 0 ? "warn" : "pass",
        `${sp.manufacturer} ${sp.model} | ${sp.cpuBrand} | ${sp.totalRamGb.toFixed(0)} GB RAM | S/N ${sp.serialNumber}${
          warns.length > 0 ? ` | ALERT: ${warns[0]}` : ""
        }`
      );
      refreshUserbenchmarkComparison({ specs: sp }).catch(() => {});
      // Check crash-safe persisted session once per boot
      if (!sessionCheckedRef.current && sp.serialNumber) {
        sessionCheckedRef.current = true;
        const prev = await invoke<SavedSessionPayload | null>("load_qc_session", {
          serial: sp.serialNumber,
        }).catch(() => null);
        if (prev) {
          try {
            const parsed = JSON.parse(prev.stateJson) as Partial<SavedSessionState>;
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
  }, [updateModule, refreshUserbenchmarkComparison]);

  const handleResumeSession = useCallback(() => {
    if (!savedSession) return;
    try {
      const parsed = JSON.parse(savedSession.stateJson) as Partial<SavedSessionState>;
      const savedMods = (parsed.modules ?? {}) as Partial<Record<StepModuleId, ModuleRecord>>;
      const restoredModules: Record<StepModuleId, ModuleRecord> = { ...INITIAL_MODULES };

      for (const id of STEP_ORDER) {
        const savedMod = savedMods[id];
        if (savedMod) {
          restoredModules[id] = {
            ...INITIAL_MODULES[id],
            ...savedMod,
            id,
            stepNumber: INITIAL_MODULES[id].stepNumber,
            name: INITIAL_MODULES[id].name,
            category: INITIAL_MODULES[id].category,
          };
        }
      }

      // Legacy 13-step session migration: if touchscreen wasn't present and keyboard was already unlocked/used, shift unlockedIndex by +1
      let nextUnlocked = Math.max(0, Math.min(STEP_ORDER.length - 1, parsed.unlockedIndex ?? 0));
      const hadTouchscreen = Object.prototype.hasOwnProperty.call(savedMods, "touchscreen");
      if (!hadTouchscreen && (savedMods.keyboard?.status && savedMods.keyboard.status !== "pending")) {
        nextUnlocked = Math.min(STEP_ORDER.length - 1, nextUnlocked + 1);
      }

      // If laptop hard-crashed / BSOD'd mid-stress, automatically flag FAIL on that stage
      if (savedSession.activeStressStage) {
        const tag = savedSession.activeStressStage;
        const msg = `UNEXPECTED SHUTDOWN / CRASH DETECTED DURING ${tag} (prior session at ${savedSession.savedAt})!`;
        setCrashAlert(msg);
        const targetId = resolveCrashStageId(tag);
        restoredModules[targetId] = {
          ...restoredModules[targetId],
          status: "fail",
          summary: msg,
        };
      }

      const nextSignoff = parsed.signoff ?? signoffRef.current;
      if (parsed.touchscreenResult !== undefined) {
        setTouchscreenResult(parsed.touchscreenResult ?? null);
        touchscreenResultRef.current = parsed.touchscreenResult ?? null;
      }
      if (parsed.batteryDischargeResult !== undefined) {
        setBatteryDischargeResult(parsed.batteryDischargeResult ?? null);
        batteryDischargeResultRef.current = parsed.batteryDischargeResult ?? null;
      }
      if (parsed.networkReport !== undefined) {
        setNetworkReport(parsed.networkReport ?? null);
        networkReportRef.current = parsed.networkReport ?? null;
      }
      if (parsed.userbenchmarkComparison !== undefined) {
        ubGenRef.current += 1;
        allowLiveLookupRef.current = parsed.userbenchmarkComparison?.sourceMode === "live_verified";
        ubLatestRef.current = parsed.userbenchmarkComparison ?? null;
        userbenchmarkRef.current = parsed.userbenchmarkComparison ?? null;
        setUserbenchmarkComparison(parsed.userbenchmarkComparison ?? null);
      }

      unlockedIndexRef.current = nextUnlocked;
      modulesRef.current = restoredModules;
      signoffRef.current = nextSignoff;
      setUnlockedIndex(nextUnlocked);
      setModules(restoredModules);
      setSignoff(nextSignoff);
      setSavedSession(null);
      persistSession(nextUnlocked, restoredModules, nextSignoff, null, {
        touchscreenResult: parsed.touchscreenResult ?? null,
        batteryDischargeResult: parsed.batteryDischargeResult ?? null,
        networkReport: parsed.networkReport ?? null,
        userbenchmarkComparison: parsed.userbenchmarkComparison ?? null,
      });
    } catch {
      setSavedSession(null);
    }
  }, [savedSession, persistSession]);

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
        setModules((prev) => {
          const next = {
            ...prev,
            battery: {
              ...prev.battery,
              summary: `${rep.healthPercent != null ? `${rep.healthPercent.toFixed(1)}% health` : "Detected"}${
                rep.cycleCount != null ? `, ${rep.cycleCount} cycles` : ""
              } — verify live Charge/Discharge or 15s Sag Pulse.`,
            },
          };
          modulesRef.current = next;
          return next;
        });
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
      setModules((prev) => {
        const next = {
          ...prev,
          storage: {
            ...prev.storage,
            summary: `${rep.summary} Run Direct-IO SSD Benchmark to complete Stage ${String(stepNumberOf("storage")).padStart(2, "0")}.`,
          },
        };
        modulesRef.current = next;
        return next;
      });
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
      runNetworkDiagnostics(),
      invoke("get_hardware_controls_status").catch(() => null),
    ]);
    setAutoRunning(false);
  }, [fetchSpecs, fetchSecurity, fetchBattery, fetchErrorLogs, fetchSmart, fetchBiometricsHw, runNetworkDiagnostics]);

  useEffect(() => {
    invoke<ShopProfile>("load_shop_profile").then(setShopProfile).catch(() => {});
    runAllAutoChecks();
  }, [runAllAutoChecks]);

  // Automatic Return-Unit Warranty Anti-Fraud Diff when serial + hardware probes complete
  useEffect(() => {
    if (!specs?.serialNumber) return;
    invoke<WarrantyReturnDiff | null>("check_warranty_return_diff", {
      serial: specs.serialNumber,
      currentBatteryHealth: batteryReport?.healthPercent ?? null,
      currentSsdSerial: specs.disks[0]?.serialNumber ?? null,
      currentSsdWear: smartReport?.drives[0]?.wearPercent ?? null,
      currentRamGb: specs.totalRamGb,
    })
      .then((diff) => setWarrantyDiff(diff ?? null))
      .catch(() => {});
  }, [specs, batteryReport, smartReport]);

  const cancelExpressAutoQc = useCallback(() => {
    expressCancelRef.current = true;
    invoke("cancel_storage_benchmark").catch(() => {});
    invoke("cancel_ram_stress").catch(() => {});
    invoke("cancel_performance_benchmark").catch(() => {});
    invoke("cancel_gpu_stress").catch(() => {});
    setExpressQueue(null);
  }, []);

  const runExpressAutoQc = useCallback(
    async (mode: "fast" | "deep") => {
      expressCancelRef.current = false;
      const isDeep = mode === "deep";
      setExpressQueue({ running: true, mode, stepLabel: "1/5 Refreshing Specs, BIOS, Battery, Logs & SMART...", percent: 10 });
      try {
        await runAllAutoChecks();
        if (expressCancelRef.current) return;

        // Auto-unlock through Stage 05 (SSD)
        setUnlockedIndex((u) => Math.max(u, 4));

        // Storage Direct-IO
        setExpressQueue({ running: true, mode, stepLabel: "2/5 Running SSD Direct-IO Benchmark...", percent: 30 });
        try {
          const ssd = await invoke<StorageBenchResult>("run_storage_benchmark", {
            preset: isDeep ? "standard" : "quick",
            interfaceHint: specsRef.current?.disks[0]?.interfaceType ?? null,
            mediaHint: specsRef.current?.disks[0]?.mediaType ?? null,
            targetMount: null,
          });
          setStorageBench(ssd);
          storageRef.current = ssd;
          updateModule("storage", ssd.status, ssd.summary);
        } catch {
          // Continue queue if drive low space
        }
        if (expressCancelRef.current) return;

        if (isDeep) {
          setExpressQueue({ running: true, mode, stepLabel: "3/5 Running TestMem5 RAM Stress...", percent: 55 });
          try {
            const ram = await invoke<RamTestResult>("run_ram_stress", {
              preset: "quick",
              memoryPercent: 55,
              customDurationSecs: 45,
              memoryTypeHint: specsRef.current?.ramModules[0]?.memoryType ?? "DDR4",
            });
            setRamResult(ram);
            ramRef.current = ram;
            updateModule("ram", ram.status, ram.summary);
          } catch {}
        }
        if (expressCancelRef.current) return;

        setExpressQueue({ running: true, mode, stepLabel: "4/5 Running CPU & Creator Performance Suite...", percent: 75 });
        try {
          const perf = await invoke<PerfBenchResult>("run_performance_benchmark", {
            preset: isDeep ? "standard" : "quick",
            manufacturer: specsRef.current?.manufacturer ?? null,
            model: specsRef.current?.model ?? null,
          });
          setPerfResult(perf);
          perfRef.current = perf;
          updateModule("performance", perf.status, perf.summary);
          await refreshUserbenchmarkComparison({ perf });
        } catch {}
        if (expressCancelRef.current) return;

        if (isDeep) {
          setExpressQueue({ running: true, mode, stepLabel: "5/5 Running Native wgpu GPU Stress...", percent: 90 });
          try {
            const gpu = await invoke<GpuStressResult>("run_gpu_stress", {
              adapterIndex: null,
              preset: "quick",
              resolution: "1080p",
              extremeMode: false,
              thermalCutoffC: 92,
            });
            setGpuResult(gpu);
            gpuRef.current = gpu;
            updateModule("gpu", gpu.status, gpu.summary);
          } catch {}
        }

        // Jump straight to first human-interactive stage (Display Fullscreen, Stage 06)
        setUnlockedIndex((u) => Math.max(u, 5));
        setActiveTab("display");
      } finally {
        setExpressQueue(null);
      }
    },
    [runAllAutoChecks, updateModule, refreshUserbenchmarkComparison]
  );

  // Persistent Live Docked Telemetry Polling — PAUSES automatically during active stress benchmarks
  useEffect(() => {
    if (stressPaused) return;
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
  }, [stressPaused]);

  const updateStressActive = useCallback(
    (stageTag: string | null) => {
      setStressPaused(stageTag !== null);
      setStressActive(stageTag);
    },
    [setStressActive]
  );

  // Feed TopTelemetryStrip directly from active Performance / Power Torture streams
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

  // Typed intersection prop objects for M3.2 / M3.3 / M4 components (forward-compatible, zero `any` casts)
  const specsViewProps: React.ComponentProps<typeof SpecsView> & {
    networkReport?: NetworkDiagnosticsReport | null;
    loadingNetwork?: boolean;
    onRunNetworkDiagnostics?: () => Promise<NetworkDiagnosticsReport | null>;
    onNetworkComplete?: (rep: NetworkDiagnosticsReport) => void;
  } = {
    specs,
    loading: modules.specs.status === "running",
    status: modules.specs.status,
    stepNumber: stepNumberOf("specs"),
    totalSteps,
    networkReport,
    loadingNetwork,
    onRunNetworkDiagnostics: runNetworkDiagnostics,
    onNetworkComplete: (rep) => {
      setNetworkReport(rep);
      networkReportRef.current = rep;
      persistSession(unlockedIndexRef.current, modulesRef.current, signoffRef.current, null, {
        networkReport: rep,
      });
    },
    onRefresh: fetchSpecs,
    onNext: () => advanceFrom("specs"),
    onSkip: () => skipStep("specs"),
  };

  const batteryViewProps: React.ComponentProps<typeof BatteryView> & {
    dischargeResult?: BatteryDischargeResult | null;
    onDischargeComplete?: (res: BatteryDischargeResult) => void;
    specs?: SystemSpecs | null;
  } = {
    report: batteryReport,
    sagResult: batterySagResult,
    dischargeResult: batteryDischargeResult,
    specs,
    loading: modules.battery.status === "running",
    status: modules.battery.status,
    stepNumber: stepNumberOf("battery"),
    totalSteps,
    onRefresh: fetchBattery,
    onSagComplete: (res) => {
      setBatterySagResult(res);
      if (res.status === "fail") {
        updateModule("battery", "fail", res.summary);
      }
    },
    onDischargeComplete: (res) => {
      setBatteryDischargeResult(res);
      batteryDischargeResultRef.current = res;
      if (res.status === "fail" || res.status === "warn" || res.status === "pass") {
        updateModule("battery", res.status, res.plainSummary);
      }
      persistSession(unlockedIndexRef.current, modulesRef.current, signoffRef.current, null, {
        batteryDischargeResult: res,
      });
    },
    onUpdateStatus: (st, sum) => updateModule("battery", st, sum),
    onNext: () => advanceFrom("battery"),
    onSkip: () => skipStep("battery"),
  };

  const storageViewProps: React.ComponentProps<typeof StorageView> & {
    specs?: SystemSpecs | null;
    userbenchmarkComparison?: UserBenchmarkComparison | null;
  } = {
    telemetry: liveTelemetry,
    volumes: specs?.volumes ?? [],
    specs,
    smartReport,
    benchResult: storageBench,
    userbenchmarkComparison,
    loadingSmart: modules.storage.status === "running",
    status: modules.storage.status,
    stepNumber: stepNumberOf("storage"),
    totalSteps,
    onRefreshSmart: fetchSmart,
    onRunningChange: (r) => updateStressActive(r ? "Stage 05: SSD Direct-IO" : null),
    onBenchComplete: (res) => {
      setStorageBench(res);
      storageRef.current = res;
      const smartSt = smartReport?.status ?? "pass";
      const combined: TestStatus =
        smartSt === "fail" || res.status === "fail"
          ? "fail"
          : smartSt === "warn" || res.status === "warn"
          ? "warn"
          : "pass";
      updateModule("storage", combined, `${smartReport?.summary ?? "SMART OK"} | ${res.summary}`);
      refreshUserbenchmarkComparison({ storage: res }).catch(() => {});
    },
    onNext: () => advanceFrom("storage"),
    onSkip: () => skipStep("storage"),
  };

  const ramViewProps: React.ComponentProps<typeof RamTestView> & {
    specs?: SystemSpecs | null;
    userbenchmarkComparison?: UserBenchmarkComparison | null;
  } = {
    telemetry: liveTelemetry,
    specs,
    memoryTypeHint: specs?.ramModules[0]?.memoryType ?? "DDR4",
    result: ramResult,
    userbenchmarkComparison,
    status: modules.ram.status,
    stepNumber: stepNumberOf("ram"),
    totalSteps,
    onRunningChange: (r) => {
      updateStressActive(r ? "Stage 11: RAM TestMem5 Stress" : null);
      if (r) updateModule("ram", "running", "Running TestMem5 multi-threaded RAM stress...");
    },
    onComplete: (res) => {
      setRamResult(res);
      ramRef.current = res;
      updateModule("ram", res.status, res.summary);
      refreshUserbenchmarkComparison({ ram: res }).catch(() => {});
    },
    onNext: () => advanceFrom("ram"),
    onSkip: () => skipStep("ram"),
  };

  const performanceViewProps: React.ComponentProps<typeof PerformanceView> & {
    specs?: SystemSpecs | null;
    userbenchmarkComparison?: UserBenchmarkComparison | null;
    onUserbenchmarkUpdate?: (comp: UserBenchmarkComparison) => void;
  } = {
    telemetry: liveTelemetry,
    specs,
    manufacturer: specs?.manufacturer,
    model: specs?.model,
    result: perfResult,
    userbenchmarkComparison,
    status: modules.performance.status,
    stepNumber: stepNumberOf("performance"),
    totalSteps,
    onRunningChange: (r) => {
      updateStressActive(r ? "Stage 12: 360° Performance Suite" : null);
      if (r) updateModule("performance", "running", `Running ${totalSteps}-Stage All-Scope Performance & Creator Suite...`);
    },
    onUserbenchmarkUpdate: (comp) => {
      ubGenRef.current += 1;
      allowLiveLookupRef.current = comp.sourceMode === "live_verified";
      ubLatestRef.current = comp;
      userbenchmarkRef.current = comp;
      setUserbenchmarkComparison(comp);
    },
    onComplete: (res) => {
      setPerfResult(res);
      perfRef.current = res;
      updateModule("performance", res.status, res.summary);
      refreshUserbenchmarkComparison({ perf: res }).catch(() => {});
    },
    onNext: () => advanceFrom("performance"),
    onSkip: () => skipStep("performance"),
  };

  const gpuViewProps: React.ComponentProps<typeof GpuStressView> & {
    specs?: SystemSpecs | null;
    userbenchmarkComparison?: UserBenchmarkComparison | null;
    onUserbenchmarkUpdate?: (comp: UserBenchmarkComparison) => void;
  } = {
    telemetry: liveTelemetry,
    specs,
    isGamingCapable: specs?.isGamingCapable ?? false,
    result: gpuResult,
    vramResult,
    tortureResult,
    userbenchmarkComparison,
    status: modules.gpu.status,
    stepNumber: stepNumberOf("gpu"),
    totalSteps,
    onRunningChange: (r) => {
      updateStressActive(r ? "Stage 13: GPU / VRAM / Power Torture" : null);
      if (r) updateModule("gpu", "running", "Running native wgpu GPU / VRAM / Combined Power Stress...");
    },
    onUserbenchmarkUpdate: (comp) => {
      ubGenRef.current += 1;
      if (comp.sourceMode === "live_verified") {
        allowLiveLookupRef.current = true;
      }
      ubLatestRef.current = comp;
      userbenchmarkRef.current = comp;
      setUserbenchmarkComparison(comp);
    },
    onComplete: (res) => {
      setGpuResult(res);
      gpuRef.current = res;
      const statuses = [res.status, vramResult?.status, tortureResult?.status].filter(Boolean) as TestStatus[];
      const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
      const parts = [res.summary, vramResult?.summary, tortureResult?.summary].filter(Boolean).join(" | ");
      updateModule("gpu", merged, parts);
      refreshUserbenchmarkComparison({ gpu: res }).catch(() => {});
    },
    onVramComplete: (res) => {
      setVramResult(res);
      const statuses = [gpuResult?.status, res.status, tortureResult?.status].filter(Boolean) as TestStatus[];
      const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
      const parts = [gpuResult?.summary, res.summary, tortureResult?.summary].filter(Boolean).join(" | ");
      updateModule("gpu", merged, parts);
    },
    onTortureComplete: (res) => {
      setTortureResult(res);
      const statuses = [gpuResult?.status, vramResult?.status, res.status].filter(Boolean) as TestStatus[];
      const merged: TestStatus = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "pass";
      const parts = [gpuResult?.summary, vramResult?.summary, res.summary].filter(Boolean).join(" | ");
      updateModule("gpu", merged, parts);
    },
    onMarkNA: () =>
      updateModule("gpu", "notApplicable", "Marked N/A — integrated office laptop GPU."),
    onNext: () => advanceFrom("gpu"),
    onSkip: () => skipStep("gpu"),
  };

  const portsSpeakersViewProps: React.ComponentProps<typeof PortsSpeakersView> & {
    networkReport?: NetworkDiagnosticsReport | null;
    onRunNetworkDiagnostics?: () => Promise<NetworkDiagnosticsReport | null>;
  } = {
    status: modules.ports_speakers.status,
    signoff,
    networkReport,
    onRunNetworkDiagnostics: runNetworkDiagnostics,
    stepNumber: stepNumberOf("ports_speakers"),
    totalSteps,
    onUpdateSignoff: setSignoff,
    onVerdict: (st, sum) => updateModule("ports_speakers", st, sum),
    onFinish: () => setReportModalOpen(true),
    onSkip: () => {
      updateModule("ports_speakers", "skipped", "Explicitly skipped by technician.");
      setReportModalOpen(true);
    },
  };

  const preReportModalProps: React.ComponentProps<typeof PreReportModal> & {
    touchscreenResult?: TouchscreenTestResult | null;
    batteryDischargeResult?: BatteryDischargeResult | null;
    networkReport?: NetworkDiagnosticsReport | null;
    userbenchmarkComparison?: UserBenchmarkComparison | null;
  } = {
    isOpen: reportModalOpen,
    onClose: () => setReportModalOpen(false),
    shopProfile,
    onUpdateProfile: (p) => {
      setShopProfile(p);
      invoke("save_shop_profile", { profile: p }).catch(() => {});
    },
    specs,
    stepOrder: STEP_ORDER,
    modules,
    signoff,
    securityReport,
    batteryReport,
    batterySagResult,
    batteryDischargeResult,
    errorLogsReport,
    smartReport,
    storageBench,
    touchscreenResult,
    ramResult,
    perfResult,
    cpuStressResult,
    gpuResult,
    vramResult,
    tortureResult,
    networkReport,
    userbenchmarkComparison,
  };

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

        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
            <main className="flex-1 overflow-y-auto p-6 bg-[#F8FAFC]">
              <div className="max-w-5xl mx-auto">
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
                    userbenchmarkComparison={userbenchmarkComparison}
                    touchscreenResult={touchscreenResult}
                    batteryDischargeResult={batteryDischargeResult}
                    networkReport={networkReport}
                    warrantyDiff={warrantyDiff}
                    expressQueue={expressQueue}
                    onStartExpressQueue={runExpressAutoQc}
                    onCancelExpressQueue={cancelExpressAutoQc}
                    onResumeSession={handleResumeSession}
                    onDiscardSession={handleDiscardSession}
                    onRunAutoChecks={runAllAutoChecks}
                    onStartOrResume={() => setActiveTab(STEP_ORDER[Math.min(unlockedIndex, STEP_ORDER.length - 1)])}
                    onSelectModule={setActiveTab}
                    onOpenReport={() => setReportModalOpen(true)}
                  />
                )}

                {activeTab === "stress_hub" && (
                  <StressHubView
                    specs={specs}
                    telemetry={liveTelemetry}
                    lastCpuStress={cpuStressResult}
                    onRunningChange={(r, lbl) => updateStressActive(r ? lbl : null)}
                    onCpuStressComplete={(res) => setCpuStressResult(res)}
                    onGpuComplete={(res) => {
                      setGpuResult(res);
                      gpuRef.current = res;
                      updateModule("gpu", res.status, res.summary);
                      refreshUserbenchmarkComparison({ gpu: res }).catch(() => {});
                    }}
                    onRamComplete={(res) => {
                      setRamResult(res);
                      ramRef.current = res;
                      updateModule("ram", res.status, res.summary);
                      refreshUserbenchmarkComparison({ ram: res }).catch(() => {});
                    }}
                    onVramComplete={(res) => setVramResult(res)}
                    onPowerComplete={(res) => setTortureResult(res)}
                  />
                )}

            {activeTab === "archive" && <ArchiveView />}

            {activeTab === "specs" && <SpecsView {...specsViewProps} />}

            {activeTab === "security" && (
              <SecurityAuditView
                report={securityReport}
                loading={modules.security.status === "running"}
                status={modules.security.status}
                stepNumber={stepNumberOf("security")}
                totalSteps={totalSteps}
                onRefresh={fetchSecurity}
                onNext={() => advanceFrom("security")}
                onSkip={() => skipStep("security")}
              />
            )}

            {activeTab === "battery" && <BatteryView {...batteryViewProps} />}

            {activeTab === "logs" && (
              <ErrorLogsView
                report={errorLogsReport}
                loading={modules.logs.status === "running"}
                status={modules.logs.status}
                stepNumber={stepNumberOf("logs")}
                totalSteps={totalSteps}
                onScan={fetchErrorLogs}
                onNext={() => advanceFrom("logs")}
                onSkip={() => skipStep("logs")}
              />
            )}

            {activeTab === "storage" && <StorageView {...storageViewProps} />}

            {activeTab === "display" && (
              <DisplayTestView
                status={modules.display.status}
                notes={modules.display.notes}
                stepNumber={stepNumberOf("display")}
                totalSteps={totalSteps}
                onVerdict={(st, sum, notes) => updateModule("display", st, sum, notes)}
                onNext={() => advanceFrom("display")}
                onSkip={() => skipStep("display")}
              />
            )}

            {activeTab === "touchscreen" && (
              <TouchscreenTestView
                status={modules.touchscreen.status}
                notes={modules.touchscreen.notes}
                stepNumber={stepNumberOf("touchscreen")}
                totalSteps={totalSteps}
                result={touchscreenResult}
                onComplete={(res) => {
                  setTouchscreenResult(res);
                  touchscreenResultRef.current = res;
                  persistSession(unlockedIndexRef.current, modulesRef.current, signoffRef.current, null, {
                    touchscreenResult: res,
                  });
                }}
                onVerdict={(st, sum, notes) => updateModule("touchscreen", st, sum, notes)}
                onNext={() => advanceFrom("touchscreen")}
                onSkip={() => skipStep("touchscreen")}
              />
            )}

            {activeTab === "keyboard" && (
              <KeyboardTestView
                osFamily={specs?.osFamily ?? "windows"}
                status={modules.keyboard.status}
                notes={modules.keyboard.notes}
                stepNumber={stepNumberOf("keyboard")}
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
                stepNumber={stepNumberOf("biometrics")}
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
                stepNumber={stepNumberOf("media")}
                totalSteps={totalSteps}
                onVerdict={(st, sum, notes) => updateModule("media", st, sum, notes)}
                onNext={() => advanceFrom("media")}
                onSkip={() => skipStep("media")}
              />
            )}

            {activeTab === "ram" && <RamTestView {...ramViewProps} />}

            {activeTab === "performance" && <PerformanceView {...performanceViewProps} />}

            {activeTab === "gpu" && <GpuStressView {...gpuViewProps} />}

            {activeTab === "ports_speakers" && <PortsSpeakersView {...portsSpeakersViewProps} />}
              </div>
            </main>
            <BottomSensorsDock telemetry={liveTelemetry} />
          </div>

          <SystemInfoRail
            specs={specs}
            battery={batteryReport}
            security={securityReport}
          />
        </div>
      </div>

      <PreReportModal {...preReportModalProps} />
    </div>
  );
};

export default App;
