export type TestStatus =
  | "pending"
  | "running"
  | "pass"
  | "warn"
  | "fail"
  | "skipped"
  | "notApplicable";

export interface BaselineRating {
  detectedClass: string;
  expectedNormal: string;
  percentOfNormal: number;
  grade: string;
  verdictNote: string;
}

export type StepModuleId =
  | "specs"
  | "security"
  | "battery"
  | "logs"
  | "storage"
  | "display"
  | "keyboard"
  | "biometrics"
  | "media"
  | "ram"
  | "performance"
  | "gpu"
  | "ports_speakers";

export type TestModuleId = "dashboard" | StepModuleId;

export type StressPreset = "quick" | "standard" | "burnin";

export interface RamModuleInfo {
  slot: string;
  capacityGb: number;
  speedMhz: number | null;
  memoryType: string;
  formFactor: string;
  manufacturer: string;
  partNumber: string;
  serialNumber: string;
}

export interface GpuSpecInfo {
  name: string;
  vendor: string;
  vramMb: number | null;
  driverVersion: string;
  driverDate: string;
  pnpDeviceId: string;
  isDiscrete: boolean;
}

export interface DiskSpecInfo {
  model: string;
  interfaceType: string;
  mediaType: string;
  sizeGb: number;
  serialNumber: string;
  firmware: string;
  partitionStyle: string;
}

export interface VolumeSpecInfo {
  mount: string;
  label: string;
  fileSystem: string;
  totalGb: number;
  freeGb: number;
}

export interface DisplaySpecInfo {
  name: string;
  manufacturer: string;
  resolution: string;
  refreshRateHz: number | null;
  diagonalInches: number | null;
}

export interface NetworkAdapterInfo {
  name: string;
  kind: string;
  macAddress: string;
  linkSpeed: string;
  status: string;
}

export interface PeripheralDeviceInfo {
  category: string;
  name: string;
  manufacturer: string;
  status: string;
}

export interface SystemSpecs {
  osFamily: string;
  osName: string;
  osVersion: string;
  osBuild: string;
  architecture: string;
  hostname: string;
  manufacturer: string;
  model: string;
  systemSku: string;
  chassisType: string;
  serialNumber: string;
  systemUuid: string;
  motherboardVendor: string;
  motherboardProduct: string;
  motherboardSerial: string;
  biosVendor: string;
  biosVersion: string;
  biosDate: string;
  cpuBrand: string;
  cpuSocket: string;
  cpuPhysicalCores: number;
  cpuLogicalCores: number;
  cpuBaseMhz: number;
  cpuMaxMhz: number | null;
  cpuL2Kb: number | null;
  cpuL3Kb: number | null;
  cpuVirtualization: boolean | null;
  totalRamGb: number;
  ramSlotsTotal: number | null;
  ramMaxCapacityGb: number | null;
  ramModules: RamModuleInfo[];
  gpus: GpuSpecInfo[];
  disks: DiskSpecInfo[];
  volumes: VolumeSpecInfo[];
  displays: DisplaySpecInfo[];
  networkAdapters: NetworkAdapterInfo[];
  peripherals: PeripheralDeviceInfo[];
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
  elapsedSecs: number;
  integrityErrors: number;
}

export interface StorageBenchResult {
  status: TestStatus;
  preset: string;
  testSizeMb: number;
  directIo: boolean;
  seqWriteMbS: number;
  seqReadMbS: number;
  rand4kWriteMbS: number;
  rand4kReadMbS: number;
  rand4kWriteIops: number;
  rand4kReadIops: number;
  avg4kLatencyMs: number;
  p994kLatencyMs: number;
  integrityErrors: number;
  elapsedSecs: number;
  baseline: BaselineRating;
  summary: string;
}

export interface RamTestProgress {
  running: boolean;
  profileName: string;
  testIndex: number;
  patternName: string;
  cycle: number;
  percent: number;
  allocatedMb: number;
  totalGbVerified: number;
  bandwidthGbS: number;
  errorsFound: number;
  perTestPasses: number[];
  perTestErrors: number[];
  elapsedSecs: number;
  durationSecs: number;
}

