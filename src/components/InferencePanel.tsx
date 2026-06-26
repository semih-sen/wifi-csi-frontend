"use client";

import { useEffect, useState } from "react";
import { useRadar } from "@/context/RadarConnectionProvider";
import { type InferenceResult, type StatusEvent, HubEvent } from "@/lib/types";

export function InferencePanel() {
  const { on } = useRadar();
  const [inference, setInference] = useState<InferenceResult | null>(null);
  const [status, setStatus] = useState<StatusEvent | null>(null);

  useEffect(() => {
    const offInf = on(HubEvent.Inference, (p) =>
      setInference(p as InferenceResult),
    );
    // ⚠️ PascalCase payload, unlike every other event (README §2.2).
    const offStatus = on(HubEvent.Status, (p) => setStatus(p as StatusEvent));
    return () => {
      offInf();
      offStatus();
    };
  }, [on]);

  const scores = inference
    ? Object.entries(inference.scores).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Inference
        </h2>
        {status && (
          <span className="text-xs text-slate-400">{status.Status}</span>
        )}
      </header>

      {!inference ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 bg-slate-800/30 px-4 py-8 text-center">
          <span className="text-2xl opacity-40">🧠</span>
          <p className="text-sm font-medium text-slate-300">Model not yet active</p>
          <p className="max-w-xs text-xs text-slate-500">
            Live classification arrives in Phase 4 once the ONNX model and
            debounce state machine are wired on the backend.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-xs text-slate-400">Predicted</div>
            <div className="text-2xl font-semibold text-slate-100">
              {inference.predictedLabel}
            </div>
            <ConfidenceBar value={inference.confidence} />
          </div>
          <div className="flex flex-col gap-1.5">
            {scores.map(([label, score]) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-slate-400">{label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${Math.round(score * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right tabular-nums text-slate-400">
                  {(score * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-400">{pct}%</span>
    </div>
  );
}
