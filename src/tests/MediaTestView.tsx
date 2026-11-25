import React, { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Mic, Play, Square, Volume2, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface MediaTestViewProps {
  status: TestStatus;
  notes: string;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext?: () => void;
}

export const MediaTestView: React.FC<MediaTestViewProps> = ({
  status,
  notes: initialNotes,
  onVerdict,
  onNext,
}) => {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState("");
  const [selectedMic, setSelectedMic] = useState("");
  const [camActive, setCamActive] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [camInfo, setCamInfo] = useState("Stopped");
  const [micLevel, setMicLevel] = useState(0);
  const [recording, setRecording] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(initialNotes);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

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
      // Enumerate may wait for permission
    }
  };

  useEffect(() => {
    refreshDevices();
    return () => {
      stopCamera();
      stopMic();
    };
  }, []);

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
      setCamInfo(
        `${settings.width ?? "?"}x${settings.height ?? "?"} @ ${Math.round(settings.frameRate ?? 30)} FPS (${track.label || "Webcam"})`
      );
      setCamActive(true);
      refreshDevices();
    } catch (e) {
      setError(`Camera access failed: ${String(e)}`);
    }
  };

  const stopCamera = () => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamActive(false);
    setCamInfo("Stopped");
  };

  const startMic = async () => {
    setError(null);
    stopMic();
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
      analyser.fftSize = 1024;
      src.connect(analyser);

      const data = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(100, Math.round(rms * 280)));

        const canvas = waveCanvasRef.current;
        if (canvas) {
          const g = canvas.getContext("2d");
          if (g) {
            g.fillStyle = "#020617";
            g.fillRect(0, 0, canvas.width, canvas.height);
            g.strokeStyle = "#22d3ee";
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
    if (!micStreamRef.current) {
      await startMic();
    }
    const stream = micStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") {
      setError("Audio recorder unavailable.");
      return;
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
      setPlaybackUrl(url);
      setRecording(false);
      new Audio(url).play().catch(() => {});
    };
    rec.start();
    setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, 3000);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Camera &amp; Microphone Test</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Verify live webcam feed, resolution/FPS, microphone waveform sensitivity, and 3-second voice loopback clarity.
          </p>
        </div>
        {onNext && (
          <button
            onClick={onNext}
            className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
          >
            Next Test →
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-rose-500/15 border border-rose-500/40 px-4 py-2.5 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Camera Panel */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <Camera className="w-4 h-4 text-cyan-400" />
              Webcam Preview
            </div>
            {camActive ? (
              <button
                onClick={stopCamera}
                className="px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-semibold flex items-center gap-1"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            ) : (
              <button
                onClick={startCamera}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1"
              >
                <Play className="w-3 h-3" /> Start Camera
              </button>
            )}
          </div>

          <select
            value={selectedCam}
            onChange={(e) => setSelectedCam(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
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

          <div className="aspect-video rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center relative">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${camActive ? "block" : "hidden"}`}
            />
            {!camActive && (
              <div className="text-xs text-slate-500 flex flex-col items-center gap-2">
                <Camera className="w-8 h-8 opacity-40" />
                <span>Click Start Camera to inspect video feed</span>
              </div>
            )}
          </div>
          <div className="text-[11px] font-mono text-slate-400">{camInfo}</div>
        </div>

        {/* Microphone Panel */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <Mic className="w-4 h-4 text-emerald-400" />
                Microphone &amp; Loopback
              </div>
              {micActive ? (
                <button
                  onClick={stopMic}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-semibold flex items-center gap-1"
                >
                  <Square className="w-3 h-3" /> Stop
                </button>
              ) : (
                <button
                  onClick={startMic}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1"
                >
                  <Play className="w-3 h-3" /> Start Mic
                </button>
              )}
            </div>

            <select
              value={selectedMic}
              onChange={(e) => setSelectedMic(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
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
              className="w-full h-32 rounded-xl border border-slate-800 bg-slate-950"
            />

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Input Signal Level</span>
                <span>{micLevel}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-950 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 via-cyan-400 to-amber-400 transition-all duration-75"
                  style={{ width: `${micLevel}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between gap-2 flex-wrap">
            <button
              onClick={record3SecLoopback}
              disabled={recording}
              className="px-3.5 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center gap-1.5"
            >
              <Volume2 className="w-4 h-4" />
              {recording ? "Recording 3s..." : "Record 3s & Playback"}
            </button>
            {playbackUrl && (
              <audio src={playbackUrl} controls className="h-8 max-w-[220px]" />
            )}
          </div>
        </div>
      </div>

      {/* Verdict */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional camera/mic notes (e.g. Sharp image, clear voice playback, no privacy shutter issue)"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict("pass", `Camera (${camInfo !== "Stopped" ? camInfo : "verified"}) & Microphone loopback passed.`, notes)
            }
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" /> Pass Camera &amp; Mic
          </button>
          <button
            onClick={() => onVerdict("fail", "Camera or Microphone defect reported.", notes)}
            className="px-4 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center gap-1.5"
          >
            <XCircle className="w-4 h-4" /> Fail Camera / Mic
          </button>
        </div>
      </div>
    </div>
  );
};