export interface RamTestResult {
  status: TestStatus;
  preset: string;
  profileName: string;
  allocatedMb: number;
  totalRamMb: number;
  totalGbVerified: number;
  cyclesCompleted: number;
  patternsTested: string[];
  perTestPasses: number[];
  perTestErrors: number[];
  errorsFound: number;
  peakBandwidthGbS: number;
  avgBandwidthGbS: number;
  elapsedSecs: number;
  cancelled: boolean;
  baseline: BaselineRating;
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

export interface LiveTelemetrySnapshot {
  cpuUsagePct: number;
  cpuClockMhz: number;
  cpuTempC: number | null;
  cpuPowerW: number | null;
  gpuTempC: number | null;
  gpuLoadPct: number | null;
  gpuPowerW: number | null;
  fanRpm: number | null;
  acPlugged: boolean | null;
  batteryPercent: number | null;
  batteryWatts: number | null;
  sensorSource: string;
}

export interface ShopModelBenchmarkAvg {
  modelKey: string;
  displayLabel: string;
  unitsTested: number;
  avgCompositeScore: number | null;
  avgOfficeScore: number | null;
  avgCreatorScore: number | null;
  avgMemoryMark: number | null;
  avgGpuFps: number | null;
  avgSsdReadMbS: number | null;
  lastTestedAt: string;
}

export interface ShopModelComparison {
  found: boolean;
  unitsTested: number;
  shopAvgComposite: number | null;
  shopAvgOffice: number | null;
  shopAvgCreator: number | null;
  shopAvgGpuFps: number | null;
  shopAvgSsdRead: number | null;
  percentVsShop: number | null;
  lastTestedAt: string | null;
}

export interface PerfBenchProgress {
  phase: string;
  percent: number;
  elapsedSecs: number;
  cpuUsagePct: number;
  cpuClockMhz: number;
  cpuTempC: number | null;
  raytracePreviewUrl: string | null;
  telemetry: LiveTelemetrySnapshot | null;
}

export interface PerfBenchResult {
  status: TestStatus;
  preset: string;
  simdIsa: string;
  integerMathScore: number;
  floatMathScore: number;
  primeScore: number;
  vectorScore: number;
  compressionScore: number;
  encryptionScore: number;
  physicsScore: number;
  sortingScore: number;
  databaseScore: number;
  singleCoreScore: number;
  multiCoreScore: number;
  officeScore: number;
  creatorScore: number;
  creatorRaytraceScore: number;
  creatorMegaRaysS: number;
  creatorAiGemmScore: number;
  creatorImageScore: number;
  raytracePreviewUrl: string | null;
  memoryCachedGbS: number;
  memoryBandwidthGbS: number;
  memoryWriteGbS: number;
  memoryLatencyNs: number;
  memoryMark: number;
  compositeScore: number;
  throttleDropPct: number;
  tier: string;
  durabilityGrade: string;
  peakCpuTempC: number | null;
  elapsedSecs: number;
  cancelled: boolean;
  baseline: BaselineRating;
  shopComparison: ShopModelComparison | null;
  summary: string;
}

export interface VramTestProgress {
  running: boolean;
  adapterName: string;
  patternName: string;
  passNumber: number;
  percent: number;
  allocatedVramMb: number;
  totalGbVerified: number;
  bandwidthGbS: number;
  errorsFound: number;
  elapsedSecs: number;
  durationSecs: number;
  gpuTempC: number | null;
}

export interface VramTestResult {
  status: TestStatus;
  adapterName: string;
  backend: string;
  allocatedVramMb: number;
  passesCompleted: number;
  totalGbVerified: number;
  avgBandwidthGbS: number;
  errorsFound: number;
  peakTempC: number | null;
  elapsedSecs: number;
  cancelled: boolean;
  baseline: BaselineRating;
  summary: string;
}

export interface PowerTortureProgress {
  running: boolean;
  adapterName: string;
  simdIsa: string;
  elapsedSecs: number;
  durationSecs: number;
  percent: number;
  gpuFps: number;
  gpuAvgFps: number;
  cpuOpsPerSec: number;
  telemetry: LiveTelemetrySnapshot;
  batteryStartPct: number | null;
  batteryDeltaPct: number | null;
  batteryDrainWhilePlugged: boolean;
  thermalWarning: boolean;
  previewDataUrl: string | null;
}

export interface PowerTortureResult {
  status: TestStatus;
  adapterName: string;
  simdIsa: string;
  durationSecs: number;
  elapsedSecs: number;
  avgFps: number;
  fpsDropPct: number;
  peakCpuTempC: number | null;
  peakGpuTempC: number | null;
  peakGpuPowerW: number | null;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  batteryDeltaPct: number | null;
  batteryDrainWhilePlugged: boolean;
  thermalCutoffTriggered: boolean;
  cancelled: boolean;
  durabilityGrade: string;
  baseline: BaselineRating;
  summary: string;
}

export interface BurnInProgress {
  running: boolean;
  stageIndex: number;
  totalStages: number;
  stageName: string;
  stageDetail: string;
  overallPercent: number;
  elapsedSecs: number;
  totalDurationSecs: number;
  ramErrors: number;
  vramErrors: number;
  batteryDrainAlert: boolean;
  telemetry: LiveTelemetrySnapshot | null;
}

export interface BurnInResult {
  status: TestStatus;
  totalMinutes: number;
  elapsedSecs: number;
  cancelled: boolean;
  ramResult: RamTestResult | null;
  vramResult: VramTestResult | null;
  tortureResult: PowerTortureResult | null;
  durabilityGrade: string;
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
  low1pctFps: number;
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
  low1pctFps: number;
  fpsDropPct: number;
  framesRendered: number;
  peakTempC: number | null;
  peakPowerW: number | null;
  thermalCutoffTriggered: boolean;
  elapsedSecs: number;
  cancelled: boolean;
  baseline: BaselineRating;
  summary: string;
}

export interface ShopProfile {
  shopName: string;
  technicianName: string;
  logoDataUrl: string | null;
  defaultOutputDir: string | null;
}

export interface ModuleRecord {
  id: StepModuleId;
  stepNumber: number;
  name: string;
  category: "System" | "Interactive" | "Deep Stress" | "Final Verification";
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

export interface SubsystemScoreBar {
  label: string;
  scorePct: number;
  metricText: string;
  statusLabel: string;
}

export interface ExportReportPayload {
  shopProfile: ShopProfile;
  customerOrSku: string;
  technicianNotes: string;
  overallVerdict: string;
  durabilityGrade?: string | null;
  subsystemScores?: SubsystemScoreBar[];
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
