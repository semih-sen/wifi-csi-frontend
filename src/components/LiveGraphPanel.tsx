"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useRadar } from "@/context/RadarConnectionProvider";
import { type CsiFrame, HubEvent } from "@/lib/types";

// Rolling time-view window. At ~2 Hz, 600 points ≈ 5 minutes — bounded so a
// long-running session never grows an unbounded array (README §6).
const MAX_TIME_POINTS = 600;

const AXIS_STROKE = "#64748b";
const GRID_STROKE = "rgba(148,163,184,0.12)";

function baseOpts(): Partial<uPlot.Options> {
  return {
    padding: [12, 12, 4, 4],
    axes: [
      {
        stroke: AXIS_STROKE,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE },
        font: "11px ui-sans-serif, system-ui",
      },
      {
        stroke: AXIS_STROKE,
        grid: { stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE },
        font: "11px ui-sans-serif, system-ui",
      },
    ],
    legend: { show: false },
    cursor: { show: false },
  };
}

export function LiveGraphPanel() {
  const { on, mockActive, connectionState } = useRadar();

  const spectrumRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLDivElement | null>(null);
  const spectrumPlot = useRef<uPlot | null>(null);
  const timePlot = useRef<uPlot | null>(null);

  // Incoming data lands in refs; the rAF loop reads them — never React state
  // per event (README §6: decouple render from event rate).
  const latestFrame = useRef<CsiFrame | null>(null);
  const dirty = useRef(false);
  const timeXs = useRef<number[]>([]);
  const timeYs = useRef<number[]>([]);
  const subcarrierRef = useRef(0);

  const [selectedSub, setSelectedSub] = useState(0);
  const [meta, setMeta] = useState<{ rssi: number; n: number; last: number } | null>(
    null,
  );
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    subcarrierRef.current = selectedSub;
    // Switching subcarrier invalidates the rolling time series.
    timeXs.current = [];
    timeYs.current = [];
  }, [selectedSub]);

  // ── Build charts once ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!spectrumRef.current || !timeRef.current) return;

    const sw = spectrumRef.current.clientWidth || 600;
    const tw = timeRef.current.clientWidth || 600;

    spectrumPlot.current = new uPlot(
      {
        ...baseOpts(),
        width: sw,
        height: 220,
        scales: { x: { time: false } },
        series: [
          {},
          { stroke: "#38bdf8", width: 1.5, fill: "rgba(56,189,248,0.12)" },
        ],
      } as uPlot.Options,
      [[], []],
      spectrumRef.current,
    );

    timePlot.current = new uPlot(
      {
        ...baseOpts(),
        width: tw,
        height: 220,
        scales: { x: { time: false } },
        series: [
          {},
          { stroke: "#a78bfa", width: 1.5 },
        ],
      } as uPlot.Options,
      [[], []],
      timeRef.current,
    );

    const ro = new ResizeObserver(() => {
      if (spectrumRef.current)
        spectrumPlot.current?.setSize({
          width: spectrumRef.current.clientWidth,
          height: 220,
        });
      if (timeRef.current)
        timePlot.current?.setSize({ width: timeRef.current.clientWidth, height: 220 });
    });
    ro.observe(spectrumRef.current);
    ro.observe(timeRef.current);

    return () => {
      ro.disconnect();
      spectrumPlot.current?.destroy();
      timePlot.current?.destroy();
      spectrumPlot.current = null;
      timePlot.current = null;
    };
  }, []);

  // ── Subscribe to the CSI stream ────────────────────────────────────────────
  useEffect(() => {
    const off = on(HubEvent.CsiData, (payload) => {
      const frame = payload as CsiFrame;
      if (!frame?.amplitudes?.length) return;
      latestFrame.current = frame;
      dirty.current = true;

      const idx = Math.min(subcarrierRef.current, frame.amplitudes.length - 1);
      timeXs.current.push(frame.timestampMs / 1000);
      timeYs.current.push(frame.amplitudes[idx]);
      if (timeXs.current.length > MAX_TIME_POINTS) {
        timeXs.current.shift();
        timeYs.current.shift();
      }
    });
    return off;
  }, [on]);

  // ── rAF render loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let metaThrottle = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!dirty.current) return;
      dirty.current = false;

      const frame = latestFrame.current;
      if (!frame) return;

      if (!hasData) setHasData(true);

      // Spectrum: amplitude vs subcarrier index.
      const n = frame.amplitudes.length;
      const xs = Array.from({ length: n }, (_, i) => i);
      spectrumPlot.current?.setData([xs, frame.amplitudes]);

      // Time: rolling buffer of the selected subcarrier.
      timePlot.current?.setData([timeXs.current, timeYs.current]);

      // Cheap metadata, throttled to ~every 10th frame.
      if (++metaThrottle % 10 === 0 || !meta) {
        setMeta({ rssi: frame.rssi, n, last: frame.timestampMs });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subMax = (meta?.n ?? 64) - 1;
  const stale = connectionState !== "Connected" && !mockActive;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Live CSI
        </h2>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          {mockActive && (
            <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-fuchsia-300">
              MOCK
            </span>
          )}
          {meta && (
            <>
              <span>{meta.n} subcarriers</span>
              <span>RSSI {meta.rssi} dBm</span>
            </>
          )}
        </div>
      </header>

      {!hasData && (
        <div className="rounded-lg border border-white/10 bg-slate-800/40 px-3 py-2 text-sm text-slate-400">
          {stale
            ? "Waiting for the hub connection…"
            : "Connected — waiting for CSI frames (no ESP32 streaming?). Set NEXT_PUBLIC_MOCK_CSI=1 to develop without hardware."}
        </div>
      )}

      <div>
        <p className="mb-1 text-xs text-slate-500">Spectrum — amplitude vs subcarrier</p>
        <div ref={spectrumRef} className="w-full" />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Time — subcarrier #{selectedSub}
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            subcarrier
            <input
              type="range"
              min={0}
              max={Math.max(0, subMax)}
              value={selectedSub}
              onChange={(e) => setSelectedSub(Number(e.target.value))}
              className="accent-violet-400"
            />
            <span className="w-8 tabular-nums">{selectedSub}</span>
          </label>
        </div>
        <div ref={timeRef} className="w-full" />
      </div>
    </section>
  );
}
