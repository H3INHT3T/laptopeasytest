import React, { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Mic, Play, Square, Volume2, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface MediaTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

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
      // Wait for permission
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
            g.fillStyle = "#09090b";
            g.fillRect(0, 0, canvas.width, canvas.height);
            g.strokeStyle = "#3b82f6";
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
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Camera &amp; Microphone Test
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Verify live webcam video resolution/FPS, microphone waveform response, and 3-second voice loopback clarity.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-black text-white px-4 py-2.5 text-xs">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-black">
              <Camera className="w-4 h-4 text-blue-600" /> Webcam Preview
            </div>
            {camActive ? (
              <button
                onClick={stopCamera}
                className="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            ) : (
              <button
                onClick={startCamera}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Play className="w-3 h-3" /> Start Camera
              </button>
            )}
          </div>

          <select
            value={selectedCam}
            onChange={(e) => setSelectedCam(e.target.value)}
            className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5 text-xs text-black"
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

          <div className="aspect-video rounded-xl bg-black border border-zinc-300 overflow-hidden flex items-center justify-center">
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
          <div className="text-[11px] font-mono text-zinc-600">{camInfo}</div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-black">
                <Mic className="w-4 h-4 text-blue-600" /> Microphone &amp; Loopback
              </div>
              {micActive ? (
                <button
                  onClick={stopMic}
                  className="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Square className="w-3 h-3" /> Stop
                </button>
              ) : (
                <button
                  onClick={startMic}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Play className="w-3 h-3" /> Start Mic
                </button>
              )}
            </div>

            <select
              value={selectedMic}
              onChange={(e) => setSelectedMic(e.target.value)}
              className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5 text-xs text-black"
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
              className="w-full h-32 rounded-xl border border-zinc-300 bg-black"
            />

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-zinc-600 font-mono">
                <span>Input Signal Level</span>
                <strong className="text-blue-700">{micLevel}%</strong>
              </div>
              <div className="h-2 rounded-full bg-zinc-200 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all duration-75" style={{ width: `${micLevel}%` }} />
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between gap-2 flex-wrap">
            <button
              onClick={record3SecLoopback}
              disabled={recording}
              className="px-3.5 py-2 rounded-lg border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Volume2 className="w-4 h-4" />
              {recording ? "Recording 3s..." : "Record 3s & Playback"}
            </button>
            {playbackUrl && <audio src={playbackUrl} controls className="h-8 max-w-[220px]" />}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional camera/mic notes (e.g. Sharp image, clear loopback audio, privacy shutter checked)"
          className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict("pass", `Camera (${camInfo !== "Stopped" ? camInfo : "verified"}) & Microphone passed.`, notes)
            }
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" /> Pass Camera &amp; Mic
          </button>
          <button
            onClick={() => onVerdict("fail", "Camera or Microphone defect reported.", notes)}
            className="px-4 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
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
