"use client";

import { useEffect, useState } from "react";
import { useRadar } from "@/context/RadarConnectionProvider";
import type { RecordingKind } from "@/lib/types";

// Activity mode: the pinned activity-model classes (empty/standing/walking/sitting).
// Kept lowercase so the recorded label matches the class vocabulary the model trains on.
const ACTIVITY_CLASSES = ["empty", "standing", "walking", "sitting"] as const;

// Identity mode records gait, so the activity is always "walking" — gait is the only
// identity signal; a sitting/standing person can't be identified.
const IDENTITY_LABEL = "walking";

function useElapsed(startedAtUnixMs: number, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  if (!active || !startedAtUnixMs) return "00:00";
  const secs = Math.max(0, Math.floor((now - startedAtUnixMs) / 1000));
  return fmtMmSs(secs);
}

/** Remaining mm:ss until auto-stop, or null when there is no scheduled stop. */
function useCountdown(stopAtUnixMs: number, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !stopAtUnixMs) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active, stopAtUnixMs]);
  if (!active || !stopAtUnixMs) return null;
  return fmtMmSs(Math.max(0, Math.ceil((stopAtUnixMs - now) / 1000)));
}

function fmtMmSs(secs: number): string {
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Quick-pick durations (seconds). 0 = manual / open-ended. */
const DURATION_PRESETS = [0, 30, 60, 120] as const;

export function RecorderPanel() {
  const {
    recordingStatus,
    connectionState,
    startRecording,
    stopRecording,
    calibration,
    calibrate,
    calibrationError,
    hasLiveData,
  } = useRadar();

  const [mode, setMode] = useState<RecordingKind>("activity");
  const [activityClass, setActivityClass] = useState<string>(ACTIVITY_CLASSES[1]);
  const [subject, setSubject] = useState("");
  const [durationSec, setDurationSec] = useState("");
  const [busy, setBusy] = useState(false);
  const [calBusy, setCalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connectionState === "Connected";
  const isRecording = recordingStatus?.isRecording ?? false;
  const elapsed = useElapsed(recordingStatus?.startedAtUnixMs ?? 0, isRecording);
  const remaining = useCountdown(recordingStatus?.stopAtUnixMs ?? 0, isRecording);

  // Identity locks the activity to "walking"; activity mode uses the class selector.
  const label = mode === "identity" ? IDENTITY_LABEL : activityClass;
  const trimmedSubject = subject.trim();
  const subjectRequired = mode === "identity";
  const dropped = recordingStatus?.framesDropped ?? 0;

  // Parse the duration field: blank/0/invalid → manual (open-ended).
  const durSec = parseInt(durationSec, 10);
  const durationMs = Number.isFinite(durSec) && durSec > 0 ? durSec * 1000 : 0;

  // Recording nothing is worse than not recording: block Start unless CSI is flowing.
  const canStart =
    connected &&
    !isRecording &&
    !busy &&
    hasLiveData &&
    !calibration.isCalibrating &&
    !!label &&
    (!subjectRequired || trimmedSubject.length > 0);

  async function handleStart() {
    setError(null);
    setBusy(true);
    try {
      await startRecording(mode, label, trimmedSubject, durationMs);
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

  async function handleCalibrate() {
    setCalBusy(true);
    try {
      await calibrate();
    } catch {
      // calibrate() surfaces failures via calibrationError / the timeout.
    } finally {
      setCalBusy(false);
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
            {remaining && (
              <span className="text-slate-400">· ⏱ {remaining} left</span>
            )}
          </span>
        )}
      </header>

      {/* Baseline calibration (tare) — zeroes out the empty-room signature */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-slate-800/40 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">Room baseline</span>
          {calibration.baselineActive ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Baseline: Active
            </span>
          ) : (
            <span className="text-xs text-slate-500">Not calibrated</span>
          )}
        </div>
        <button
          onClick={handleCalibrate}
          disabled={
            !connected ||
            isRecording ||
            calibration.isCalibrating ||
            calBusy ||
            !hasLiveData
          }
          className="rounded-lg border border-white/10 bg-slate-700/60 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {calibration.isCalibrating ? "Calibrating…" : "Calibrate Room"}
        </button>
        {calibration.isCalibrating && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            ⚠️ Calibrating… Please leave the room or remain completely still for ~5
            seconds.
          </div>
        )}
        {connected && !hasLiveData && !calibration.isCalibrating && (
          <p className="text-xs text-amber-300/80">
            No live CSI data — start the sensor (ESP32 streaming to the broker)
            before calibrating.
          </p>
        )}
        {calibrationError && (
          <p className="text-xs text-rose-300">{calibrationError}</p>
        )}
      </div>

      {/* Mode toggle — activity dataset vs identity (gait) dataset */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-400">Recording mode</label>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-slate-800/60 p-1">
          {(["activity", "identity"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={isRecording}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === m
                  ? "bg-sky-500/20 text-sky-200"
                  : "text-slate-400 hover:bg-slate-700/60"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {mode === "activity"
            ? "Empty / standing / walking / sitting — the always-on activity model."
            : "Gait identity — activity is locked to walking; a subject (person) is required."}
        </p>
      </div>

      {/* Activity class (activity mode only) */}
      {mode === "activity" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-slate-400">Activity class</label>
          <select
            value={activityClass}
            disabled={isRecording}
            onChange={(e) => setActivityClass(e.target.value)}
            className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm capitalize text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
          >
            {ACTIVITY_CLASSES.map((c) => (
              <option key={c} value={c} className="capitalize">
                {c}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Subject — optional for activity, REQUIRED for identity */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-400">
          Subject{" "}
          {subjectRequired ? (
            <span className="text-rose-400">(person — required)</span>
          ) : (
            <span className="text-slate-600">(who — optional)</span>
          )}
        </label>
        <input
          value={subject}
          disabled={isRecording}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Alice"
          className={`rounded-lg border bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50 ${
            subjectRequired && trimmedSubject.length === 0
              ? "border-rose-500/40"
              : "border-white/10"
          }`}
        />
        {mode === "identity" && (
          <p className="text-xs text-slate-500">
            Recording as{" "}
            <span className="text-slate-300">walking</span> gait for this person.
          </p>
        )}
      </div>

      {/* Auto-stop duration — enforced server-side so it stops even if this tab is gone. */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-400">
          Auto-stop after{" "}
          <span className="text-slate-600">(seconds — 0 / blank = manual)</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={durationSec}
            disabled={isRecording}
            onChange={(e) => setDurationSec(e.target.value)}
            placeholder="0"
            className="w-24 rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-1.5">
            {DURATION_PRESETS.map((s) => {
              const selected = durationMs === s * 1000;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={isRecording}
                  onClick={() => setDurationSec(s === 0 ? "" : String(s))}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
                    selected
                      ? "bg-sky-500/20 text-sky-300"
                      : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                  }`}
                >
                  {s === 0 ? "Manual" : `${s}s`}
                </button>
              );
            })}
          </div>
        </div>
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
          ⚠️ {dropped} frame{dropped === 1 ? "" : "s"} dropped — this session is{" "}
          <strong>not ML-grade</strong> (backpressure / RX dropout during capture).
          Re-record the take.
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-3">
        <button
          onClick={handleStart}
          disabled={!canStart}
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
      {connected && !hasLiveData && !isRecording && (
        <p className="text-xs text-amber-300/80">
          No CSI is reaching the server — start the sensor (ESP32) streaming before
          recording. Recording nothing is worse than not recording.
        </p>
      )}
      {connected &&
        hasLiveData &&
        subjectRequired &&
        trimmedSubject.length === 0 &&
        !isRecording && (
          <p className="text-xs text-amber-300/80">
            Identity recording needs a subject (person) — data with no person label is
            useless.
          </p>
        )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {recordingStatus && isRecording && (
        <p className="text-xs text-slate-500">
          Session #{recordingStatus.sessionId} ·{" "}
          <span className="uppercase">{recordingStatus.kind || mode}</span> · “
          {recordingStatus.label}”
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
