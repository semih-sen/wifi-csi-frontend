"use client";

import { useEffect, useState } from "react";
import { useRadar } from "@/context/RadarConnectionProvider";

// Fixed activity classes keep the training set consistent (README §7).
// Free text is still allowed via the "Custom…" option.
const LABEL_PRESETS = [
  "EmptyRoom",
  "Walking",
  "Standing",
  "Sitting",
  "LyingOnCouch",
  "Falling",
];

function useElapsed(startedAtUnixMs: number, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  if (!active || !startedAtUnixMs) return "00:00";
  const secs = Math.max(0, Math.floor((now - startedAtUnixMs) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function RecorderPanel() {
  const { recordingStatus, connectionState, startRecording, stopRecording } =
    useRadar();

  const [preset, setPreset] = useState(LABEL_PRESETS[0]);
  const [custom, setCustom] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connectionState === "Connected";
  const isRecording = recordingStatus?.isRecording ?? false;
  const elapsed = useElapsed(recordingStatus?.startedAtUnixMs ?? 0, isRecording);

  const label = preset === "__custom__" ? custom.trim() : preset;
  const dropped = recordingStatus?.framesDropped ?? 0;

  async function handleStart() {
    setError(null);
    setBusy(true);
    try {
      await startRecording(label || "unlabeled", subject.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setError(null);
    setBusy(true);
    try {
      await stopRecording();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Recorder
        </h2>
        {isRecording && (
          <span className="flex items-center gap-2 text-sm font-medium text-rose-300">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
            REC {elapsed}
          </span>
        )}
      </header>

      {/* Label selection */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-400">Activity label</label>
        <select
          value={preset}
          disabled={isRecording}
          onChange={(e) => setPreset(e.target.value)}
          className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
        >
          {LABEL_PRESETS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {preset === "__custom__" && (
          <input
            value={custom}
            disabled={isRecording}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Custom label"
            className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
          />
        )}
      </div>

      {/* Subject — who performed the activity (enables person/gait recognition). */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-400">
          Subject <span className="text-slate-600">(who — optional)</span>
        </label>
        <input
          value={subject}
          disabled={isRecording}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Alice"
          className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
        />
      </div>

      {/* Live counters */}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Frames captured" value={recordingStatus?.framesCaptured ?? 0} />
        <Stat
          label="Frames dropped"
          value={dropped}
          tone={dropped > 0 ? "danger" : "default"}
        />
      </div>

      {dropped > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          ⚠️ {dropped} frame{dropped === 1 ? "" : "s"} dropped — this session is
          flagged incomplete in its manifest. Consider redoing the take.
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-3">
        <button
          onClick={handleStart}
          disabled={!connected || isRecording || busy || !label}
          className="flex-1 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start
        </button>
        <button
          onClick={handleStop}
          disabled={!connected || !isRecording || busy}
          className="flex-1 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Stop
        </button>
      </div>

      {!connected && (
        <p className="text-xs text-amber-300/80">
          Controls disabled until the hub connection is live.
        </p>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {recordingStatus && isRecording && (
        <p className="text-xs text-slate-500">
          Session #{recordingStatus.sessionId} · “{recordingStatus.label}”
          {recordingStatus.subject && ` · ${recordingStatus.subject}`}
        </p>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-800/50 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div
        className={`mt-0.5 text-2xl font-semibold tabular-nums ${
          tone === "danger" ? "text-rose-300" : "text-slate-100"
        }`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
