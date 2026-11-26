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
  | "touchscreen"
  | "keyboard"
  | "biometrics"
  | "media"
  | "ram"
  | "performance"
  | "gpu"
  | "ports_speakers";

export type TestModuleId = "dashboard" | "stress_hub" | "archive" | StepModuleId;

export type StressPreset = "quick" | "standard" | "burnin";

// ============================================================================
// Hardware Safety Constants & Bounds (v2.3.0 — mirrors src-tauri/src/types.rs)
// ============================================================================

export const CPU_THERMAL_CUTOFF_DEFAULT_C = 92;
export const CPU_THERMAL_CUTOFF_MIN_C = 80;
export const CPU_THERMAL_CUTOFF_MAX_C = 95;
export const GPU_THERMAL_CUTOFF_DEFAULT_C = 92;
export const GPU_THERMAL_CUTOFF_MIN_C = 75;
export const GPU_THERMAL_CUTOFF_MAX_C = 92;
export const SSD_WRITE_BUDGET_QUICK_MB = 128;
export const SSD_WRITE_BUDGET_STD_MB = 256;
export const SSD_WRITE_BUDGET_MAX_MB = 512;
export const SSD_FREE_SPACE_MULTIPLIER = 4;
export const RAM_OS_RESERVE_FLOOR_MB = 512;
export const RAM_OS_RESERVE_PCT = 22;
export const RAM_OS_RESERVE_16GB_CAP_MB = 1800;
export const BATTERY_LOW_SOC_ABORT_PCT = 15.0;
export const BATTERY_DISCHARGE_MAX_SECS = 90;

export interface HardwareSafetyBounds {
  cpuThermalCutoffC: number;
  gpuThermalCutoffC: number;
  ssdWriteBudgetQuickMb: number;
  ssdWriteBudgetStdMb: number;
  ssdWriteBudgetMaxMb: number;
  ssdFreeSpaceMultiplier: number;
  ramOsReserveFloorMb: number;
  ramOsReservePct: number;
  batteryLowSocAbortPct: number;
  batteryDischargeMaxSecs: number;
}

export const DEFAULT_HARDWARE_SAFETY_BOUNDS: HardwareSafetyBounds = {
  cpuThermalCutoffC: CPU_THERMAL_CUTOFF_DEFAULT_C,
  gpuThermalCutoffC: GPU_THERMAL_CUTOFF_DEFAULT_C,
  ssdWriteBudgetQuickMb: SSD_WRITE_BUDGET_QUICK_MB,
  ssdWriteBudgetStdMb: SSD_WRITE_BUDGET_STD_MB,
  ssdWriteBudgetMaxMb: SSD_WRITE_BUDGET_MAX_MB,
  ssdFreeSpaceMultiplier: SSD_FREE_SPACE_MULTIPLIER,
  ramOsReserveFloorMb: RAM_OS_RESERVE_FLOOR_MB,
  ramOsReservePct: RAM_OS_RESERVE_PCT,
  batteryLowSocAbortPct: BATTERY_LOW_SOC_ABORT_PCT,
  batteryDischargeMaxSecs: BATTERY_DISCHARGE_MAX_SECS,
};

// ============================================================================
// UserBenchmark Comparison & Rating Contracts
// ============================================================================

export type UserBenchmarkVehicleTier =
  | "UFO"
  | "Nuclear Submarine"
  | "Aircraft Carrier"
  | "Battleship"
  | "Cruiser"
  | "Destroyer"
  | "Speedboat"
  | "Jet Ski"
  | "Raft";

export type UserBenchmarkStandingLabel =
  | "Above Expectations"
  | "As Expected"
  | "Below Expectations"
  | "Underperforming";

export interface UserBenchmarkComponentRating {
  component: string;
  detectedModel: string;
  effectiveSpeedPct: number;
  expectedClassPct: number;
  relativeStandingPct: number;
  vehicleTier: UserBenchmarkVehicleTier | string;
  standingLabel: UserBenchmarkStandingLabel | string;
  plainSummary: string;
  sourceMode: string;
  subMetrics: [string, string][];
  bottleneckFlag: string | null;
}

export interface UserBenchmarkComparison {
  gamingPct: number;
  desktopPct: number;
  workstationPct: number;
  overallVehicleTier: UserBenchmarkVehicleTier | string;
  cpu: UserBenchmarkComponentRating | null;
  gpu: UserBenchmarkComponentRating | null;
  ssd: UserBenchmarkComponentRating | null;
  ram: UserBenchmarkComponentRating | null;
  headlineSummary: string;
  recommendations: string[];
  sourceMode: string;
}

