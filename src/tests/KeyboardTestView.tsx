import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Keyboard, RotateCcw, Shield, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface KeyboardTestViewProps {
  osFamily: string;
  status: TestStatus;
  notes: string;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext?: () => void;
}

interface KeyDef {
  code: string;
  label: string;
  w?: number; // relative flex width
}

type LayoutMode = "win_compact" | "win_full" | "mac_ansi";

const WIN_MAIN_ROWS: KeyDef[][] = [
  [
    { code: "Escape", label: "Esc", w: 1.2 },
    { code: "F1", label: "F1" }, { code: "F2", label: "F2" }, { code: "F3", label: "F3" }, { code: "F4", label: "F4" },
    { code: "F5", label: "F5" }, { code: "F6", label: "F6" }, { code: "F7", label: "F7" }, { code: "F8", label: "F8" },
    { code: "F9", label: "F9" }, { code: "F10", label: "F10" }, { code: "F11", label: "F11" }, { code: "F12", label: "F12" },
    { code: "PrintScreen", label: "PrtSc", w: 1.1 }, { code: "Delete", label: "Del", w: 1.1 },
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
    { code: "ControlLeft", label: "Ctrl", w: 1.3 }, { code: "MetaLeft", label: "Win", w: 1.2 },
    { code: "AltLeft", label: "Alt", w: 1.2 }, { code: "Space", label: "Space", w: 5.5 },
    { code: "AltRight", label: "Alt", w: 1.2 }, { code: "ControlRight", label: "Ctrl", w: 1.2 },
    { code: "ArrowLeft", label: "←" }, { code: "ArrowDown", label: "↓" }, { code: "ArrowRight", label: "→" },
  ],
];

const NUMPAD_ROWS: KeyDef[][] = [
  [{ code: "Home", label: "Home" }, { code: "End", label: "End" }, { code: "PageUp", label: "PgUp" }, { code: "PageDown", label: "PgDn" }],
  [{ code: "NumLock", label: "Num" }, { code: "NumpadDivide", label: "/" }, { code: "NumpadMultiply", label: "*" }, { code: "NumpadSubtract", label: "-" }],
  [{ code: "Numpad7", label: "7" }, { code: "Numpad8", label: "8" }, { code: "Numpad9", label: "9" }, { code: "NumpadAdd", label: "+" }],
  [{ code: "Numpad4", label: "4" }, { code: "Numpad5", label: "5" }, { code: "Numpad6", label: "6" }, { code: "Insert", label: "Ins" }],
  [{ code: "Numpad1", label: "1" }, { code: "Numpad2", label: "2" }, { code: "Numpad3", label: "3" }, { code: "NumpadEnter", label: "Ent" }],
  [{ code: "Numpad0", label: "0", w: 2 }, { code: "NumpadDecimal", label: "." }, { code: "ContextMenu", label: "Menu" }],
];

const MAC_ROWS: KeyDef[][] = [
  [
    { code: "Escape", label: "esc", w: 1.4 },
    { code: "F1", label: "F1" }, { code: "F2", label: "F2" }, { code: "F3", label: "F3" }, { code: "F4", label: "F4" },
    { code: "F5", label: "F5" }, { code: "F6", label: "F6" }, { code: "F7", label: "F7" }, { code: "F8", label: "F8" },
    { code: "F9", label: "F9" }, { code: "F10", label: "F10" }, { code: "F11", label: "F11" }, { code: "F12", label: "F12" },
  ],
  ...WIN_MAIN_ROWS.slice(1, 5),
  [
    { code: "ControlLeft", label: "ctrl", w: 1.2 }, { code: "AltLeft", label: "option", w: 1.3 },
    { code: "MetaLeft", label: "⌘ cmd", w: 1.5 }, { code: "Space", label: "Space", w: 5.5 },
    { code: "MetaRight", label: "⌘ cmd", w: 1.5 }, { code: "AltRight", label: "option", w: 1.3 },
    { code: "ArrowLeft", label: "←" }, { code: "ArrowDown", label: "↓" }, { code: "ArrowRight", label: "→" },
  ],
];

