import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Keyboard, MousePointer2, RotateCcw, Shield, ShieldCheck, Sun, XCircle } from "lucide-react";
import type { HardwareControlsReport, RawKeyEvent, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface KeyboardTestViewProps {
  osFamily: string;
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

interface KeyDef {
  code: string;
  label: string;
  w?: number;
  osIntercepted?: boolean;
  firmwareOnly?: boolean;
}

type LayoutMode = "win_compact" | "win_full" | "mac_ansi";

const WIN_MAIN_ROWS: KeyDef[][] = [
  [
    { code: "Escape", label: "Esc", w: 1.2 },
    { code: "F1", label: "F1" }, { code: "F2", label: "F2" }, { code: "F3", label: "F3" }, { code: "F4", label: "F4" },
    { code: "F5", label: "F5" }, { code: "F6", label: "F6" }, { code: "F7", label: "F7" }, { code: "F8", label: "F8" },
    { code: "F9", label: "F9" }, { code: "F10", label: "F10" }, { code: "F11", label: "F11", osIntercepted: true }, { code: "F12", label: "F12" },
    { code: "PrintScreen", label: "PrtSc", w: 1.1, osIntercepted: true }, { code: "Delete", label: "Del", w: 1.1 },
  ],
  [
    { code: "Backquote", label: "` ~" }, { code: "Digit1", label: "1" }, { code: "Digit2", label: "2" },
    { code: "Digit3", label: "3" }, { code: "Digit4", label: "4" }, { code: "Digit5", label: "5" },
    { code: "Digit6", label: "6" }, { code: "Digit7", label: "7" }, { code: "Digit8", label: "8" },
    { code: "Digit9", label: "9" }, { code: "Digit0", label: "0" }, { code: "Minus", label: "-" },
    { code: "Equal", label: "=" }, { code: "Backspace", label: "Backspace", w: 2.0 },
  ],
  [
    { code: "Tab", label: "Tab", w: 1.5 }, { code: "KeyQ", label: "Q" }, { code: "KeyW", label: "W" },
    { code: "KeyE", label: "E" }, { code: "KeyR", label: "R" }, { code: "KeyT", label: "T" },
    { code: "KeyY", label: "Y" }, { code: "KeyU", label: "U" }, { code: "KeyI", label: "I" },
    { code: "KeyO", label: "O" }, { code: "KeyP", label: "P" }, { code: "BracketLeft", label: "[" },
    { code: "BracketRight", label: "]" }, { code: "Backslash", label: "\\", w: 1.5 },
  ],
  [
    { code: "CapsLock", label: "Caps", w: 1.8 }, { code: "KeyA", label: "A" }, { code: "KeyS", label: "S" },
    { code: "KeyD", label: "D" }, { code: "KeyF", label: "F" }, { code: "KeyG", label: "G" },
    { code: "KeyH", label: "H" }, { code: "KeyJ", label: "J" }, { code: "KeyK", label: "K" },
    { code: "KeyL", label: "L" }, { code: "Semicolon", label: ";" }, { code: "Quote", label: "'" },
    { code: "Enter", label: "Enter", w: 2.2 },
  ],
  [
    { code: "ShiftLeft", label: "Shift", w: 2.3 }, { code: "KeyZ", label: "Z" }, { code: "KeyX", label: "X" },
    { code: "KeyC", label: "C" }, { code: "KeyV", label: "V" }, { code: "KeyB", label: "B" },
    { code: "KeyN", label: "N" }, { code: "KeyM", label: "M" }, { code: "Comma", label: "," },
    { code: "Period", label: "." }, { code: "Slash", label: "/" }, { code: "ShiftRight", label: "Shift", w: 1.7 },
    { code: "ArrowUp", label: "↑" },
  ],
  [
    { code: "ControlLeft", label: "Ctrl", w: 1.2 }, { code: "FnKey", label: "Fn*", w: 1.0, osIntercepted: true, firmwareOnly: true },
    { code: "MetaLeft", label: "Win", w: 1.1, osIntercepted: true },
    { code: "AltLeft", label: "Alt", w: 1.1 }, { code: "Space", label: "Space", w: 4.8 },
    { code: "AltRight", label: "Alt", w: 1.1 }, { code: "ControlRight", label: "Ctrl", w: 1.1 },
    { code: "ArrowLeft", label: "←" }, { code: "ArrowDown", label: "↓" }, { code: "ArrowRight", label: "→" },
  ],
];

const NUMPAD_ROWS: KeyDef[][] = [
  [{ code: "Home", label: "Home" }, { code: "End", label: "End" }, { code: "PageUp", label: "PgUp" }, { code: "PageDown", label: "PgDn" }],
  [{ code: "NumLock", label: "Num" }, { code: "NumpadDivide", label: "/" }, { code: "NumpadMultiply", label: "*" }, { code: "NumpadSubtract", label: "-" }],
  [{ code: "Numpad7", label: "7" }, { code: "Numpad8", label: "8" }, { code: "Numpad9", label: "9" }, { code: "NumpadAdd", label: "+" }],
  [{ code: "Numpad4", label: "4" }, { code: "Numpad5", label: "5" }, { code: "Numpad6", label: "6" }, { code: "Insert", label: "Ins" }],
  [{ code: "Numpad1", label: "1" }, { code: "Numpad2", label: "2" }, { code: "Numpad3", label: "3" }, { code: "NumpadEnter", label: "Ent" }],
  [{ code: "Numpad0", label: "0", w: 2 }, { code: "NumpadDecimal", label: "." }, { code: "ContextMenu", label: "Menu", osIntercepted: true }],
];

const MAC_ROWS: KeyDef[][] = [
  [
    { code: "Escape", label: "esc", w: 1.4 },
    { code: "F1", label: "F1" }, { code: "F2", label: "F2" }, { code: "F3", label: "F3" }, { code: "F4", label: "F4" },
    { code: "F5", label: "F5" }, { code: "F6", label: "F6" }, { code: "F7", label: "F7" }, { code: "F8", label: "F8" },
    { code: "F9", label: "F9" }, { code: "F10", label: "F10" }, { code: "F11", label: "F11", osIntercepted: true }, { code: "F12", label: "F12" },
  ],
  ...WIN_MAIN_ROWS.slice(1, 5),
  [
    { code: "FnKey", label: "fn*", w: 1.1, osIntercepted: true, firmwareOnly: true },
    { code: "ControlLeft", label: "ctrl", w: 1.1 }, { code: "AltLeft", label: "option", w: 1.2 },
    { code: "MetaLeft", label: "⌘ cmd", w: 1.4, osIntercepted: true }, { code: "Space", label: "Space", w: 4.8 },
    { code: "MetaRight", label: "⌘ cmd", w: 1.4, osIntercepted: true }, { code: "AltRight", label: "option", w: 1.2 },
    { code: "ArrowLeft", label: "←" }, { code: "ArrowDown", label: "↓" }, { code: "ArrowRight", label: "→" },
  ],
];

export const KeyboardTestView: React.FC<KeyboardTestViewProps> = ({
  osFamily,
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const [subTab, setSubTab] = useState<"keyboard" | "touchpad">("keyboard");
  const [layout, setLayout] = useState<LayoutMode>(
    osFamily === "macos" ? "mac_ansi" : "win_compact"
  );
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const [testedKeys, setTestedKeys] = useState<Set<string>>(new Set());
  const [lastEvent, setLastEvent] = useState<string>("Press physical keys to begin...");
  const [chatterWarnings, setChatterWarnings] = useState<string[]>([]);
  const [osHookEnabled, setOsHookEnabled] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [kbBacklightDetail, setKbBacklightDetail] = useState<string>("Checking keyboard backlight hardware...");
  const [kbBacklightCheck, setKbBacklightCheck] = useState<"untested" | "pass" | "na" | "fail">("untested");

  useEffect(() => {
    invoke<HardwareControlsReport>("get_hardware_controls_status")
      .then((rep) => {
        if (rep?.keyboardBacklight?.detail) {
          setKbBacklightDetail(
            rep.keyboardBacklight.currentPct != null
              ? `${rep.keyboardBacklight.detail} (Current: ${rep.keyboardBacklight.currentPct}%)`
              : rep.keyboardBacklight.detail
          );
        }
      })
      .catch(() => {
        setKbBacklightDetail("Test keyboard backlight brightness levels using the laptop's Fn backlight key (or mark N/A if non-backlit).");
      });
  }, []);

  // en.key-test.ru metrics: Pre-test stuck-key check, NKRO rollover, Mean key dwell latency
  const [stuckCheckStatus, setStuckCheckStatus] = useState<"checking" | "clean" | "stuck">("checking");
  const [stuckKeys, setStuckKeys] = useState<string[]>([]);
  const [maxSimultaneousKeys, setMaxSimultaneousKeys] = useState<number>(0);
  const [meanDwellMs, setMeanDwellMs] = useState<number | null>(null);
  const [lastDwellMs, setLastDwellMs] = useState<number | null>(null);

  const activeKeysRef = useRef<Set<string>>(new Set());
  const keyDownTimesRef = useRef<Record<string, number>>({});
  const dwellSamplesRef = useRef<number[]>([]);
  const lastUpTimes = useRef<Record<string, number>>({});
  const lastEventSigRef = useRef<Record<string, { pressed: boolean; ts: number }>>({});
  const idleCheckingRef = useRef<boolean>(true);
  const idleHeldCandidatesRef = useRef<Set<string>>(new Set());
  const idleTimerRef = useRef<number | null>(null);
  const driftTimerRef = useRef<number | null>(null);
  const driftMoveHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);

  // Touchpad Dead-Zone Matrix (12x6 = 72 zones), Click & Drift state
  const [padCells, setPadCells] = useState<Set<number>>(new Set());
  const [leftClicks, setLeftClicks] = useState(0);
  const [rightClicks, setRightClicks] = useState(0);
  const [scrollEvents, setScrollEvents] = useState(0);
  const [driftTesting, setDriftTesting] = useState(false);
  const [driftPixels, setDriftPixels] = useState<number | null>(null);
  const driftOriginRef = useRef<{ x: number; y: number } | null>(null);
  const driftMaxRef = useRef<number>(0);

  const startStuckKeyCheck = () => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    idleCheckingRef.current = true;
    idleHeldCandidatesRef.current = new Set(activeKeysRef.current);
    setStuckKeys([]);
    setStuckCheckStatus("checking");

    idleTimerRef.current = window.setTimeout(() => {
      idleCheckingRef.current = false;
      idleTimerRef.current = null;
      const stillHeld = Array.from(
        new Set([...idleHeldCandidatesRef.current, ...activeKeysRef.current])
      );
      if (stillHeld.length > 0) {
        setStuckKeys((prev) => Array.from(new Set([...prev, ...stillHeld])));
        setStuckCheckStatus("stuck");
      } else {
        setStuckCheckStatus((cur) => (cur === "stuck" ? "stuck" : "clean"));
      }
      idleHeldCandidatesRef.current.clear();
    }, 1200);
  };

  useEffect(() => {
    startStuckKeyCheck();
    const holdMonitor = window.setInterval(() => {
      const now = performance.now();
      const longHeld: string[] = [];
      for (const code of activeKeysRef.current) {
        const downTs = keyDownTimesRef.current[code];
        if (downTs != null && now - downTs >= 3500) {
          longHeld.push(code);
        }
      }
      if (longHeld.length > 0) {
        setStuckKeys((prev) => Array.from(new Set([...prev, ...longHeld])));
        setStuckCheckStatus("stuck");
      }
    }, 800);
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      if (driftTimerRef.current !== null) window.clearTimeout(driftTimerRef.current);
      if (driftMoveHandlerRef.current) {
        window.removeEventListener("mousemove", driftMoveHandlerRef.current);
      }
      window.clearInterval(holdMonitor);
    };
  }, []);

  const startDriftCheck = () => {
    if (driftTimerRef.current !== null) window.clearTimeout(driftTimerRef.current);
    if (driftMoveHandlerRef.current) {
      window.removeEventListener("mousemove", driftMoveHandlerRef.current);
    }
    setDriftTesting(true);
    setDriftPixels(0);
    driftOriginRef.current = null;
    driftMaxRef.current = 0;
    const onMove = (e: MouseEvent) => {
      if (!driftOriginRef.current) {
        driftOriginRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      const dist = Math.hypot(e.clientX - driftOriginRef.current.x, e.clientY - driftOriginRef.current.y);
      if (dist > driftMaxRef.current) {
        driftMaxRef.current = Math.round(dist);
        setDriftPixels(driftMaxRef.current);
      }
    };
    driftMoveHandlerRef.current = onMove;
    window.addEventListener("mousemove", onMove);
    driftTimerRef.current = window.setTimeout(() => {
      window.removeEventListener("mousemove", onMove);
      driftMoveHandlerRef.current = null;
      driftTimerRef.current = null;
      setDriftTesting(false);
      setDriftPixels(driftMaxRef.current);
    }, 3000);
  };

  const registerKey = (code: string, pressed: boolean, label?: string) => {
    if (!code || code === "FnKey") return;
    const now = performance.now();

    // Deduplicate dual DOM + keyboard:raw events for the exact same (code, pressed) within 12ms
    const lastSig = lastEventSigRef.current[code];
    if (lastSig && lastSig.pressed === pressed && now - lastSig.ts < 12) {
      return;
    }
    lastEventSigRef.current[code] = { pressed, ts: now };

    if (pressed) {
      if (activeKeysRef.current.has(code)) {
        return;
      }
      const prevUp = lastUpTimes.current[code];
      if (prevUp && now - prevUp < 25) {
        setChatterWarnings((w) =>
          w.some((item) => item.startsWith(`${code} `))
            ? w
            : [...w, `${code} (${Math.round(now - prevUp)}ms bounce)`]
        );
      }
      keyDownTimesRef.current[code] = now;
      if (idleCheckingRef.current) {
        idleHeldCandidatesRef.current.add(code);
      }
      const nextActive = new Set(activeKeysRef.current);
      nextActive.add(code);
      activeKeysRef.current = nextActive;
      setActiveKeys(nextActive);
      setMaxSimultaneousKeys((prev) => Math.max(prev, nextActive.size));
      setTestedKeys((prev) => {
        if (prev.has(code)) return prev;
        const next = new Set(prev);
        next.add(code);
        return next;
      });
      setLastEvent(`DOWN: ${code}${label ? ` ("${label}")` : ""}`);
    } else {
      lastUpTimes.current[code] = now;
      idleHeldCandidatesRef.current.delete(code);
      const downTs = keyDownTimesRef.current[code];
      if (downTs != null) {
        const dwell = Math.max(1, Math.min(10000, Math.round(now - downTs)));
        const nextSamples = [...dwellSamplesRef.current.slice(-199), dwell];
        dwellSamplesRef.current = nextSamples;
        const avg = nextSamples.reduce((a, b) => a + b, 0) / nextSamples.length;
        setLastDwellMs(dwell);
        setMeanDwellMs(Math.round(avg * 10) / 10);
        delete keyDownTimesRef.current[code];
      }
      if (activeKeysRef.current.has(code)) {
        const nextActive = new Set(activeKeysRef.current);
        nextActive.delete(code);
        activeKeysRef.current = nextActive;
        setActiveKeys(nextActive);
      }
      setLastEvent(`UP: ${code}`);
    }
  };

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      e.preventDefault();
      if (e.repeat) {
        if (idleCheckingRef.current && e.code) {
          setStuckKeys((prev) => (prev.includes(e.code) ? prev : [...prev, e.code]));
          setStuckCheckStatus("stuck");
        }
        return;
      }
      registerKey(e.code, true, e.key);
    };
    const onUp = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      e.preventDefault();
      registerKey(e.code, false, e.key);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (osHookEnabled) {
      invoke<boolean>("start_keyboard_capture").catch(() => {});
      listen<RawKeyEvent>("keyboard:raw", (ev) => {
        registerKey(ev.payload.code, ev.payload.pressed);
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
      if (osHookEnabled) invoke("stop_keyboard_capture").catch(() => {});
    };
  }, [osHookEnabled]);

  const rows = layout === "mac_ansi" ? MAC_ROWS : WIN_MAIN_ROWS;
  const testableKeyCount = useMemo(() => {
    const mainCount = rows.reduce((a, r) => a + r.filter((k) => !k.firmwareOnly).length, 0);
    const numCount =
      layout === "win_full"
        ? NUMPAD_ROWS.reduce((a, r) => a + r.filter((k) => !k.firmwareOnly).length, 0)
        : 0;
    return mainCount + numCount;
  }, [rows, layout]);

  const testedTestableCount = useMemo(() => {
    const allCodes = new Set<string>();
    for (const r of rows) {
      for (const k of r) {
        if (!k.firmwareOnly) allCodes.add(k.code);
      }
    }
    if (layout === "win_full") {
      for (const r of NUMPAD_ROWS) {
        for (const k of r) {
          if (!k.firmwareOnly) allCodes.add(k.code);
        }
      }
    }
    let count = 0;
    for (const code of testedKeys) {
      if (allCodes.has(code)) count++;
    }
    return count;
  }, [rows, layout, testedKeys]);

  const coveragePct = testableKeyCount > 0 ? Math.min(100, Math.round((testedTestableCount / testableKeyCount) * 100)) : 0;

  const rolloverLabel =
    maxSimultaneousKeys >= 10
      ? `NKRO (${maxSimultaneousKeys}-Key)`
      : maxSimultaneousKeys >= 6
      ? `6KRO+ (${maxSimultaneousKeys}-Key)`
      : maxSimultaneousKeys >= 2
      ? `${maxSimultaneousKeys}KRO`
      : maxSimultaneousKeys === 1
      ? "1KRO (Press Chord)"
      : "Untested";

  const padPct = Math.round((padCells.size / 72) * 100);

  const resetKeyboardMatrix = () => {
    activeKeysRef.current = new Set();
    keyDownTimesRef.current = {};
    dwellSamplesRef.current = [];
    lastUpTimes.current = {};
    lastEventSigRef.current = {};
    setActiveKeys(new Set());
    setTestedKeys(new Set());
    setChatterWarnings([]);
    setMaxSimultaneousKeys(0);
    setMeanDwellMs(null);
    setLastDwellMs(null);
    setLastEvent("Reset — scanning idle matrix (1.2s)...");
    startStuckKeyCheck();
  };

  const renderKey = (k: KeyDef) => {
    const isDown = activeKeys.has(k.code);
    const isTested = testedKeys.has(k.code);
    const isStuck = stuckKeys.includes(k.code);
    return (
      <div
        key={k.code}
        style={{ flex: k.w ?? 1 }}
        title={
          k.firmwareOnly
            ? "EC Firmware Key (never emits OS scancode — informational only)"
            : k.osIntercepted
            ? "OS-Intercepted Key (informational — does not block passing)"
            : k.code
        }
        className={`relative h-11 rounded-[2px] border flex items-center justify-center text-[11px] font-bold select-none transition-all duration-75 ${
          isStuck
            ? "bg-black text-white border-2 border-black underline"
            : isDown
            ? "bg-black text-white border-black scale-95"
            : isTested
            ? "bg-blue-600 text-white border-blue-700"
            : k.osIntercepted
            ? "bg-[#F8FAFC] text-zinc-700 border-dashed border-zinc-400"
            : "bg-white text-black border-zinc-300"
        }`}
      >
        <span>{k.label}</span>
        {k.osIntercepted && !isTested && !isDown && (
          <span className="absolute top-0.5 right-1 font-mono text-[8px] font-bold uppercase text-zinc-500">
            {k.firmwareOnly ? "EC" : "OS"}
          </span>
        )}
      </div>
    );
  };

  const buildVerdictSummary = (verdictKind: "pass" | "warn" | "fail") => {
    const prefix =
      verdictKind === "pass"
        ? "Keyboard & Touchpad verified"
        : verdictKind === "warn"
        ? "Minor input issue noted"
        : "Input fault reported";
    return `${prefix}: Keyboard (${testedTestableCount}/${testableKeyCount} keys [${coveragePct}%], ${rolloverLabel}, dwell ${meanDwellMs != null ? `${meanDwellMs.toFixed(1)}ms` : "N/A"}, stuck ${stuckKeys.length}, chatter ${chatterWarnings.length}) & Touchpad (${padPct}% grid, L:${leftClicks}/R:${rightClicks}, scroll:${scrollEvents}, drift:${driftPixels ?? "N/A"}px).`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Keyboard &amp; Touchpad
              <span className="sr-only"> — Keyboard &amp; Touchpad Dead-Zone Audit</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • Stuck-key scan, NKRO rollover, chatter &amp; touchpad grid
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1 gap-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setSubTab("keyboard")}
            className={`px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 cursor-pointer ${
              subTab === "keyboard" ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" /> Keyboard ({testedTestableCount}/{testableKeyCount})
          </button>
          <button
            type="button"
            onClick={() => setSubTab("touchpad")}
            className={`px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 cursor-pointer ${
              subTab === "touchpad" ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
            }`}
          >
            <MousePointer2 className="w-3.5 h-3.5" /> Touchpad ({padPct}%)
          </button>
        </div>
      </div>

      {subTab === "touchpad" ? (
        <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-mono text-xs font-black uppercase text-black">
                Touchpad Surface Grid (12×6), Clicks, 2-Finger Scroll &amp; Drift Audit
              </div>
              <div className="text-[11px] text-zinc-600">
                Sweep cursor across every cell to detect digitizer dead zones; left-click, right-click, and 2-finger scroll inside the pad.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={startDriftCheck}
                disabled={driftTesting}
                className="px-3 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-[11px] font-bold uppercase cursor-pointer"
              >
                {driftTesting ? "Keep Hands Off (3s)..." : "3s Cursor-Drift Check"}
              </button>
              <button
                onClick={() => {
                  setPadCells(new Set());
                  setLeftClicks(0);
                  setRightClicks(0);
                  setScrollEvents(0);
                  setDriftPixels(null);
                }}
                className="px-3 py-1.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset Pad
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 border border-zinc-300 divide-x divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-xs">
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Surface Coverage</div>
              <div className="text-base font-black text-blue-700">
                {padPct}% ({padCells.size}/72)
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Left / Right Clicks</div>
              <div className="text-base font-black text-black">
                L:{leftClicks} / R:{rightClicks}
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">2-Finger Scroll</div>
              <div className="text-base font-black text-black">{scrollEvents} events</div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Phantom Drift</div>
              <div className={`text-base font-black ${(driftPixels ?? 0) > 4 ? "text-black underline" : "text-blue-700"}`}>
                {driftPixels == null ? "NOT RUN" : `${driftPixels} px`}
              </div>
            </div>
          </div>

          <div
            onClick={() => setLeftClicks((c) => c + 1)}
            onContextMenu={(e) => {
              e.preventDefault();
              setRightClicks((c) => c + 1);
            }}
            onWheel={(e) => {
              e.preventDefault();
              setScrollEvents((c) => c + 1);
            }}
            className="grid grid-cols-12 gap-1 p-2 bg-zinc-100 border border-zinc-300 rounded-[2px] select-none cursor-crosshair"
          >
            {Array.from({ length: 72 }).map((_, idx) => {
              const hit = padCells.has(idx);
              return (
                <div
                  key={idx}
                  onMouseEnter={() =>
                    setPadCells((prev) => {
                      if (prev.has(idx)) return prev;
                      const next = new Set(prev);
                      next.add(idx);
                      return next;
                    })
                  }
                  className={`h-9 rounded-[2px] border transition-colors ${
                    hit ? "bg-blue-600 border-blue-700" : "bg-white border-zinc-300 hover:bg-blue-100"
                  }`}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <button
                onClick={startStuckKeyCheck}
                className="px-3 py-1.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black font-mono text-[11px] font-bold uppercase text-black flex items-center gap-1.5 cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                Re-Run Stuck-Key Check
              </button>
            </div>
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <div className="inline-flex rounded-[2px] bg-zinc-100 border border-zinc-300 p-0.5 text-xs font-mono">
                {(
                  [
                    ["win_compact", "Win Compact"],
                    ["win_full", "Win + Numpad"],
                    ["mac_ansi", "MacBook"],
                  ] as [LayoutMode, string][]
                ).map(([m, lbl]) => (
                  <button
                    key={m}
                    onClick={() => setLayout(m)}
                    className={`px-2.5 py-1 rounded-[2px] font-bold cursor-pointer ${
                      layout === m ? "bg-blue-600 text-white" : "text-zinc-600 hover:text-black"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              {osFamily === "windows" && (
                <button
                  onClick={() => setOsHookEnabled((v) => !v)}
                  className={`px-3 py-1.5 rounded-[2px] border font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer ${
                    osHookEnabled
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-white border-black text-black hover:bg-zinc-100"
                  }`}
                >
                  <Shield className="w-3.5 h-3.5" />
                  {osHookEnabled ? "Win/PrtSc Capture ON" : "Capture Win/PrtSc"}
                </button>
              )}
              <button
                onClick={resetKeyboardMatrix}
                className="px-3 py-1.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black font-mono text-xs font-bold text-black flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
            </div>
          </div>

          {/* Pre-Test Stuck-Key Check Banner */}
          <div
            className={`rounded-[2px] border px-4 py-2 text-xs font-mono flex items-center justify-between flex-wrap gap-2 ${
              stuckCheckStatus === "stuck"
                ? "border-2 border-black bg-black text-white"
                : stuckCheckStatus === "checking"
                ? "border-blue-600 bg-blue-50/40 text-black"
                : "border-zinc-300 bg-[#F8FAFC] text-black"
            }`}
          >
            <div className="flex items-center gap-2 font-bold">
              {stuckCheckStatus === "stuck" ? (
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
              )}
              <span>
                {stuckCheckStatus === "checking"
                  ? "Scanning idle keyboard matrix (keep hands off for 1.2s)..."
                  : stuckCheckStatus === "clean"
                  ? "Pre-Test Stuck-Key Check: CLEAN (0 keys stuck at idle)"
                  : `STUCK KEY DETECTED: ${stuckKeys.join(", ")}`}
              </span>
            </div>
            {stuckCheckStatus === "stuck" && (
              <button
                onClick={startStuckKeyCheck}
                className="px-2.5 py-1 rounded-[2px] bg-white text-black font-bold text-[10.5px] uppercase cursor-pointer"
              >
                Clear / Re-Check
              </button>
            )}
          </div>

          {/* 6-Tile Swiss Telemetry Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border border-zinc-300 rounded-[2px] divide-x divide-y lg:divide-y-0 divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-xs">
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Keys Tested</div>
              <div className="text-sm font-black text-blue-700 mt-0.5">
                {testedTestableCount} / {testableKeyCount} <span className="text-[10.5px] text-zinc-600">({coveragePct}%)</span>
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Held / Peak Rollover</div>
              <div className="text-sm font-black text-black mt-0.5">
                {activeKeys.size} held • <span className="text-blue-700">{rolloverLabel}</span>
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Stuck-Key Check</div>
              <div className={`text-sm font-black mt-0.5 ${stuckCheckStatus === "stuck" ? "text-black underline" : "text-blue-700"}`}>
                {stuckCheckStatus === "checking"
                  ? "CHECKING"
                  : stuckCheckStatus === "clean"
                  ? "CLEAN"
                  : `${stuckKeys.length} STUCK`}
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Mean Key Dwell (Latency)</div>
              <div className="text-sm font-black text-black mt-0.5">
                {meanDwellMs != null ? `${meanDwellMs.toFixed(1)} ms` : "—"}
              </div>
              {lastDwellMs != null && (
                <div className="text-[9.5px] text-zinc-500">last {lastDwellMs} ms</div>
              )}
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Chatter (&lt;25ms)</div>
              <div className={`text-sm font-black mt-0.5 ${chatterWarnings.length > 0 ? "text-black underline" : "text-black"}`}>
                {chatterWarnings.length} warnings
              </div>
            </div>
            <div className="p-2.5">
              <div className="text-[9.5px] uppercase text-zinc-500">Last Event</div>
              <div className="text-xs font-bold text-black mt-1 truncate" title={lastEvent}>
                {lastEvent}
              </div>
            </div>
          </div>

          {chatterWarnings.length > 0 && (
            <div className="rounded-[2px] border-2 border-black bg-black text-white px-4 py-2.5 text-xs font-mono flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-blue-400" />
              <span>Key chatter / bounce detected (&lt;25ms): {chatterWarnings.join(", ")}</span>
            </div>
          )}

          {/* Visual Keyboard Deck */}
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] p-4 overflow-x-auto space-y-3">
            <div className="flex gap-3 min-w-[760px]">
              <div className="flex-1 space-y-1.5">
                {rows.map((row, rIdx) => (
                  <div key={rIdx} className="flex gap-1.5">
                    {row.map(renderKey)}
                  </div>
                ))}
              </div>
              {layout === "win_full" && (
                <div className="w-56 space-y-1.5 pl-2 border-l border-zinc-300">
                  {NUMPAD_ROWS.map((row, rIdx) => (
                    <div key={rIdx} className="flex gap-1.5">
                      {row.map(renderKey)}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* OS-Intercepted & Firmware Keys Legend */}
            <div className="pt-2.5 border-t border-zinc-200 flex items-center justify-between flex-wrap gap-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5 font-mono">
                <span className="text-[10px] font-bold uppercase text-zinc-500 mr-1">OS-Intercepted / EC Keys:</span>
                <span className="px-1.5 py-0.5 rounded-[2px] border border-dashed border-zinc-400 bg-white text-black text-[10px]">
                  Fn* (EC Firmware — no OS scancode)
                </span>
                <span className="px-1.5 py-0.5 rounded-[2px] border border-dashed border-zinc-400 bg-white text-black text-[10px]">
                  Win / ⌘ Cmd (OS Shell)
                </span>
                <span className="px-1.5 py-0.5 rounded-[2px] border border-dashed border-zinc-400 bg-white text-black text-[10px]">
                  PrtSc (OS Capture)
                </span>
                <span className="px-1.5 py-0.5 rounded-[2px] border border-dashed border-zinc-400 bg-white text-black text-[10px]">
                  F11 (Fullscreen)
                </span>
              </div>
              <span className="text-zinc-600 font-medium">
                Informational only: OS-intercepted keys do not block passing this audit.
              </span>
            </div>

            {/* Keyboard Backlight Brightness Verification */}
            <div className="pt-2.5 border-t border-zinc-200 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Sun className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <div className="text-[11px] text-zinc-700">
                  <strong className="font-mono uppercase text-[10.5px] text-black mr-1.5">
                    Keyboard Backlight Brightness:
                  </strong>
                  {kbBacklightDetail}
                </div>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold shrink-0">
                <button
                  type="button"
                  onClick={() => setKbBacklightCheck("pass")}
                  className={`px-2.5 py-1 rounded-[2px] border cursor-pointer ${
                    kbBacklightCheck === "pass"
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-white border-zinc-300 text-black hover:border-black"
                  }`}
                >
                  Backlight OK
                </button>
                <button
                  type="button"
                  onClick={() => setKbBacklightCheck("na")}
                  className={`px-2.5 py-1 rounded-[2px] border cursor-pointer ${
                    kbBacklightCheck === "na"
                      ? "bg-black border-black text-white"
                      : "bg-white border-zinc-300 text-zinc-700 hover:border-black"
                  }`}
                >
                  No Backlight (N/A)
                </button>
                <button
                  type="button"
                  onClick={() => setKbBacklightCheck("fail")}
                  className={`px-2.5 py-1 rounded-[2px] border cursor-pointer ${
                    kbBacklightCheck === "fail"
                      ? "bg-black border-black text-white underline"
                      : "bg-white border-zinc-300 text-black hover:border-black"
                  }`}
                >
                  Backlight Fault
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Plain-Language Summary Panel */}
      <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
          What This Means for Long-Term Use
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-[11px]">
          <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Switch Health &amp; Chatter</div>
            <div className="text-zinc-600 mt-0.5">
              {stuckKeys.length > 0
                ? `Stuck key(s) detected (${stuckKeys.join(", ")}) — may cause phantom typing or boot interrupts.`
                : chatterWarnings.length > 0
                ? `${chatterWarnings.length} key bounce warning(s) (<25ms) — worn switches can cause double-typed letters.`
                : `${testedTestableCount}/${testableKeyCount} testable switches (${coveragePct}%) checked with 0 stuck keys and 0 chatter bounce.`}
            </div>
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Rollover &amp; Response</div>
            <div className="text-zinc-600 mt-0.5">
              Peak rollover measured at <strong>{rolloverLabel}</strong>
              {meanDwellMs != null ? ` with ${meanDwellMs.toFixed(1)} ms mean key dwell.` : " — press a multi-key chord to verify rollover."}
            </div>
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Touchpad Precision</div>
            <div className="text-zinc-600 mt-0.5">
              Grid coverage {padPct}% ({padCells.size}/72 cells), L:{leftClicks}/R:{rightClicks} clicks, {scrollEvents} scroll events, drift{" "}
              {driftPixels == null ? "not tested" : `${driftPixels} px`}.
            </div>
          </div>
        </div>
      </div>

      {/* Verdict */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-black">
          <Keyboard className="w-4 h-4 text-blue-600" />
          Keyboard &amp; Touchpad QC Verdict
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes (e.g. Backlight verified, touchpad corners responsive, 0px drift)"
          className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-2 text-xs text-black"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onVerdict("pass", buildVerdictSummary("pass"), notes)}
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Pass Input Audit
          </button>
          <button
            onClick={() => onVerdict("warn", buildVerdictSummary("warn"), notes)}
            className="px-4 py-2 rounded-[2px] border border-blue-600 bg-white hover:bg-blue-50/40 text-blue-700 font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Mark Minor Issue (WARN)
          </button>
          <button
            onClick={() => onVerdict("fail", buildVerdictSummary("fail"), notes)}
            className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5" /> Fail Input Audit
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Test keys and record Pass, Warn, or Fail verdict to advance (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