export interface UserBenchmarkInput {
  cpuBrand?: string;
  cpuPhysicalCores?: number | null;
  cpuLogicalCores?: number | null;
  cpuSingleCore?: number | null;
  cpuMultiCore?: number | null;
  cpuComposite?: number | null;
  gpuName?: string | null;
  gpuResolution?: string | null;
  gpuAvgFps?: number | null;
  gpuFpsDropPct?: number | null;
  gpuThermalCutoff?: boolean;
  ssdModel?: string | null;
  ssdInterface?: string | null;
  ssdMediaType?: string | null;
  ssdSeqReadMbS?: number | null;
  ssdSeqWriteMbS?: number | null;
  ssdRand4kReadMbS?: number | null;
  ssdRand4kWriteMbS?: number | null;
  ssdIntegrityErrors?: number;
  ramType?: string | null;
  ramBandwidthGbS?: number | null;
  ramLatencyNs?: number | null;
  ramChannelMode?: string | null;
  ramErrorsFound?: number;
  allowLiveLookup?: boolean;
  specs?: SystemSpecs | null;
  perf?: PerfBenchResult | null;
  gpu?: GpuStressResult | null;
  storage?: StorageBenchResult | null;
  ram?: RamTestResult | null;
}

// ============================================================================
// System Specs, Security, Battery, Network, USB, Error Logs, Storage, RAM
// ============================================================================

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
  wifiSsid?: string | null;
  wifiSignalPct?: number | null;
  wifiRssiDbm?: number | null;
  wifiRadioType?: string | null;
  wifiAntennaWarning?: string | null;
  ramChannelMode?: string | null;
  ramConfigWarning?: string | null;
  ramReliabilityNote?: string | null;
  reliabilityNotes?: string[];
  plainSummary?: string;
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
  buyerNote?: string;
}

export interface SecurityAuditReport {
  overallStatus: TestStatus;
  platform: string;
  mdmEnrolled: boolean | null;
  activationLocked: boolean | null;
  biosLocked?: boolean | null;
  biosLockStatus?: "LOCKED" | "UNLOCKED" | "UNVERIFIABLE" | string;
  items: SecurityCheckItem[];
  summary: string;
  plainSummary?: string;
  ownershipRisks?: string[];
}

export interface DisplayBrightnessInfo {
  supported: boolean;
  currentPct: number | null;
  levelsCount: number | null;
  canSet: boolean;
  status: TestStatus;
  detail: string;
}

export interface KeyboardBacklightInfo {
  supported: boolean | null;
  currentPct: number | null;
  status: TestStatus;
  detail: string;
}

export interface RadioControlInfo {
  present: boolean;
  enabled: boolean | null;
  adapterName: string;
  connectionDetail: string;
  status: TestStatus;
  detail: string;
}

export interface AirplaneModeInfo {
  supported: boolean;
  active: boolean | null;
  status: TestStatus;
  detail: string;
}

export interface HeadphoneJackInfo {
  pluggedIn: boolean;
  activeOutputName: string;
  detectedEndpoints: string[];
  status: TestStatus;
  detail: string;
}

