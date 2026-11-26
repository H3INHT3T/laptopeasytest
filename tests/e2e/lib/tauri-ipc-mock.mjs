export function createTauriInitScript(scenarioFixture = {}, mockOptions = {}) {
  const safeFixtureJson = JSON.stringify(scenarioFixture ?? {}).replace(/</g, "\\u003c");
  const safeOptionsJson = JSON.stringify({
    stepDelayMs: 15,
    strictUnknownCommands: true,
    ...mockOptions,
  }).replace(/</g, "\\u003c");

  return `(() => {
    const initialFixture = ${safeFixtureJson};
    const mockOptions = ${safeOptionsJson};

    function isPlainObject(val) {
      return val !== null && typeof val === "object" && !Array.isArray(val);
    }

    function deepMerge(target, source) {
      if (!isPlainObject(source)) return source;
      const out = isPlainObject(target) ? Object.assign({}, target) : {};
      for (const key of Object.keys(source)) {
        const val = source[key];
        if (isPlainObject(val) && isPlainObject(out[key])) {
          out[key] = deepMerge(out[key], val);
        } else if (Array.isArray(val)) {
          out[key] = val.slice();
        } else {
          out[key] = val;
        }
      }
      return out;
    }

    let fixture = deepMerge({}, initialFixture);

    // Patch navigator.maxTouchPoints deterministically if configured
    if (fixture.touchCapabilities && typeof fixture.touchCapabilities.maxTouchPoints === "number") {
      try {
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
          configurable: true,
          get() {
            return fixture.touchCapabilities && typeof fixture.touchCapabilities.maxTouchPoints === "number"
              ? fixture.touchCapabilities.maxTouchPoints
              : 0;
          },
        });
      } catch (_) {
        // Ignore if environment marks Navigator.prototype.maxTouchPoints non-configurable
      }
    }

    const callbacks = new Map();
    let nextCallbackId = 1;
    const eventListeners = new Map(); // eventName -> Set<number>
    const invokeLog = [];
    const errors = [];
    const windowState = {
      label: "main",
      decorations: true,
      alwaysOnTop: false,
      fullscreen: false,
    };

    let shopProfileState = deepMerge(
      {
        shopName: "",
        technicianName: "",
        logoDataUrl: null,
        defaultOutputDir: null,
      },
      fixture.shopProfile || {}
    );
    let savedSessionState = fixture.savedSession || null;
    let shopHistoryState = Array.isArray(fixture.shopHistory) ? fixture.shopHistory.slice() : [];
    const cancelledFlags = Object.create(null);
    let batteryMonitorTimer = null;
    let usbMonitorTimer = null;
    let telemetrySeqIdx = 0;

    function transformCallback(callback, once = false) {
      const id = nextCallbackId++;
      callbacks.set(id, { callback, once: Boolean(once) });
      return id;
    }

    function unregisterCallback(id) {
      callbacks.delete(id);
    }

    function runCallback(id, data) {
      const entry = callbacks.get(id);
      if (!entry) return;
      if (entry.once) {
        callbacks.delete(id);
      }
      if (typeof entry.callback === "function") {
        try {
          entry.callback(data);
        } catch (err) {
          errors.push({
            timestamp: new Date().toISOString(),
            source: "callback",
            message: err && err.stack ? err.stack : String(err),
          });
        }
      }
    }

    function emitEvent(eventName, payload) {
      const set = eventListeners.get(eventName);
      if (!set) return;
      for (const handlerId of Array.from(set)) {
        runCallback(handlerId, {
          event: eventName,
          id: handlerId,
          payload,
        });
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function runLongCommand(cancelKey, eventName, resultData, cancelledPatch) {
      cancelledFlags[cancelKey] = false;
      const delay = typeof mockOptions.stepDelayMs === "number" ? mockOptions.stepDelayMs : 15;
      const events =
        fixture.progressEvents && Array.isArray(fixture.progressEvents[eventName])
          ? fixture.progressEvents[eventName]
          : [];

      for (const evt of events) {
        if (cancelledFlags[cancelKey]) break;
        emitEvent(eventName, evt);
        if (delay > 0) await sleep(delay);
      }

      if (cancelledFlags[cancelKey]) {
        const base = deepMerge({}, resultData || {});
        if ("cancelled" in base) base.cancelled = true;
        if (base.status === "pass") base.status = "warn";
        if (cancelledPatch) Object.assign(base, cancelledPatch);
        return base;
      }

      return deepMerge({}, resultData);
    }

    const commandHandlers = {
      // Built-in Tauri plugins
      "plugin:event|listen": async (args) => {
        const eventName = args && args.event;
        const handlerId = args && args.handler;
        if (!eventListeners.has(eventName)) {
          eventListeners.set(eventName, new Set());
        }
        eventListeners.get(eventName).add(handlerId);
        return handlerId;
      },
      "plugin:event|unlisten": async (args) => {
        const eventName = args && args.event;
        const eventId = args && args.eventId;
        const set = eventListeners.get(eventName);
        if (set) set.delete(eventId);
        return null;
      },
      "plugin:event|emit": async (args) => {
        emitEvent(args && args.event, args && args.payload);
        return null;
      },
      "plugin:event|emit_to": async (args) => {
        emitEvent(args && args.event, args && args.payload);
        return null;
      },
      "plugin:window|set_decorations": async (args) => {
        windowState.decorations = Boolean(args && args.value);
        return null;
      },
      "plugin:window|set_always_on_top": async (args) => {
        windowState.alwaysOnTop = Boolean(args && args.value);
        return null;
      },
      "plugin:window|set_fullscreen": async (args) => {
        windowState.fullscreen = Boolean(args && args.value);
        return null;
      },
      "plugin:dialog|open": async () => {
        return fixture.dialogOpenResult !== undefined ? fixture.dialogOpenResult : "C:\\\\QC_Reports";
      },
      "plugin:dialog|save": async () => {
        return fixture.dialogSaveResult !== undefined
          ? fixture.dialogSaveResult
          : "C:\\\\QC_Reports\\\\shop_history.json";
      },
      "plugin:opener|open_path": async () => null,

      // 42 Existing LaptopBench QC commands
      get_system_specs: async () => fixture.specs,
      run_security_audit: async () => fixture.securityAudit,
      get_battery_health: async () => fixture.batteryHealth,
      start_battery_monitor: async () => {
        if (batteryMonitorTimer) clearInterval(batteryMonitorTimer);
        const samples =
          fixture.progressEvents && Array.isArray(fixture.progressEvents["battery:sample"])
            ? fixture.progressEvents["battery:sample"]
            : [];
        let i = 0;
        const sendSample = () => {
          const sample =
            samples.length > 0
              ? samples[i++ % samples.length]
              : {
                  timestampMs: Date.now(),
                  chargePercent: fixture.batteryHealth?.currentChargePercent ?? 90,
                  acPlugged: Boolean(fixture.batteryHealth?.acPlugged),
                  isCharging: Boolean(fixture.batteryHealth?.isCharging),
                  voltageMv: fixture.batteryHealth?.voltageMv ?? 16000,
                  rateMw: fixture.batteryHealth?.rateMw ?? 0,
                  watts: 0,
                };
          emitEvent("battery:sample", { ...sample, timestampMs: Date.now() });
        };
        setTimeout(sendSample, 15);
        batteryMonitorTimer = setInterval(sendSample, 1000);
        return null;
      },
      stop_battery_monitor: async () => {
        if (batteryMonitorTimer) {
          clearInterval(batteryMonitorTimer);
          batteryMonitorTimer = null;
        }
        return null;
      },
      run_battery_sag_pulse: async () =>
        runLongCommand("battery_sag", "battery:sag", fixture.batterySag, {
          summary: "Battery sag pulse cancelled by technician.",
        }),
      cancel_battery_sag_pulse: async () => {
        cancelledFlags.battery_sag = true;
        return null;
      },
      list_usb_devices: async () => fixture.usbDevices || [],
      start_usb_monitor: async () => {
        if (usbMonitorTimer) clearTimeout(usbMonitorTimer);
        usbMonitorTimer = setTimeout(() => {
          const events =
            fixture.progressEvents && Array.isArray(fixture.progressEvents["usb:event"])
              ? fixture.progressEvents["usb:event"]
              : [];
          if (events.length > 0) {
            emitEvent("usb:event", events[0]);
          } else {
            emitEvent("usb:event", {
              eventKind: "SNAPSHOT",
              timestamp: new Date().toISOString(),
              device: null,
              devices: fixture.usbDevices || [],
            });
          }
        }, 15);
        return null;
      },
      stop_usb_monitor: async () => {
        if (usbMonitorTimer) {
          clearTimeout(usbMonitorTimer);
          usbMonitorTimer = null;
        }
        return null;
      },
      save_qc_session: async (args) => {
        savedSessionState = {
          serialNumber: (args && args.serial) || "",
          model: (args && args.model) || "",
          savedAt: new Date().toISOString(),
          activeStressStage: args ? args.activeStressStage ?? null : null,
          stateJson: (args && args.stateJson) || "{}",
        };
        return null;
      },
      load_qc_session: async (args) => {
        if (!savedSessionState) return null;
        if (args && args.serial && savedSessionState.serialNumber && args.serial !== savedSessionState.serialNumber) {
          return null;
        }
        return savedSessionState;
      },
      clear_qc_session: async () => {
        savedSessionState = null;
        return null;
      },
      scan_error_logs: async () => fixture.errorLogs,
      scan_storage_smart: async () => fixture.storageSmart,
      run_storage_benchmark: async () =>
        runLongCommand("storage", "storage:progress", fixture.storageBench, {
          summary: "Storage benchmark cancelled.",
        }),
      cancel_storage_benchmark: async () => {
        cancelledFlags.storage = true;
        return null;
      },
      run_ram_stress: async () =>
        runLongCommand("ram", "ram:progress", fixture.ramTest, {
          cancelled: true,
          summary: "RAM stress cancelled.",
        }),
      cancel_ram_stress: async () => {
        cancelledFlags.ram = true;
        return null;
      },
      detect_biometrics_hardware: async () => fixture.biometricsHardware,
      trigger_biometric_prompt: async () => fixture.biometricAuth,
      start_keyboard_capture: async () => {
        return fixture.keyboardCaptureSupported !== undefined ? Boolean(fixture.keyboardCaptureSupported) : true;
      },
      stop_keyboard_capture: async () => null,
      run_performance_benchmark: async () =>
        runLongCommand("perf", "perf:progress", fixture.perfBench, {
          cancelled: true,
          durabilityGrade: "CANCELLED",
          summary: "Performance benchmark cancelled.",
        }),
      cancel_performance_benchmark: async () => {
        cancelledFlags.perf = true;
        return null;
      },
      list_gpu_adapters: async () => fixture.gpuAdapters || [],
      run_gpu_stress: async () =>
        runLongCommand("gpu", "gpu:progress", fixture.gpuStress, {
          cancelled: true,
          summary: "GPU stress cancelled.",
        }),
      cancel_gpu_stress: async () => {
        cancelledFlags.gpu = true;
        return null;
      },
      run_vram_test: async () =>
        runLongCommand("vram", "vram:progress", fixture.vramTest, {
          cancelled: true,
          summary: "VRAM test cancelled.",
        }),
      cancel_vram_test: async () => {
        cancelledFlags.vram = true;
        return null;
      },
      run_power_torture: async () =>
        runLongCommand("torture", "torture:progress", fixture.powerTorture, {
          cancelled: true,
          durabilityGrade: "CANCELLED",
          summary: "Power torture cancelled.",
        }),
      cancel_power_torture: async () => {
        cancelledFlags.torture = true;
        return null;
      },
      run_shelf_burnin: async () =>
        runLongCommand("burnin", "burnin:progress", fixture.burnIn, {
          cancelled: true,
          durabilityGrade: "INCOMPLETE",
          summary: "Shelf burn-in cancelled.",
        }),
      cancel_shelf_burnin: async () => {
        cancelledFlags.burnin = true;
        return null;
      },
      get_shop_model_comparison: async () => fixture.shopModelComparison,
      list_shop_history: async () => shopHistoryState,
      export_shop_history: async () => shopHistoryState.length,
      import_shop_history: async () => shopHistoryState.length,
      sample_live_telemetry: async () => {
        if (Array.isArray(fixture.telemetrySequence) && fixture.telemetrySequence.length > 0) {
          const item = fixture.telemetrySequence[telemetrySeqIdx % fixture.telemetrySequence.length];
          telemetrySeqIdx += 1;
          return item;
        }
        return fixture.telemetry;
      },
      load_shop_profile: async () => shopProfileState,
      save_shop_profile: async (args) => {
        if (args && args.profile) {
          shopProfileState = deepMerge(shopProfileState, args.profile);
        }
        return null;
      },
      export_qc_report: async () => fixture.exportedReportPaths,

      // 4 v2.3.0 LaptopBench QC commands
      compare_userbenchmark: async () => fixture.userBenchmark,
      run_battery_discharge_test: async () =>
        runLongCommand("battery_discharge", "battery:discharge", fixture.batteryDischarge, {
          verdict: "CANCELLED",
          plainSummary: "Battery discharge test cancelled by technician.",
        }),
      cancel_battery_discharge_test: async () => {
        cancelledFlags.battery_discharge = true;
        return null;
      },
      run_network_diagnostics: async () => fixture.networkDiagnostics,
      get_hardware_controls_status: async () =>
        fixture.hardwareControls || {
          platform: "Windows",
          displayBrightness: {
            supported: true,
            currentPct: 80,
            levelsCount: 101,
            canSet: true,
            status: "pass",
            detail: "Built-in backlight controller active (80% current, 101 steps).",
          },
          keyboardBacklight: {
            supported: true,
            currentPct: 50,
            status: "pass",
            detail: "Backlit keyboard detected (mock).",
          },
          wifi: {
            present: true,
            enabled: true,
            adapterName: "Intel Wi-Fi 6E AX211",
            connectionDetail: "Connected: LabBench (94%)",
            status: "pass",
            detail: "Wi-Fi radio active.",
          },
          bluetooth: {
            present: true,
            enabled: true,
            adapterName: "Intel Wireless Bluetooth",
            connectionDetail: "Radio ON (2 paired device(s))",
            status: "pass",
            detail: "Bluetooth radio operational.",
          },
          airplaneMode: {
            supported: true,
            active: false,
            status: "pass",
            detail: "Airplane Mode is OFF.",
          },
          headphoneJack: {
            pluggedIn: false,
            activeOutputName: "Speakers (Realtek Audio)",
            detectedEndpoints: ["Speakers (Realtek Audio)"],
            status: "pending",
            detail: "No headphones currently plugged in.",
          },
          summary: "Display: 80% | Wi-Fi: ON | BT: ON | Airplane: OFF | Headphone: Not Plugged",
        },
      set_display_brightness: async (args) => {
        const pct = Math.max(0, Math.min(100, Number(args?.percent ?? 75)));
        return pct;
      },
      run_cpu_stress: async (args) =>
        runLongCommand(
          "cpu_stress",
          "cpu_stress:progress",
          fixture.cpuStress || {
            status: "pass",
            dataSet: (args && args.dataSet) || "medium",
            loadType: (args && args.loadType) || "steady",
            threadsUsed: 8,
            simdIsa: "x86_64 AVX2 + FMA",
            durationSecs: (args && args.durationSecs) || 60,
            elapsedSecs: 60.0,
            calcErrors: 0,
            wheaErrors: 0,
            totalErrors: 0,
            iterationsCompleted: 240,
            avgClockMhz: 3400,
            minClockMhz: 3200,
            maxClockMhz: 3800,
            throttleDropPct: 4.5,
            peakTempC: 79.0,
            cooldownEndTempC: 61.0,
            cooldownDropC: 18.0,
            cooldownVerdict: "EXCELLENT",
            thermalCutoffTriggered: false,
            effectiveCutoffC: (args && args.thermalCutoffC) || 92.0,
            stoppedOnError: false,
            cancelled: false,
            summary: "0 errors over 60s (8 threads, avg 3400 MHz, throttle 4.5%, cool-down: EXCELLENT).",
            plainSummary: "CPU remained 100% error-free under sustained load with fast heatsink recovery.",
          },
          {
            cancelled: true,
            summary: "Stopped early — 0 errors.",
          }
        ),
      cancel_cpu_stress: async () => {
        cancelledFlags.cpu_stress = true;
        return null;
      },
    };

    async function invoke(cmd, args = {}, _options = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        cmd,
        args: args ?? {},
        ok: true,
        error: null,
        unknownCommand: false,
      };
      invokeLog.push(entry);

      if (fixture.commandErrors && Object.prototype.hasOwnProperty.call(fixture.commandErrors, cmd) && fixture.commandErrors[cmd]) {
        const msg = String(fixture.commandErrors[cmd]);
        entry.ok = false;
        entry.error = msg;
        throw new Error(msg);
      }

      if (mockOptions.commandOverrides && typeof mockOptions.commandOverrides[cmd] === "function") {
        try {
          return await mockOptions.commandOverrides[cmd](args, fixture, emitEvent);
        } catch (err) {
          entry.ok = false;
          entry.error = err && err.message ? err.message : String(err);
          throw err;
        }
      }

      const handler = commandHandlers[cmd];
      if (!handler) {
        entry.ok = false;
        entry.unknownCommand = true;
        entry.error = "Unknown Tauri command: " + cmd;
        errors.push({
          timestamp: entry.timestamp,
          source: "invoke",
          cmd,
          message: entry.error,
        });
        if (mockOptions.strictUnknownCommands !== false) {
          throw new Error(entry.error);
        }
        return null;
      }

      try {
        return await handler(args);
      } catch (err) {
        entry.ok = false;
        entry.error = err && err.message ? err.message : String(err);
        errors.push({
          timestamp: new Date().toISOString(),
          source: "invoke",
          cmd,
          message: entry.error,
        });
        throw err;
      }
    }

    window.isTauri = true;

    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      callbacks,
      transformCallback,
      unregisterCallback,
      runCallback,
      convertFileSrc(filePath, protocol = "asset") {
        return protocol + "://localhost/" + encodeURIComponent(String(filePath || ""));
      },
      invoke,
    };

    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, eventId) {
        const set = eventListeners.get(event);
        if (set) set.delete(eventId);
      },
    };

    window.__TAURI_MOCK__ = {
      emit(eventName, payload) {
        emitEvent(eventName, payload);
      },
      getInvokeLog() {
        return invokeLog.slice();
      },
      getErrors() {
        return errors.slice();
      },
      getWindowState() {
        return { ...windowState };
      },
      setFixturePatch(patch) {
        fixture = deepMerge(fixture, patch || {});
        if (patch && patch.shopProfile) {
          shopProfileState = deepMerge(shopProfileState, patch.shopProfile);
        }
        if (patch && Array.isArray(patch.shopHistory)) {
          shopHistoryState = patch.shopHistory.slice();
        }
        if (patch && Object.prototype.hasOwnProperty.call(patch, "savedSession")) {
          savedSessionState = patch.savedSession;
        }
      },
    };
  })();`;
}

export const buildTauriInitScript = createTauriInitScript;
