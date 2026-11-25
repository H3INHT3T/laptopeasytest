export type TestStatus =
  | "pending"
  | "running"
  | "pass"
  | "warn"
  | "fail"
  | "notApplicable";

export type TestModuleId =
  | "dashboard"
  | "specs"
  | "security"
  | "battery"
  | "logs"
  | "display"
  | "keyboard"
  | "storage"
  | "ram"
  | "biometrics"
  | "media"
  | "performance"
  | "gpu";

export type StressPreset = "quick" | "standard" | "burnin";

export interface RamModuleInfo {
  slot: string;
  capacityGb: number;
  speedMhz: number | null;
  memoryType: string;
  manufacturer: string;
  partNumber: string;
}

export interface GpuSpecInfo {
  name: string;
  vendor: string;
  vramMb: number | null;
  driverVersion: string;
  isDiscrete: boolean;
}

export interface DiskSpecInfo {
  model: string;
  interfaceType: string;
  mediaType: string;
  sizeGb: number;
  serialNumber: string;
}

export interface DisplaySpecInfo {
  name: string;
  resolution: string;
  refreshRateHz: number | null;
}

export interface SystemSpecs {
  osFamily: string;
  osName: string;
  osVersion: string;
  architecture: string;
  hostname: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  biosVersion: string;
  cpuBrand: string;
  cpuPhysicalCores: number;
  cpuLogicalCores: number;
  cpuBaseMhz: number;
  totalRamGb: number;
  ramModules: RamModuleInfo[];
  gpus: GpuSpecInfo[];
  disks: DiskSpecInfo[];
  displays: DisplaySpecInfo[];
  isGamingCapable: boolean;
  isElevated: boolean;
  uptimeSeconds: number;
}

export interface SecurityCheckItem {
  id: string;
  label: string;
  value: string;
  status: TestStatus;
  detail: string;
}

export interface SecurityAuditReport {
  overallStatus: TestStatus;
  platform: string;
  mdmEnrolled: boolean | null;
  activationLocked: boolean | null;
  items: SecurityCheckItem[];
  summary: string;
}

export interface BatteryHealthReport {
  present: boolean;
  status: TestStatus;
  manufacturer: string;
  chemistry: string;
  designCapacityMwh: number | null;
  fullChargeCapacityMwh: number | null;
  healthPercent: number | null;
  wearPercent: number | null;
  cycleCount: number | null;
  currentChargePercent: number | null;
  isCharging: boolean;
  acPlugged: boolean;
  voltageMv: number | null;
  rateMw: number | null;
  adapterWatts: number | null;
  notes: string;
}

export interface BatteryLiveSample {
  timestampMs: number;
  chargePercent: number;
  acPlugged: boolean;
  isCharging: boolean;
  voltageMv: number | null;
  rateMw: number | null;
  watts: number | null;
}

export interface ErrorLogEntry {
  timestamp: string;
  source: string;
  level: string;
  eventId: number | null;
  category: string;
  message: string;
}

export interface ErrorLogsReport {
  status: TestStatus;
  daysScanned: number;
  criticalCount: number;
  errorCount: number;
  bsodOrPanicCount: number;
  wheaOrHwCount: number;
  diskErrorCount: number;
  gpuResetCount: number;
  minidumpFiles: string[];
  entries: ErrorLogEntry[];
  summary: string;
}

export interface DriveSmartInfo {
  deviceId: string;
  model: string;
  serialNumber: string;
  interfaceType: string;
  mediaType: string;
  sizeGb: number;
  healthStatus: string;
  status: TestStatus;
  healthPercent: number | null;
  wearPercent: number | null;
  temperatureC: number | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  unsafeShutdowns: number | null;
  mediaErrors: number | null;
  readErrors: number | null;
  writeErrors: number | null;
  tbwGb: number | null;
  availableSparePct: number | null;
  notes: string;
}

export interface StorageSmartReport {
  status: TestStatus;
  drives: DriveSmartInfo[];
  summary: string;
}

export interface StorageBenchProgress {
  phase: string;
  percent: number;
  currentMbS: number;
}

