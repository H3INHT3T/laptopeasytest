import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, Mic, Play, RotateCcw, Square, Volume2, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface MediaTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: { presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export const MediaTestView: React.FC<MediaTestViewProps> = ({
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState("");
  const [selectedMic, setSelectedMic] = useState("");
  const [camActive, setCamActive] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [camInfo, setCamInfo] = useState("Stopped");

  // Webcam telemetry
  const [camResText, setCamResText] = useState("—");
  const [targetFps, setTargetFps] = useState<number>(30);
  const [actualFps, setActualFps] = useState<number | null>(null);
  const [droppedFrames, setDroppedFrames] = useState<number>(0);
  const [frameStabilityPct, setFrameStabilityPct] = useState<number | null>(null);
  const [meanLuma, setMeanLuma] = useState<number | null>(null);
  const [sharpnessScore, setSharpnessScore] = useState<number | null>(null);

  // Mic telemetry
  const [micLevel, setMicLevel] = useState(0);
  const [noiseFloorDb, setNoiseFloorDb] = useState<number | null>(null);
  const [peakSpeechDb, setPeakSpeechDb] = useState<number | null>(null);
  const [clipCount, setClipCount] = useState<number>(0);
  const [micNoSignal, setMicNoSignal] = useState<boolean>(false);

  const [recording, setRecording] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(initialNotes);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const camMonitorHandleRef = useRef<number>(0);
  const camMonitorModeRef = useRef<"vfc" | "raf" | null>(null);
  const camActiveRef = useRef<boolean>(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const playbackUrlRef = useRef<string | null>(null);

  // Acoustic tracking refs
  const dbSamplesRef = useRef<number[]>([]);
  const minDbRef = useRef<number | null>(null);
  const maxDbRef = useRef<number | null>(null);
  const maxPeakAbsRef = useRef<number>(0);
  const micStartTsRef = useRef<number>(0);
  const lastClipTsRef = useRef<number>(0);

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const audios = devices.filter((d) => d.kind === "audioinput");
      setCameras(cams);
      setMics(audios);
      if (!selectedCam && cams[0]) setSelectedCam(cams[0].deviceId);
      if (!selectedMic && audios[0]) setSelectedMic(audios[0].deviceId);
    } catch {
      // Wait for permission
    }
  };

  useEffect(() => {
    refreshDevices();
    return () => {
      stopCamera();
      stopMic();
      if (recTimerRef.current !== null) {
        window.clearTimeout(recTimerRef.current);
        recTimerRef.current = null;
      }
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
        playbackUrlRef.current = null;
      }
    };
  }, []);

  const analyzeVideoFrame = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;
    if (!offscreenCanvasRef.current) {
      const c = document.createElement("canvas");
      c.width = 96;
      c.height = 54;
      offscreenCanvasRef.current = c;
    }
    const canvas = offscreenCanvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const w = canvas.width;
    const h = canvas.height;
    const lumas = new Float32Array(w * h);
    let sumLuma = 0;
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const l = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
      lumas[p] = l;
      sumLuma += l;
    }
    const avgLuma = sumLuma / (w * h);

    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const idx = y * w + x;
        edgeSum += Math.abs(lumas[idx] - lumas[idx + 1]) + Math.abs(lumas[idx] - lumas[idx + w]);
        edgeCount += 2;
      }
    }
    const edgeEnergy = edgeCount > 0 ? edgeSum / edgeCount : 0;
    setMeanLuma(Math.round(avgLuma));
    setSharpnessScore(Math.round(edgeEnergy * 10) / 10);
  };

  const stopCamera = () => {
    camActiveRef.current = false;
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (camMonitorHandleRef.current) {
      if (camMonitorModeRef.current === "vfc" && video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(camMonitorHandleRef.current);
      } else if (camMonitorModeRef.current === "raf") {
        cancelAnimationFrame(camMonitorHandleRef.current);
      }
      camMonitorHandleRef.current = 0;
      camMonitorModeRef.current = null;
    }
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamActive(false);
    setCamInfo("Stopped");
  };

  const startCamera = async () => {
    setError(null);
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedCam ? { deviceId: { exact: selectedCam }, width: { ideal: 1280 } } : true,
      });
      camStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const nominalFps = Math.max(15, Math.round(settings.frameRate ?? 30));
      setTargetFps(nominalFps);
      setCamResText(`${settings.width ?? "?"}×${settings.height ?? "?"}`);
      setCamInfo(
        `${settings.width ?? "?"}x${settings.height ?? "?"} @ ${nominalFps} FPS (${track.label || "Webcam"})`
      );
      setDroppedFrames(0);
      setActualFps(null);
      setFrameStabilityPct(null);
      setMeanLuma(null);
      setSharpnessScore(null);
      setCamActive(true);
      camActiveRef.current = true;
      refreshDevices();

      const videoEl = videoRef.current as VideoWithFrameCallback | null;
      if (videoEl) {
        let lastFrameTs = performance.now();
        let lastSampleTs = 0;
        let lastVideoTime = -1;
        const frameDeltas: number[] = [];
        const expectedGapMs = 1000 / nominalFps;

        const onNewFrame = (now: number) => {
          if (!camActiveRef.current) return;
          const dt = now - lastFrameTs;
          lastFrameTs = now;
          if (dt > 0 && dt < 2000) {
            frameDeltas.push(dt);
            if (frameDeltas.length > 30) frameDeltas.shift();
            if (dt > expectedGapMs * 1.75) {
              setDroppedFrames((d) => d + Math.max(1, Math.floor(dt / expectedGapMs) - 1));
            }
            const avgDt = frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length;
            const fps = avgDt > 0 ? Math.round((1000 / avgDt) * 10) / 10 : nominalFps;
            setActualFps(fps);
            const stab = Math.max(0, Math.min(100, Math.round((fps / nominalFps) * 100)));
            setFrameStabilityPct(stab);
          }
          if (now - lastSampleTs >= 500) {
            lastSampleTs = now;
            analyzeVideoFrame();
          }
        };

        if (typeof videoEl.requestVideoFrameCallback === "function") {
          camMonitorModeRef.current = "vfc";
          const tickVfc = (now: number) => {
            if (!camActiveRef.current) return;
            onNewFrame(now);
            camMonitorHandleRef.current = videoEl.requestVideoFrameCallback!(tickVfc);
          };
          camMonitorHandleRef.current = videoEl.requestVideoFrameCallback(tickVfc);
        } else {
          camMonitorModeRef.current = "raf";
          const tickRaf = (now: number) => {
            if (!camActiveRef.current) return;
            if (videoEl.currentTime !== lastVideoTime) {
              lastVideoTime = videoEl.currentTime;
              onNewFrame(now);
            }
            camMonitorHandleRef.current = requestAnimationFrame(tickRaf);
          };
          camMonitorHandleRef.current = requestAnimationFrame(tickRaf);
        }
      }
    } catch (e) {
      setError(`Camera access failed: ${String(e)}`);
    }
  };

  const resetNoiseFloor = () => {
    dbSamplesRef.current = [];
    minDbRef.current = null;
    maxDbRef.current = null;
    maxPeakAbsRef.current = 0;
    micStartTsRef.current = performance.now();
    setNoiseFloorDb(null);
    setPeakSpeechDb(null);
    setClipCount(0);
    setMicNoSignal(false);
  };

  const startMic = async () => {
    setError(null);
    stopMic();
    resetNoiseFloor();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
      });
      micStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);

      const data = new Uint8Array(analyser.fftSize);
      micStartTsRef.current = performance.now();

      const draw = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        let peakAbs = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          const absV = Math.abs(v);
          if (absV > peakAbs) peakAbs = absV;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const rmsDb = Math.max(-90, 20 * Math.log10(Math.max(rms, 1e-6)));
        const now = performance.now();

        setMicLevel(Math.min(100, Math.round(rms * 280)));
        if (peakAbs > maxPeakAbsRef.current) maxPeakAbsRef.current = peakAbs;

        if (peakAbs >= 0.98 && now - lastClipTsRef.current > 180) {
          lastClipTsRef.current = now;
          setClipCount((c) => c + 1);
        }

        dbSamplesRef.current.push(rmsDb);
        if (dbSamplesRef.current.length > 180) dbSamplesRef.current.shift();
        const sorted = [...dbSamplesRef.current].sort((a, b) => a - b);
        const p10 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];
        if (minDbRef.current === null || p10 < minDbRef.current) {
          minDbRef.current = p10;
        }
        if (maxDbRef.current === null || rmsDb > maxDbRef.current) {
          maxDbRef.current = rmsDb;
        }
        setNoiseFloorDb(Math.round(minDbRef.current * 10) / 10);
        setPeakSpeechDb(Math.round(maxDbRef.current * 10) / 10);

        if (now - micStartTsRef.current > 2000 && maxPeakAbsRef.current < 0.002) {
          setMicNoSignal(true);
        } else if (maxPeakAbsRef.current >= 0.002) {
          setMicNoSignal(false);
        }

        const canvas = waveCanvasRef.current;
        if (canvas) {
          const g = canvas.getContext("2d");
          if (g) {
            g.fillStyle = "#09090b";
            g.fillRect(0, 0, canvas.width, canvas.height);
            g.strokeStyle = "#2563EB";
            g.lineWidth = 2;
            g.beginPath();
            const step = canvas.width / data.length;
            for (let i = 0; i < data.length; i++) {
              const y = (data[i] / 255) * canvas.height;
              if (i === 0) g.moveTo(0, y);
              else g.lineTo(i * step, y);
            }
            g.stroke();
          }
        }
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
      setMicActive(true);
      refreshDevices();
    } catch (e) {
      setError(`Microphone access failed: ${String(e)}`);
    }
  };

  const stopMic = () => {
    cancelAnimationFrame(rafRef.current);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setMicActive(false);
    setMicLevel(0);
  };

  const record3SecLoopback = async () => {
    if (!micStreamRef.current) await startMic();
    const stream = micStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") {
      setError("Audio recorder unavailable.");
      return;
    }
    if (recTimerRef.current !== null) {
      window.clearTimeout(recTimerRef.current);
      recTimerRef.current = null;
    }
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
    setPlaybackUrl(null);
    setRecording(true);
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      playbackUrlRef.current = url;
      setPlaybackUrl(url);
      setRecording(false);
      new Audio(url).play().catch(() => {});
    };
    rec.start();
    recTimerRef.current = window.setTimeout(() => {
      recTimerRef.current = null;
      if (rec.state === "recording") rec.stop();
    }, 3000);
  };

  const snrDb =
    noiseFloorDb != null && peakSpeechDb != null
      ? Math.max(0, Math.round((peakSpeechDb - noiseFloorDb) * 10) / 10)
      : null;

  const snrLabel = micNoSignal
    ? "No Signal / Mic Muted"
    : snrDb == null
    ? "Waiting for Mic"
    : snrDb >= 20
    ? "Clean Signal"
    : snrDb >= 10
    ? "Moderate Ambient Noise"
    : "High Noise Floor / Static";

  const darkLens = meanLuma != null && meanLuma < 8;
  const focusRating =
    sharpnessScore == null
      ? "—"
      : darkLens
      ? "Blocked / Dark"
      : sharpnessScore >= 6
      ? "Sharp"
      : "Soft / Low Contrast";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-xs font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Camera &amp; Microphone Test
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Verifies live webcam FPS stability, dropped frames, shutter/focus contrast, microphone noise floor &amp; SNR, clipping, and 3-second loopback audio.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-[2px] bg-black text-white px-4 py-2.5 text-xs">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Webcam Card */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-black">
              <Camera className="w-4 h-4 text-blue-600" /> Webcam Preview &amp; Stability
            </div>
            {camActive ? (
              <button
                onClick={stopCamera}
                className="px-3 py-1.5 rounded-[2px] bg-black text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            ) : (
              <button
                onClick={startCamera}
                className="px-3 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Play className="w-3 h-3" /> Start Camera
              </button>
            )}
          </div>

          <select
            value={selectedCam}
            onChange={(e) => setSelectedCam(e.target.value)}
            className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 text-xs text-black"
          >
            {cameras.length === 0 ? (
              <option value="">Default Webcam</option>
            ) : (
              cameras.map((c, i) => (
                <option key={c.deviceId || i} value={c.deviceId}>
                  {c.label || `Camera ${i + 1}`}
                </option>
              ))
            )}
          </select>

          <div className="aspect-video rounded-[2px] bg-black border border-zinc-300 overflow-hidden flex items-center justify-center">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${camActive ? "block" : "hidden"}`}
            />
            {!camActive && (
              <div className="text-xs text-zinc-400 flex flex-col items-center gap-2">
                <Camera className="w-8 h-8 opacity-40" />
                <span>Click Start Camera to inspect live video</span>
              </div>
            )}
          </div>

          {darkLens && camActive && (
            <div className="rounded-[2px] bg-black text-white px-3 py-2 text-xs font-mono flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Dark/Blocked Feed (Luma {meanLuma}) — check privacy shutter or lens cover.</span>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 border border-zinc-300 rounded-[2px] divide-x divide-y sm:divide-y-0 divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-xs">
            <div className="p-2">
              <div className="text-[9px] uppercase text-zinc-500">Resolution</div>
              <div className="font-black text-black mt-0.5">{camResText}</div>
            </div>
            <div className="p-2">
              <div className="text-[9px] uppercase text-zinc-500">Delivered FPS</div>
              <div className="font-black text-blue-700 mt-0.5">
                {actualFps != null ? `${actualFps} / ${targetFps}` : "—"}
              </div>
            </div>
            <div className="p-2">
              <div className="text-[9px] uppercase text-zinc-500">Drops / Stab</div>
              <div className={`font-black mt-0.5 ${droppedFrames > 5 ? "text-black underline" : "text-black"}`}>
                {camActive ? `${droppedFrames} (${frameStabilityPct ?? 100}%)` : "—"}
              </div>
            </div>
            <div className="p-2">
              <div className="text-[9px] uppercase text-zinc-500">Luma / Focus</div>
              <div className="font-black text-black mt-0.5 truncate" title={`Luma ${meanLuma ?? "—"}, Edge ${sharpnessScore ?? "—"}`}>
                {meanLuma != null ? `${meanLuma} / ${focusRating}` : "—"}
              </div>
            </div>
          </div>

          <div className="text-[11px] font-mono text-zinc-600">{camInfo}</div>
        </div>

        {/* Microphone Card */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 space-y-3 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-black">
                <Mic className="w-4 h-4 text-blue-600" /> Microphone, SNR &amp; Loopback
              </div>
              <div className="flex items-center gap-1.5">
                {micActive && (
                  <button
                    onClick={resetNoiseFloor}
                    className="px-2.5 py-1.5 rounded-[2px] border border-zinc-300 bg-white hover:border-black text-black text-[11px] font-mono font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset Floor
                  </button>
                )}
                {micActive ? (
                  <button
                    onClick={stopMic}
                    className="px-3 py-1.5 rounded-[2px] bg-black text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <Square className="w-3 h-3" /> Stop
                  </button>
                ) : (
                  <button
                    onClick={startMic}
                    className="px-3 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <Play className="w-3 h-3" /> Start Mic
                  </button>
                )}
              </div>
            </div>

            <select
              value={selectedMic}
              onChange={(e) => setSelectedMic(e.target.value)}
              className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 text-xs text-black"
            >
              {mics.length === 0 ? (
                <option value="">Default Microphone</option>
              ) : (
                mics.map((m, i) => (
                  <option key={m.deviceId || i} value={m.deviceId}>
                    {m.label || `Microphone ${i + 1}`}
                  </option>
                ))
              )}
            </select>

            <canvas
              ref={waveCanvasRef}
              width={520}
              height={120}
              className="w-full h-32 rounded-[2px] border border-zinc-300 bg-black"
            />

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-zinc-600 font-mono">
                <span>Input Signal Level ({snrLabel})</span>
                <strong className="text-blue-700">{micLevel}%</strong>
              </div>
              <div className="h-2 rounded-[2px] bg-zinc-200 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all duration-75" style={{ width: `${micLevel}%` }} />
              </div>
            </div>

            {micNoSignal && micActive && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 text-xs font-mono flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                <span>No Signal / Mic Muted — check hardware mute switch or OS privacy permissions.</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 border border-zinc-300 rounded-[2px] divide-x divide-y sm:divide-y-0 divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums text-xs">
              <div className="p-2">
                <div className="text-[9px] uppercase text-zinc-500">Noise Floor</div>
                <div className="font-black text-black mt-0.5">
                  {noiseFloorDb != null ? `${noiseFloorDb} dBFS` : "—"}
                </div>
              </div>
              <div className="p-2">
                <div className="text-[9px] uppercase text-zinc-500">Peak Speech</div>
                <div className="font-black text-black mt-0.5">
                  {peakSpeechDb != null ? `${peakSpeechDb} dBFS` : "—"}
                </div>
              </div>
              <div className="p-2">
                <div className="text-[9px] uppercase text-zinc-500">Est. SNR</div>
                <div className={`font-black mt-0.5 ${(snrDb ?? 0) >= 20 ? "text-blue-700" : "text-black"}`}>
                  {snrDb != null ? `${snrDb} dB` : "—"}
                </div>
              </div>
              <div className="p-2">
                <div className="text-[9px] uppercase text-zinc-500">Clipping</div>
                <div className={`font-black mt-0.5 ${clipCount > 0 ? "text-black underline" : "text-blue-700"}`}>
                  {clipCount} events
                </div>
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between gap-2 flex-wrap">
            <button
              onClick={record3SecLoopback}
              disabled={recording}
              className="px-3.5 py-2 rounded-[2px] border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Volume2 className="w-4 h-4" />
              {recording ? "Recording 3s..." : "Record 3s & Playback"}
            </button>
            {playbackUrl && <audio src={playbackUrl} controls className="h-8 max-w-[220px]" />}
          </div>
        </div>
      </div>

      {/* Plain-Language Buyer Summary */}
      <TechnicalDetailsDrawer
        title="Optics & Acoustic Buyer Summary"
        summary={snrDb != null ? `Focus: ${focusRating} • Mic SNR: ${snrDb} dB` : `Focus: ${focusRating} • ${snrLabel}`}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px]">
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Webcam Stream &amp; Optics</div>
            <div className="text-zinc-600 mt-0.5">
              {camActive
                ? `${camResText} delivering ${actualFps ?? targetFps} FPS (${frameStabilityPct ?? 100}% stability, ${droppedFrames} drops). Focus contrast: ${focusRating}.`
                : camInfo !== "Stopped"
                ? `Last camera session: ${camInfo}.`
                : "Start the camera preview to verify smooth video frames, autofocus sharpness, and open privacy shutter."}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-2.5">
            <div className="font-mono text-[10px] font-bold uppercase text-black">Microphone Clarity &amp; SNR</div>
            <div className="text-zinc-600 mt-0.5">
              {snrDb != null
                ? `${snrLabel} (${snrDb} dB SNR, floor ${noiseFloorDb} dBFS, ${clipCount} clipping events) — ${snrDb >= 20 ? "clear voice calls without static." : "check ambient noise or mic gain."}`
                : "Start the microphone and speak briefly to measure noise floor, speech SNR, and clipping."}
            </div>
          </div>
        </div>
      </TechnicalDetailsDrawer>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional camera/mic notes (e.g. Sharp image, clear loopback audio, privacy shutter checked)"
          className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict(
                "pass",
                `Camera (${camInfo !== "Stopped" ? camInfo : "verified"}, ${actualFps ?? targetFps}fps/${droppedFrames} drops, focus ${focusRating}) & Mic (SNR ${snrDb != null ? `${snrDb}dB` : "verified"}, floor ${noiseFloorDb ?? "N/A"}dBFS, clips ${clipCount}) passed.`,
                notes
              )
            }
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" /> Pass Camera &amp; Mic
          </button>
          <button
            onClick={() =>
              onVerdict(
                "fail",
                `Camera or Microphone defect reported (Cam: ${camInfo}, Mic SNR: ${snrDb ?? "N/A"}dB, Clips: ${clipCount}).`,
                notes
              )
            }
            className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-4 h-4" /> Fail Camera / Mic
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Test camera & microphone and click Pass or Fail to continue (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
