import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CheckCircle2,
  Hand,
  Maximize2,
  Minimize2,
  RotateCcw,
  SkipForward,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { TestStatus, TouchscreenTestResult } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface TouchscreenTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  result?: TouchscreenTestResult | null;
  onComplete?: (res: TouchscreenTestResult) => void;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

interface ActiveContact {
  id: number;
  x: number;
  y: number;
  normX: number;
  normY: number;
  pointerType: string;
  startTime: number;
}

type LaneId = "horizontal" | "vertical" | "diagonal";

interface StrokeTrack {
  lane: LaneId | null;
  pointerType: string;
  lastTs: number;
}

const GRID_COLS = 16;
const GRID_ROWS = 10;
const TOTAL_CELLS = GRID_COLS * GRID_ROWS; // 160 cells

function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function getLaneEndpoints(lane: LaneId, width: number, height: number): [number, number, number, number] {
  const padX = Math.max(18, width * 0.04);
  const padY = Math.max(18, height * 0.06);
  if (lane === "horizontal") {
    return [padX, height * 0.5, width - padX, height * 0.5];
  }
  if (lane === "vertical") {
    return [width * 0.5, padY, width * 0.5, height - padY];
  }
  return [padX, padY, width - padX, height - padY];
}

function nearestLane(px: number, py: number, width: number, height: number): { lane: LaneId | null; dist: number } {
  const lanes: LaneId[] = ["horizontal", "vertical", "diagonal"];
  let bestLane: LaneId | null = null;
  let bestDist = Infinity;
  for (const lane of lanes) {
    const [ax, ay, bx, by] = getLaneEndpoints(lane, width, height);
    const d = distPointToSegment(px, py, ax, ay, bx, by);
    if (d < bestDist) {
      bestDist = d;
      bestLane = lane;
    }
  }
  return { lane: bestDist <= 44 ? bestLane : null, dist: bestDist };
}