export interface StorageBenchResult {
  status: TestStatus;
  preset: string;
  testSizeMb: number;
  seqWriteMbS: number;
  seqReadMbS: number;
  rand4kWriteMbS: number;
  rand4kReadMbS: number;
  rand4kWriteIops: number;
  rand4kReadIops: number;
  elapsedSecs: number;
  summary: string;
}

export interface RamTestProgress {
  running: boolean;
  patternName: string;
  cycle: number;
  totalCycles: number;
  percent: number;
  allocatedMb: number;
  bandwidthGbS: number;
  errorsFound: number;
  elapsedSecs: number;
}

export interface RamTestResult {
  status: TestStatus;
  preset: string;
  allocatedMb: number;
  totalRamMb: number;
  cyclesCompleted: number;
  patternsTested: string[];
  errorsFound: number;
  peakBandwidthGbS: number;
  elapsedSecs: number;
  cancelled: boolean;
  summary: string;
}

export interface BiometricSensorInfo {
  kind: string;
  name: string;
  driverOk: boolean;
  errorCode: number | null;
}

export interface BiometricsHardwareReport {
  platform: string;
  fingerprintPresent: boolean;
  faceIrPresent: boolean;
  sensors: BiometricSensorInfo[];
  suggestedStatus: TestStatus;
  summary: string;
}

export interface BiometricAuthResult {
  outcome: string;
  status: TestStatus;
  message: string;
}

export interface PerfBenchProgress {
  phase: string;
  percent: number;
  cpuUsagePct: number;
  cpuTempC: number | null;
}

export interface PerfBenchResult {
  status: TestStatus;
  preset: string;
  singleCoreScore: number;
  multiCoreScore: number;
  cryptoScore: number;
  matrixScore: number;
  memoryBandwidthGbS: number;
  compositeScore: number;
  tier: string;
  peakCpuTempC: number | null;
  elapsedSecs: number;
  cancelled: boolean;
  summary: string;
}

export interface GpuAdapterInfo {
  index: number;
  name: string;
  backend: string;
  deviceType: string;
  vendorId: number;
  isDiscrete: boolean;
}

export interface GpuStressProgress {
  running: boolean;
  adapterName: string;
  width: number;
  height: number;
  fps: number;
  avgFps: number;
  minFps: number;
  frameTimeMs: number;
  framesRendered: number;
  elapsedSecs: number;
  durationSecs: number;
  gpuTempC: number | null;
  gpuLoadPct: number | null;
  gpuPowerW: number | null;
  thermalWarning: boolean;
  previewDataUrl: string | null;
}

export interface GpuStressResult {
  status: TestStatus;
  adapterName: string;
  backend: string;
  resolution: string;
  preset: string;
  avgFps: number;
  minFps: number;
  maxFps: number;
  framesRendered: number;
  peakTempC: number | null;
  peakPowerW: number | null;
  thermalCutoffTriggered: boolean;
  elapsedSecs: number;
  cancelled: boolean;
  summary: string;
}

export interface ShopProfile {
  shopName: string;
  technicianName: string;
  logoDataUrl: string | null;
  defaultOutputDir: string | null;
}

export interface ModuleRecord {
  id: Exclude<TestModuleId, "dashboard">;
  name: string;
  category: "Automated" | "Interactive" | "Stress";
  status: TestStatus;
  summary: string;
  notes: string;
}

export interface PortsSpeakerSignoff {
  portsChecked: boolean;
  portsNotes: string;
  speakersChecked: boolean;
  speakersNotes: string;
}

export interface ExportReportPayload {
  shopProfile: ShopProfile;
  customerOrSku: string;
  technicianNotes: string;
  overallVerdict: string;
  specs: SystemSpecs | null;
  tests: Array<{
    id: string;
    name: string;
    category: string;
    status: TestStatus;
    summary: string;
    metrics: [string, string][];
    notes: string;
  }>;
  signoff: PortsSpeakerSignoff;
  outputDir: string | null;
}

export interface ExportedReportPaths {
  directory: string;
  pdfPath: string;
  htmlPath: string;
  jsonPath: string;
  generatedAt: string;
}