export const KeyboardTestView: React.FC<KeyboardTestViewProps> = ({
  osFamily,
  status,
  notes: initialNotes,
  onVerdict,
  onNext,
}) => {
  const [layout, setLayout] = useState<LayoutMode>(
    osFamily === "macos" ? "mac_ansi" : "win_compact"
  );
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const [testedKeys, setTestedKeys] = useState<Set<string>>(new Set());
  const [lastEvent, setLastEvent] = useState<string>("Press any key to begin...");
  const [chatterWarnings, setChatterWarnings] = useState<string[]>([]);
  const [osHookEnabled, setOsHookEnabled] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const lastUpTimes = useRef<Record<string, number>>({});

  const registerKey = (code: string, pressed: boolean, label?: string) => {
    const now = performance.now();
    if (pressed) {
      const prevUp = lastUpTimes.current[code];
      if (prevUp && now - prevUp < 25) {
        setChatterWarnings((w) =>
          w.includes(code) ? w : [...w, `${code} (${Math.round(now - prevUp)}ms bounce)`]
        );
      }
      setActiveKeys((prev) => new Set(prev).add(code));
      setTestedKeys((prev) => new Set(prev).add(code));
      setLastEvent(`DOWN: ${code}${label ? ` ("${label}")` : ""}`);
    } else {
      lastUpTimes.current[code] = now;
      setActiveKeys((prev) => {
        const next = new Set(prev);
        next.delete(code);
        return next;
      });
      setLastEvent(`UP: ${code}`);
    }
  };

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      e.preventDefault();
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
      listen<{ code: string; pressed: boolean }>("keyboard:raw", (ev) => {
        registerKey(ev.payload.code, ev.payload.pressed);
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
      if (osHookEnabled) {
        invoke("stop_keyboard_capture").catch(() => {});
      }
    };
  }, [osHookEnabled]);

  const rows = layout === "mac_ansi" ? MAC_ROWS : WIN_MAIN_ROWS;
  const totalLayoutKeys =
    rows.reduce((a, r) => a + r.length, 0) +
    (layout === "win_full" ? NUMPAD_ROWS.reduce((a, r) => a + r.length, 0) : 0);

  const resetAll = () => {
    setActiveKeys(new Set());
    setTestedKeys(new Set());
    setChatterWarnings([]);
    setLastEvent("Reset — press keys to test.");
  };

  const renderKey = (k: KeyDef) => {
    const isDown = activeKeys.has(k.code);
    const isTested = testedKeys.has(k.code);
    return (
      <div
        key={k.code}
        style={{ flex: k.w ?? 1 }}
        className={`h-11 rounded-lg border flex items-center justify-center text-[11px] font-semibold select-none transition-all duration-75 ${
          isDown
            ? "bg-cyan-400 text-slate-950 border-cyan-200 scale-95 shadow-lg shadow-cyan-400/40"
            : isTested
            ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/60"
            : "bg-slate-900 text-slate-300 border-slate-700"
        }`}
      >
        {k.label}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Keyboard Test (Offline Key-Test)</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Press every physical key. Active keys flash cyan, verified keys stay emerald, and rapid double-trigger chatter is flagged.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-xs">
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
                className={`px-2.5 py-1 rounded-md font-medium ${
                  layout === m ? "bg-cyan-500 text-slate-950 font-bold" : "text-slate-400 hover:text-white"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
          {osFamily === "windows" && (
            <button
              onClick={() => setOsHookEnabled((v) => !v)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
                osHookEnabled
                  ? "bg-cyan-500/20 border-cyan-400 text-cyan-200"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              {osHookEnabled ? "Win/PrtSc Capture ON" : "Capture Win/PrtSc Keys"}
            </button>
          )}
          <button
            onClick={resetAll}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          {onNext && (
            <button
              onClick={onNext}
              className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
            >
              Next Test →
            </button>
          )}
        </div>
      </div>

      {/* Telemetry bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-2.5 flex items-center justify-between flex-wrap gap-2 text-xs font-mono">
        <div className="flex items-center gap-4">
          <span className="text-slate-400">
            Tested: <strong className="text-emerald-400">{testedKeys.size}</strong> / {totalLayoutKeys}
          </span>
          <span className="text-slate-400">
            Currently Held: <strong className="text-cyan-300">{activeKeys.size}</strong>
          </span>
        </div>
        <div className="text-slate-300">{lastEvent}</div>
      </div>

      {chatterWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Key chatter / bounce detected: {chatterWarnings.join(", ")}</span>
        </div>
      )}

      {/* Visual Keyboard Deck */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-[760px]">
          <div className="flex-1 space-y-1.5">
            {rows.map((row, rIdx) => (
              <div key={rIdx} className="flex gap-1.5">
                {row.map(renderKey)}
              </div>
            ))}
          </div>
          {layout === "win_full" && (
            <div className="w-56 space-y-1.5 pl-2 border-l border-slate-800">
              {NUMPAD_ROWS.map((row, rIdx) => (
                <div key={rIdx} className="flex gap-1.5">
                  {row.map(renderKey)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Verdict */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <Keyboard className="w-4 h-4 text-cyan-400" />
          Keyboard QC Verdict
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional keyboard notes (e.g. Backlight works, all keys crisp, no stuck keys)"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict(
                "pass",
                `Keyboard verified (${testedKeys.size} keys registered, ${chatterWarnings.length} chatter alerts).`,
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Keyboard Test
          </button>
          <button
            onClick={() =>
              onVerdict(
                "fail",
                `Keyboard fault reported (${testedKeys.size} keys registered, ${chatterWarnings.length} chatter alerts).`,
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center gap-1.5"
          >
            <XCircle className="w-4 h-4" />
            Fail Keyboard Test
          </button>
        </div>
      </div>
    </div>
  );
};