export interface HardwareControlsReport {
  platform: string;
  displayBrightness: DisplayBrightnessInfo;
  keyboardBacklight: KeyboardBacklightInfo;
  wifi: RadioControlInfo;
  bluetooth: RadioControlInfo;
  airplaneMode: AirplaneModeInfo;
  headphoneJack: HeadphoneJackInfo;
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

export interface BatterySagProgress {
  running: boolean;
  elapsedSecs: number;
  durationSecs: number;
  chargePercent: number;
  voltageMv: number | null;
  watts: number | null;
  acPlugged: boolean;
  voltageDropMv: number;
  chargeDropPct: number;
}

export interface BatterySagResult {
  status: TestStatus;
  durationSecs: number;
  wasOnBattery: boolean;
  startChargePct: number;
  endChargePct: number;
  chargeDropPct: number;
  startVoltageMv: number | null;
  minVoltageMv: number | null;
  maxVoltageSagMv: number;
  peakDischargeW: number | null;
  summary: string;
}

export interface BatteryDischargeProgress {
  running: boolean;
  phase: string;
  elapsedSecs: number;
  durationSecs: number;
  chargePercent: number;
  voltageMv: number | null;
  watts: number | null;
  acPlugged: boolean;
  voltageSagMv: number;
  chargeDropPct: number;
  note: string;
}

export type BatteryDischargeVerdict =
  | "NORMAL"
  | "ABNORMAL"
  | "NOT_APPLICABLE"
  | "AC_CONNECTED"
  | "ABORTED_LOW_BATTERY"
  | "CANCELLED"
  | "INSUFFICIENT_SAMPLES";

export interface BatteryDischargeResult {
  status: TestStatus;
  verdict: BatteryDischargeVerdict | string;
  plainSummary: string;
  reasons: string[];
  idleAvgWatts: number;
  loadAvgWatts: number;
  powerCvPct: number;
  voltageSagMv: number;
  socStartPct: number;
  socEndPct: number;
  maxStepDropPct: number;
  wearPct: number;
  cycleCount: number;
  bmsDriftRatio: number;
  durationSecs: number;
  samples: BatteryLiveSample[];
}

export type NetworkDiagnosticsVerdict =
  | "HEALTHY"
  | "LOCAL_ONLY_NO_DNS"
  | "DEGRADED"
  | "POOR_LINK"
  | "NO_ACTIVE_LINK"
  | "NOT_APPLICABLE";

export interface NetworkDiagnosticsReport {
  status: TestStatus;
  interfaceName: string;
  linkSpeedMbps: number | null;
  wifiSsid: string | null;
  wifiSignalPct: number | null;
  rssiDbm: number | null;
  gatewayPingMs: number | null;
  dnsResolveOk: boolean;
  packetLossPct: number;
  verdict: NetworkDiagnosticsVerdict | string;
  plainSummary: string;
}

export interface UsbDeviceInfo {
  instanceId: string;
  name: string;
  speedClass: string;
  isSuperspeed: boolean;
  status: string;
  negotiatedMbps?: number | null;
  controllerType?: string;
  errorCode?: number | null;
  reliabilityNote?: string;
}

export interface UsbHotplugEvent {
  eventKind: "CONNECTED" | "DISCONNECTED" | "SNAPSHOT";
  timestamp: string;
  device: UsbDeviceInfo | null;
  devices: UsbDeviceInfo[];
}

export interface SavedSessionPayload {
  serialNumber: string;
  model: string;
  savedAt: string;
  activeStressStage: string | null;
  stateJson: string;
}

export interface RawKeyEvent {
  vkCode: number;
  scanCode: number;
  code: string;
  pressed: boolean;
}

export interface TouchscreenTestResult {
  touchCapable: boolean;
  maxTouchPointsReported: number;
  gridRows: number;
  gridCols: number;
  coveredCells: number;
  totalCells: number;
  coveragePct: number;
  maxSimultaneousTouches: number;
  swipeLinearityRmsPx: number;
  maxLinearityErrorPx?: number;
  pollingHz: number;
  tapLatencyMs?: number | null;
  status: TestStatus;
  verdict: "PASS" | "WARN" | "FAIL" | "SKIPPED";
  plainSummary: string;
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
  thermalEventCount?: number;
  plainSummary?: string;
  buyerInterpretation?: string[];
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
  criticalWarningFlags?: string[];
  availableSpareThresholdPct?: number | null;
  percentageUsedRaw?: number | null;
  plainSummary?: string;
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
  driveTempC?: number | null;
  thermalWarning?: boolean;
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
  totalWrittenMb?: number;
  rand4kQd32ReadMbS?: number;
  rand4kQd32WriteMbS?: number;
  rand4kQd32ReadIops?: number;
  rand4kQd32WriteIops?: number;
  mixedRwMbS?: number;
  mixedRwIops?: number;
  slcSustainedMbS?: number;
  slcCacheDropPct?: number;
  writeStabilityPct?: number;
  peakDriveTempC?: number | null;
  thermalWarning?: boolean;
  thermalCutoffTriggered?: boolean;
  userbenchmarkRating?: UserBenchmarkComponentRating | null;
  plainSummary?: string;
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
  cpuTempC?: number | null;
  thermalWarning?: boolean;
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
  osReserveMb?: number;
  peakCpuTempC?: number | null;
  thermalCutoffTriggered?: boolean;
  sensorUnavailable?: boolean;
  userbenchmarkRating?: UserBenchmarkComponentRating | null;
  plainSummary?: string;
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
  cpuTempAvailable?: boolean;
  gpuTempAvailable?: boolean;
  powerWattsAvailable?: boolean;
  tempSource?: string;
  perCoreTempsC?: number[];
  pawnioInstalled?: boolean;
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
  memoryUncachedReadGbS?: number;
  memoryThreadedGbS?: number;
  memoryDatabaseKops?: number;
  availableRamMb?: number;
  thermalCutoffTriggered?: boolean;
  sensorUnavailable?: boolean;
  userbenchmarkRating?: UserBenchmarkComponentRating | null;
  plainSummary?: string;
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
  thermalWarning?: boolean;
  gpuTempAvailable?: boolean;
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
  thermalCutoffTriggered?: boolean;
  effectiveCutoffC?: number;
  sensorAvailable?: boolean;
  plainSummary?: string;
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
  artifactErrors?: number;
  throttleState?: string;
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
  artifactErrors?: number;
  avgGpuPowerW?: number | null;
  peakCpuPowerW?: number | null;
  thermalThrottlingDetected?: boolean;
  powerLimitThrottling?: boolean;
  throttleReason?: string;
  sensorAvailable?: boolean;
  effectiveCpuCutoffC?: number;
  effectiveGpuCutoffC?: number;
  plainSummary?: string;
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
  thermalCutoffTriggered?: boolean;
  plainSummary?: string;
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
  artifactErrors?: number;
  gpuTempAvailable?: boolean;
  throttleState?: string;
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
  artifactErrors?: number;
  avgPowerW?: number | null;
  avgLoadPct?: number | null;
  thermalThrottlingDetected?: boolean;
  powerLimitThrottling?: boolean;
  throttleReason?: string;
  sensorAvailable?: boolean;
  effectiveCutoffC?: number;
  plainSummary?: string;
  userbenchmarkRating?: UserBenchmarkComponentRating | null;
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

export interface SavedSessionState {
  unlockedIndex: number;
  modules: Partial<Record<StepModuleId, ModuleRecord>>;
  signoff: PortsSpeakerSignoff;
  touchscreenResult?: TouchscreenTestResult | null;
  batteryDischargeResult?: BatteryDischargeResult | null;
  networkReport?: NetworkDiagnosticsReport | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
}

export interface SubsystemScoreBar {
  label: string;
  scorePct: number;
  metricText: string;
  statusLabel: string;
}

export interface ReportTestEntry {
  id: string;
  name: string;
  category: string;
  status: TestStatus;
  summary: string;
  metrics: [string, string][];
  notes: string;
}

export interface ExportReportPayload {
  shopProfile: ShopProfile;
  customerOrSku: string;
  technicianNotes: string;
  overallVerdict: string;
  durabilityGrade?: string | null;
  subsystemScores?: SubsystemScoreBar[];
  specs: SystemSpecs | null;
  tests: ReportTestEntry[];
  signoff: PortsSpeakerSignoff;
  outputDir: string | null;
  plainVerdictSummary?: string | null;
  userBenchmark?: UserBenchmarkComparison | null;
  batteryDischarge?: BatteryDischargeResult | null;
  touchscreen?: TouchscreenTestResult | null;
  networkReport?: NetworkDiagnosticsReport | null;
  cpuStress?: CpuStressResult | null;
  cosmetic?: CosmeticInspection | null;
}

export interface CosmeticPhoto {
  label: string;
  dataUrl: string;
}

export interface CosmeticInspection {
  grade: "A+ Mint" | "A Clean" | "B Minor Wear" | "C Heavy Wear" | string;
  chassisOk: boolean;
  screenCoatingOk: boolean;
  hingesOk: boolean;
  palmrestOk: boolean;
  screwsSealsOk: boolean;
  oemChargerIncluded: boolean;
  notes: string;
  photos: CosmeticPhoto[];
}

export interface QcArchiveRecord {
  id: string;
  certId: string;
  testedAt: string;
  serialNumber: string;
  manufacturer: string;
  model: string;
  customerOrSku: string;
  overallVerdict: string;
  durabilityGrade: string | null;
  cosmeticGrade: string | null;
  batteryHealthPct: number | null;
  ssdSerial: string | null;
  ssdWearPct: number | null;
  ramGb: number | null;
  pdfPath: string;
  htmlPath: string;
  jsonPath: string;
  notes: string;
}

export interface WarrantyReturnDiff {
  previousRecord: QcArchiveRecord;
  previousCount: number;
  alerts: string[];
  partSwapSuspected: boolean;
  summary: string;
}

export interface CpuStressProgress {
  running: boolean;
  phase: string;
  percent: number;
  elapsedSecs: number;
  durationSecs: number;
  cpuUsagePct: number;
  cpuClockMhz: number;
  cpuTempC: number | null;
  cpuPowerW: number | null;
  calcErrors: number;
  wheaErrors: number;
  iterationsCompleted: number;
  inCooldown: boolean;
}

export interface CpuStressResult {
  status: TestStatus;
  dataSet: string;
  loadType: string;
  threadsUsed: number;
  simdIsa: string;
  durationSecs: number;
  elapsedSecs: number;
  calcErrors: number;
  wheaErrors: number;
  totalErrors: number;
  iterationsCompleted: number;
  avgClockMhz: number;
  minClockMhz: number;
  maxClockMhz: number;
  throttleDropPct: number;
  peakTempC: number | null;
  cooldownEndTempC: number | null;
  cooldownDropC: number | null;
  cooldownVerdict: string;
  thermalCutoffTriggered: boolean;
  effectiveCutoffC: number;
  stoppedOnError: boolean;
  cancelled: boolean;
  summary: string;
  plainSummary: string;
}

export interface ExportedReportPaths {
  directory: string;
  pdfPath: string;
  htmlPath: string;
  jsonPath: string;
  generatedAt: string;
}