export const TouchscreenTestView: React.FC<TouchscreenTestViewProps> = ({
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  result,
  onComplete,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const reportedTouchPoints =
    typeof navigator !== "undefined" && typeof navigator.maxTouchPoints === "number"
      ? navigator.maxTouchPoints
      : 0;

  const [fullscreen, setFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(false);
  const hudTimerRef = useRef<number | null>(null);
  const [notes, setNotes] = useState(initialNotes);

  const scheduleHudHide = useCallback((ms = 4000) => {
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
      hudTimerRef.current = null;
    }, ms);
  }, []);

  const revealHud = useCallback(
    (ms = 4500) => {
      setHudVisible(true);
      scheduleHudHide(ms);
    },
    [scheduleHudHide]
  );

  const hideHudNow = useCallback(() => {
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current);
      hudTimerRef.current = null;
    }
    setHudVisible(false);
  }, []);

  // Coverage Matrix state (16 x 10 = 160 cells) — strictly populated by pointerType === "touch"
  const [coveredSet, setCoveredSet] = useState<Set<number>>(() => new Set());
  const [touchEventCount, setTouchEventCount] = useState(0);
  const [simulatedEventCount, setSimulatedEventCount] = useState(0);

  // Multi-touch simultaneous contact tracking
  const activeContactsRef = useRef<Map<number, ActiveContact>>(new Map());
  const strokeTrackRef = useRef<Map<number, StrokeTrack>>(new Map());
  const [activeContacts, setActiveContacts] = useState<ActiveContact[]>([]);
  const [maxSimultaneousTouches, setMaxSimultaneousTouches] = useState<number>(
    result?.maxSimultaneousTouches ?? 0
  );

  // Swipe linearity & polling / latency telemetry
  const linearitySqSumRef = useRef<number>(0);
  const linearityCountRef = useRef<number>(0);
  const linearityMaxRef = useRef<number>(0);
  const [testedLanes, setTestedLanes] = useState<Set<LaneId>>(() => new Set());
  const [swipeRmsPx, setSwipeRmsPx] = useState<number>(result?.swipeLinearityRmsPx ?? 0);
  const [swipeMaxPx, setSwipeMaxPx] = useState<number>(result?.maxLinearityErrorPx ?? 0);

  const deltaSamplesRef = useRef<number[]>([]);
  const [pollingHz, setPollingHz] = useState<number>(result?.pollingHz ?? 0);
  const [tapLatencyMs, setTapLatencyMs] = useState<number | null>(result?.tapLatencyMs ?? null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;

  const touchCapable = reportedTouchPoints > 0 || touchEventCount > 0;
  const coveredCells = coveredSet.size;
  const coveragePct = Math.round((coveredCells / TOTAL_CELLS) * 1000) / 10;
  const deadZoneCells = TOTAL_CELLS - coveredCells;

  const enterFullscreen = async () => {
    setFullscreen(true);
    revealHud(2200);
    try {
      const win = getCurrentWindow();
      await win.setDecorations(false);
      await win.setAlwaysOnTop(true);
      await win.setFullscreen(true);
    } catch {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };

  const exitFullscreen = useCallback(async () => {
    hideHudNow();
    setFullscreen(false);
    try {
      const win = getCurrentWindow();
      await win.setFullscreen(false);
      await win.setAlwaysOnTop(false);
      await win.setDecorations(true);
    } catch {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
  }, [hideHudNow]);

  useEffect(() => {
    return () => {
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current);
        hudTimerRef.current = null;
      }
      if (fullscreenRef.current) {
        try {
          const win = getCurrentWindow();
          win.setFullscreen(false).catch(() => {});
          win.setAlwaysOnTop(false).catch(() => {});
          win.setDecorations(true).catch(() => {});
        } catch {
          // Ignore outside Tauri
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitFullscreen();
      } else if (e.key.toLowerCase() === "h") {
        setHudVisible((prev) => {
          const next = !prev;
          if (next) scheduleHudHide(4500);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, exitFullscreen, scheduleHudHide]);

  const resetMatrix = () => {
    activeContactsRef.current.clear();
    strokeTrackRef.current.clear();
    linearitySqSumRef.current = 0;
    linearityCountRef.current = 0;
    linearityMaxRef.current = 0;
    deltaSamplesRef.current = [];
    setActiveContacts([]);
    setCoveredSet(new Set());
    setTouchEventCount(0);
    setSimulatedEventCount(0);
    setMaxSimultaneousTouches(0);
    setTestedLanes(new Set());
    setSwipeRmsPx(0);
    setSwipeMaxPx(0);
    setPollingHz(0);
    setTapLatencyMs(null);
  };

  const syncContactsState = () => {
    const list = Array.from(activeContactsRef.current.values());
    setActiveContacts(list);
    if (list.length > 0) {
      setMaxSimultaneousTouches((prev) => Math.max(prev, list.length));
    }
  };

  const recordSampleAt = (
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
    timestamp: number,
    rect: DOMRect,
    isDown: boolean
  ) => {
    if (pointerType !== "touch" || rect.width <= 0 || rect.height <= 0) return;

    const localX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const localY = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const normX = localX / rect.width;
    const normY = localY / rect.height;

    const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(normX * GRID_COLS)));
    const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(normY * GRID_ROWS)));
    const cellIdx = row * GRID_COLS + col;

    setCoveredSet((prev) => {
      if (prev.has(cellIdx)) return prev;
      const next = new Set(prev);
      next.add(cellIdx);
      return next;
    });

    activeContactsRef.current.set(pointerId, {
      id: pointerId,
      x: localX,
      y: localY,
      normX,
      normY,
      pointerType,
      startTime: activeContactsRef.current.get(pointerId)?.startTime ?? timestamp,
    });

    let track = strokeTrackRef.current.get(pointerId);
    if (isDown || !track) {
      const nearest = nearestLane(localX, localY, rect.width, rect.height);
      track = { lane: nearest.lane, pointerType, lastTs: timestamp };
      strokeTrackRef.current.set(pointerId, track);
      if (nearest.lane) {
        setTestedLanes((prev) => {
          if (prev.has(nearest.lane!)) return prev;
          const next = new Set(prev);
          next.add(nearest.lane!);
          return next;
        });
      }
    } else {
      const dt = timestamp - track.lastTs;
      track.lastTs = timestamp;
      if (dt >= 1 && dt <= 250) {
        const samples = deltaSamplesRef.current;
        samples.push(dt);
        if (samples.length > 120) samples.shift();
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)];
        if (mid > 0) {
          setPollingHz(Math.min(1000, Math.round(1000 / mid)));
        }
      }
    }

    if (track.lane) {
      const [ax, ay, bx, by] = getLaneEndpoints(track.lane, rect.width, rect.height);
      const err = distPointToSegment(localX, localY, ax, ay, bx, by);
      linearitySqSumRef.current += err * err;
      linearityCountRef.current += 1;
      if (err > linearityMaxRef.current) {
        linearityMaxRef.current = err;
      }
      const rms = Math.sqrt(linearitySqSumRef.current / linearityCountRef.current);
      setSwipeRmsPx(Math.round(rms * 10) / 10);
      setSwipeMaxPx(Math.round(linearityMaxRef.current * 10) / 10);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pType = e.pointerType || "mouse";
    if (pType !== "touch") {
      setSimulatedEventCount((c) => c + 1);
      return;
    }

    e.preventDefault();
    if (fullscreenRef.current) {
      hideHudNow();
    }
    const el = surfaceRef.current;
    if (!el) return;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture errors
    }

    const downTs = performance.now();
    requestAnimationFrame(() => {
      const latency = Math.round((performance.now() - downTs) * 10) / 10;
      setTapLatencyMs(latency);
    });

    setTouchEventCount((c) => c + 1);

    const rect = el.getBoundingClientRect();
    recordSampleAt(e.pointerId, pType, e.clientX, e.clientY, e.timeStamp || downTs, rect, true);
    syncContactsState();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pType = e.pointerType || "mouse";
    if (pType !== "touch") {
      if (e.buttons > 0) {
        setSimulatedEventCount((c) => c + 1);
      }
      return;
    }

    const isActivePointer = activeContactsRef.current.has(e.pointerId) || e.buttons > 0;
    if (!isActivePointer) return;

    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    if (coalesced.length > 0) {
      for (const ce of coalesced) {
        setTouchEventCount((c) => c + 1);
        recordSampleAt(
          e.pointerId,
          pType,
          ce.clientX,
          ce.clientY,
          ce.timeStamp || performance.now(),
          rect,
          false
        );
      }
    } else {
      setTouchEventCount((c) => c + 1);
      recordSampleAt(
        e.pointerId,
        pType,
        e.clientX,
        e.clientY,
        e.timeStamp || performance.now(),
        rect,
        false
      );
    }
    syncContactsState();
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.pointerType || "mouse") !== "touch") return;
    activeContactsRef.current.delete(e.pointerId);
    strokeTrackRef.current.delete(e.pointerId);
    syncContactsState();
  };

  const plainSummaryText = useMemo(() => {
    if (!touchCapable && coveredCells === 0) {
      return "No touch digitizer reported by hardware (maxTouchPoints = 0). Click Skip Step for standard non-touch laptops, or touch an external USB touch monitor to test.";
    }
    if (coveredCells === 0) {
      return `Touch digitizer detected (${reportedTouchPoints}-point capable). Drag across all 160 cells and trace the Horizontal, Vertical, and Diagonal guide lanes to verify dead zones and linearity.`;
    }
    const deadNote =
      coveredCells === TOTAL_CELLS
        ? "Full edge-to-edge panel responsiveness verified with zero dead zones."
        : coveragePct >= 95
        ? `High touch coverage (${coveragePct.toFixed(1)}%), with ${deadZoneCells} grid cell${
            deadZoneCells === 1 ? "" : "s"
          } still untouched — sweep remaining edge cells before passing.`
        : coveragePct >= 75
        ? `${deadZoneCells} cells still untouched — swipe corners/edges before finalizing to confirm no dead strip.`
        : `Only ${coveredCells}/${TOTAL_CELLS} cells (${coveragePct}%) swept so far — continue dragging across missed grid cells.`;
    const linNote =
      linearityCountRef.current > 0
        ? swipeRmsPx <= 5
          ? `Swipe linearity is crisp (${swipeRmsPx} px RMS).`
          : swipeRmsPx <= 11
          ? `Minor swipe jitter detected (${swipeRmsPx} px RMS).`
          : `Elevated swipe waviness (${swipeRmsPx} px RMS) — check digitizer calibration or glass grounding.`
        : "Trace a guide lane to measure swipe linearity.";
    return `${deadNote} Peak simultaneous contacts: ${maxSimultaneousTouches}. ${linNote}`;
  }, [touchCapable, coveredCells, reportedTouchPoints, coveragePct, deadZoneCells, swipeRmsPx, maxSimultaneousTouches]);

  const buildResult = (verdict: TouchscreenTestResult["verdict"], nextStatus: TestStatus, customSummary: string): TouchscreenTestResult => ({
    touchCapable,
    maxTouchPointsReported: reportedTouchPoints,
    gridRows: GRID_ROWS,
    gridCols: GRID_COLS,
    coveredCells,
    totalCells: TOTAL_CELLS,
    coveragePct,
    maxSimultaneousTouches,
    swipeLinearityRmsPx: swipeRmsPx,
    maxLinearityErrorPx: swipeMaxPx,
    pollingHz,
    tapLatencyMs,
    status: nextStatus,
    verdict,
    plainSummary: customSummary,
  });

  const handleRecordVerdict = (verdict: "PASS" | "WARN" | "FAIL") => {
    if (verdict === "PASS" && touchEventCount === 0) {
      return;
    }
    const nextStatus: TestStatus = verdict === "PASS" ? "pass" : verdict === "WARN" ? "warn" : "fail";
    const summary =
      verdict === "PASS"
        ? `Touchscreen verified: ${coveredCells}/${TOTAL_CELLS} cells (${coveragePct}%), ${maxSimultaneousTouches}-point multi-touch, ${swipeRmsPx} px RMS linearity, ${pollingHz} Hz.`
        : verdict === "WARN"
        ? `Touchscreen minor issue: ${coveredCells}/${TOTAL_CELLS} cells (${coveragePct}%), ${maxSimultaneousTouches}-pt, ${swipeRmsPx} px RMS.`
        : `Touchscreen defect detected: dead zones or erratic tracking (${coveredCells}/${TOTAL_CELLS} cells, ${swipeRmsPx} px RMS).`;
    const res = buildResult(verdict, nextStatus, summary);
    onComplete?.(res);
    onVerdict(nextStatus, summary, notes);
  };

  const handleOneClickSkip = () => {
    const res = buildResult(
      "SKIPPED",
      "skipped",
      reportedTouchPoints === 0
        ? "No touchscreen detected (maxTouchPoints = 0) — explicitly skipped."
        : "Touchscreen test explicitly skipped by technician."
    );
    onComplete?.(res);
    onSkip();
  };

  const renderInteractiveSurface = (isPortalFullscreen: boolean) => (
    <div
      ref={surfaceRef}
      data-testid="touchscreen-matrix"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      className={`relative touch-none select-none overflow-hidden bg-white ${
        isPortalFullscreen
          ? "w-full h-full"
          : "w-full h-[380px] rounded-[2px] border border-zinc-300"
      }`}
    >
      {/* 16x10 Coverage Matrix */}
      <div
        className="grid w-full h-full"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: TOTAL_CELLS }).map((_, idx) => {
          const hit = coveredSet.has(idx);
          return (
            <div
              key={idx}
              data-cell-index={idx}
              data-hit={hit ? "true" : "false"}
              className={`border-[0.5px] transition-colors duration-75 flex items-center justify-center font-mono text-[9px] ${
                hit
                  ? "bg-blue-600 border-blue-700 text-white font-bold"
                  : "bg-[#FAFAFA] border-zinc-200 text-zinc-300"
              }`}
            >
              {hit ? "✓" : ""}
            </div>
          );
        })}
      </div>

      {/* Horizontal, Vertical, Diagonal Swipe Linearity Guide Lanes */}
      <svg
        className="pointer-events-none absolute inset-0 w-full h-full"
        viewBox="0 0 1000 625"
        preserveAspectRatio="none"
      >
        {/* Horizontal lane */}
        <line
          x1="40"
          y1="312.5"
          x2="960"
          y2="312.5"
          stroke={testedLanes.has("horizontal") ? "#1D4ED8" : "#09090B"}
          strokeWidth="2.5"
          strokeDasharray="10 8"
          strokeOpacity={testedLanes.has("horizontal") ? "0.95" : "0.35"}
        />
        {/* Vertical lane */}
        <line
          x1="500"
          y1="38"
          x2="500"
          y2="587"
          stroke={testedLanes.has("vertical") ? "#1D4ED8" : "#09090B"}
          strokeWidth="2.5"
          strokeDasharray="10 8"
          strokeOpacity={testedLanes.has("vertical") ? "0.95" : "0.35"}
        />
        {/* Diagonal lane */}
        <line
          x1="40"
          y1="38"
          x2="960"
          y2="587"
          stroke={testedLanes.has("diagonal") ? "#1D4ED8" : "#09090B"}
          strokeWidth="2.5"
          strokeDasharray="10 8"
          strokeOpacity={testedLanes.has("diagonal") ? "0.95" : "0.35"}
        />
      </svg>

      {/* Active Multi-Touch Contact Reticles */}
      {activeContacts.map((contact, idx) => (
        <div
          key={contact.id}
          style={{
            left: `${contact.normX * 100}%`,
            top: `${contact.normY * 100}%`,
          }}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 border-black bg-blue-600/25 flex items-center justify-center"
        >
          <span className="px-1 py-0.2 rounded-[2px] bg-black text-white font-mono text-[9px] font-bold">
            P{idx + 1}
          </span>
        </div>
      ))}

      {/* Fullscreen Auto-Hiding Floating Control Bar + Touch Reveal Handle */}
      {isPortalFullscreen && (
        <>
          {/* Subtle bottom-center tap/hover zone to reveal HUD without blocking cells */}
          {!hudVisible && (
            <button
              type="button"
              aria-label="Show Touch Controls"
              onPointerDown={(e) => {
                e.stopPropagation();
                revealHud(5000);
              }}
              onMouseEnter={() => revealHud(5000)}
              onClick={(e) => {
                e.stopPropagation();
                revealHud(5000);
              }}
              className="fixed bottom-1.5 left-1/2 -translate-x-1/2 px-5 py-1.5 rounded-full bg-black/25 hover:bg-black/75 text-white/90 text-[10px] font-mono font-bold tracking-wider backdrop-blur-xs transition cursor-pointer flex items-center gap-2"
            >
              <span className="w-8 h-1 rounded-full bg-white/80" />
              <span>{coveredCells}/{TOTAL_CELLS}</span>
            </button>
          )}

          {/* Auto-hiding description & control rectangle (appears when handle touched/hovered or H pressed) */}
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              revealHud(6000);
            }}
            onMouseEnter={() => {
              if (hudTimerRef.current !== null) {
                window.clearTimeout(hudTimerRef.current);
                hudTimerRef.current = null;
              }
              setHudVisible(true);
            }}
            onMouseLeave={() => scheduleHudHide(2000)}
            className={`fixed bottom-4 left-1/2 -translate-x-1/2 bg-black/90 text-white border border-zinc-700 rounded-xl px-4 py-2 flex items-center gap-4 text-xs font-mono shadow-xl transition-all duration-200 ${
              hudVisible
                ? "opacity-100 translate-y-0 pointer-events-auto"
                : "opacity-0 translate-y-3 pointer-events-none"
            }`}
          >
            <span>
              GRID {coveredCells}/{TOTAL_CELLS} ({coveragePct}%) • MAX {maxSimultaneousTouches}-PT • RMS{" "}
              {swipeRmsPx}px • {pollingHz}Hz
              {simulatedEventCount > 0 && touchEventCount === 0 ? " • MOUSE IGNORED (USE TOUCH)" : ""}
            </span>
            <button
              type="button"
              onClick={resetMatrix}
              className="px-2.5 py-1 rounded-md border border-zinc-600 hover:bg-zinc-800 text-white font-bold cursor-pointer"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={exitFullscreen}
              className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-bold flex items-center gap-1 cursor-pointer"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              Exit Fullscreen (Esc)
            </button>
          </div>
        </>
      )}
    </div>
  );

  const fullscreenPortal = fullscreen
    ? createPortal(
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            margin: 0,
            padding: 0,
            zIndex: 999999,
            backgroundColor: "#ffffff",
          }}
          className="select-none overflow-hidden"
        >
          {renderInteractiveSurface(true)}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="space-y-6">
      {fullscreenPortal}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight flex items-center gap-2">
              <Hand className="w-5 h-5 text-blue-600" />
              Touchscreen &amp; Multi-Touch
              <span className="sr-only">Touchscreen &amp; Multi-Touch Digitizer Test</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • 160-cell touch grid, multi-touch &amp; linearity
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={resetMatrix}
            className="px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:border-black text-black text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Matrix
          </button>
          <button
            type="button"
            onClick={enterFullscreen}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Fullscreen Touch Test
          </button>
        </div>
      </div>

      {/* Non-Touch Hardware Detection Banner (with 1-Click Skip Step) */}
      {reportedTouchPoints === 0 && (
        <div className="rounded-[2px] border-2 border-black bg-[#F8FAFC] px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="font-mono text-[11px] font-black uppercase tracking-wider text-black">
              No Touchscreen Detected — Click Skip Step
            </div>
            <div className="text-xs text-zinc-700">
              Hardware reports <code className="font-mono font-bold text-black">maxTouchPoints = 0</code> (standard non-touch display). You can skip immediately or test an external USB touch monitor below.
            </div>
          </div>
          <button
            type="button"
            onClick={handleOneClickSkip}
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 shrink-0 cursor-pointer"
          >
            <SkipForward className="w-4 h-4" />
            Skip Step
          </button>
        </div>
      )}

      {/* Non-Certifying Mouse/Trackpad Notice */}
      {simulatedEventCount > 0 && (
        <div
          data-testid="non-touch-notice"
          className="rounded-[2px] border border-zinc-400 bg-[#F8FAFC] px-4 py-2.5 flex items-center justify-between gap-3"
        >
          <div className="text-xs text-black font-medium">
            Mouse/trackpad input ignored for touchscreen certification — use finger touch or click Skip Step.
          </div>
          <span className="font-mono text-[10px] font-bold uppercase text-zinc-600 shrink-0">
            {simulatedEventCount} non-touch ignored
          </span>
        </div>
      )}

      {/* Dense Swiss Telemetry Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 font-mono tabular-nums">
        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">Digitizer Hardware</div>
          <div className="mt-1 text-sm font-black text-black">
            {reportedTouchPoints > 0 ? `${reportedTouchPoints}-PT TOUCH` : "0-PT (NONE)"}
          </div>
          <div className="text-[10px] text-blue-700 font-semibold mt-0.5">
            {touchEventCount > 0
              ? `${touchEventCount} touch events`
              : simulatedEventCount > 0
              ? `${simulatedEventCount} mouse/pen ignored`
              : "Awaiting contact"}
          </div>
        </div>

        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">16×10 Grid Coverage</div>
          <div className="mt-1 text-sm font-black text-blue-600">
            {coveredCells} / {TOTAL_CELLS} ({coveragePct.toFixed(1)}%)
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">{deadZoneCells} untouched cells</div>
        </div>

        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">Multi-Touch Peak</div>
          <div className="mt-1 text-sm font-black text-black">
            {maxSimultaneousTouches} / 10 Points
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">Active now: {activeContacts.length}</div>
        </div>

        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">Swipe Linearity RMS</div>
          <div className="mt-1 text-sm font-black text-black">{swipeRmsPx.toFixed(1)} px</div>
          <div className="text-[10px] text-zinc-600 mt-0.5">Max drift: {swipeMaxPx.toFixed(1)} px</div>
        </div>

        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">Touch Polling Rate</div>
          <div className="mt-1 text-sm font-black text-blue-700">
            {pollingHz > 0 ? `${pollingHz} Hz` : "—"}
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">Coalesced sample rate</div>
        </div>

        <div className="rounded-[2px] border border-zinc-300 bg-white p-3">
          <div className="text-[10px] font-bold uppercase text-zinc-500">Tap Response</div>
          <div className="mt-1 text-sm font-black text-black">
            {tapLatencyMs != null ? `${tapLatencyMs.toFixed(1)} ms` : "—"}
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">Down → Frame commit</div>
        </div>
      </div>

      {/* 10-Point Multi-Touch Slot Pills + Guide Lane Badges */}
      <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[10px] font-bold uppercase text-zinc-600 mr-1">
            Multi-Touch Slots:
          </span>
          {Array.from({ length: 10 }).map((_, i) => {
            const activeNow = i < activeContacts.length;
            const reached = i < maxSimultaneousTouches;
            return (
              <span
                key={i}
                className={`px-1.5 py-0.5 rounded-[2px] border font-mono text-[10px] font-bold tabular-nums ${
                  activeNow
                    ? "bg-blue-600 border-blue-600 text-white"
                    : reached
                    ? "bg-black border-black text-white"
                    : "bg-white border-zinc-300 text-zinc-400"
                }`}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="font-bold uppercase text-zinc-600">Guide Lanes:</span>
          {(["horizontal", "vertical", "diagonal"] as LaneId[]).map((lane) => {
            const ok = testedLanes.has(lane);
            return (
              <span
                key={lane}
                className={`px-2 py-0.5 rounded-[2px] border uppercase font-bold ${
                  ok
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-zinc-300 text-zinc-500"
                }`}
              >
                {lane}
              </span>
            );
          })}
        </div>
      </div>

      {/* Interactive 16x10 Surface (when not in portal fullscreen) */}
      {!fullscreen && renderInteractiveSurface(false)}

      {/* Plain-Language Interpretation */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-2">
        <div className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-blue-700">
          <Sparkles className="w-3.5 h-3.5" />
          What This Means for Long-Term Use
        </div>
        <p className="text-xs text-zinc-800 leading-relaxed">{plainSummaryText}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1 text-[11px] text-zinc-600">
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Dead Zones (Grid):</strong> Untouched stripes or corners after dragging across the entire panel indicate a damaged digitizer flex ribbon or delaminated ITO trace.
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Multi-Touch &amp; Ghost Touches:</strong> Healthy Windows Precision/capacitive panels register 5–10 simultaneous fingers cleanly without phantom jumps when fingers cross.
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Linearity &amp; Polling:</strong> Under 5 px RMS deviation and 60–240 Hz polling ensures smooth handwriting, scrolling, and pinch-to-zoom accuracy.
          </div>
        </div>
      </div>

      {/* Verdict Panel */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm font-bold text-black">Technician Touch Digitizer Verdict</span>
          <span className="font-mono text-xs text-zinc-600 tabular-nums">
            Coverage: <strong className="text-blue-700">{coveragePct.toFixed(1)}%</strong> • Multi-Touch:{" "}
            <strong className="text-black">{maxSimultaneousTouches}-pt</strong>
          </span>
        </div>

        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional touch notes (e.g., 10-pt responsive edge-to-edge, 0 dead strips, or USB external touch tested)"
          className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-2 text-xs text-black"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={touchEventCount === 0}
            onClick={() => handleRecordVerdict("PASS")}
            title={
              touchEventCount === 0
                ? "Requires real finger touch input (pointerType === 'touch') before passing"
                : undefined
            }
            className={`px-4 py-2 rounded-[2px] font-bold text-xs flex items-center gap-1.5 ${
              touchEventCount === 0
                ? "bg-zinc-200 text-zinc-500 border border-zinc-300 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Touchscreen Test
          </button>
          <button
            type="button"
            onClick={() => handleRecordVerdict("WARN")}
            className="px-4 py-2 rounded-[2px] border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 font-bold text-xs cursor-pointer"
          >
            Mark Minor Issue (WARN)
          </button>
          <button
            type="button"
            onClick={() => handleRecordVerdict("FAIL")}
            className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-4 h-4" />
            Fail Touchscreen Test
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Test touch grid & multi-touch, record Pass/Warn/Fail, or click Skip Step on non-touch laptops."
        onNext={onNext}
        onSkip={handleOneClickSkip}
      />
    </div>
  );
};
