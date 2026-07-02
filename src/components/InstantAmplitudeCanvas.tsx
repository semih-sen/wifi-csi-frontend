"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

/** Imperative handle: panels push the LATEST amplitude spectrum; drawing is on rAF. */
export interface InstantAmplitudeHandle {
  /** Replace the current spectrum (length should equal `bins`; extra/missing are clamped). */
  push: (spectrum: ArrayLike<number>) => void;
  /** Drop the current trace (e.g. on RX change). */
  clear: () => void;
}

interface InstantAmplitudeCanvasProps {
  /** Horizontal resolution: number of subcarriers on the x axis (e.g. 64). */
  bins: number;
  /**
   * Display-only EMA smoothing for readability at 10 Hz. OFF by default — raw is the
   * honest diagnostic. This never changes the pushed data, only how it is drawn.
   */
  smooth?: boolean;
  className?: string;
  /** Trace / fill accent as a CSS colour. Defaults to sky-400. */
  color?: string;
}

// EMA weight for the new sample when smoothing is on. ~0.5 = a light one-frame lag at
// 10 Hz: enough to calm jitter, not enough to hide a real transient.
const EMA_ALPHA = 0.5;

/**
 * Instantaneous amplitude view: the LATEST `amplitude[bins]` drawn as a subcarrier
 * (x) vs |CSI| magnitude (y) line + fill. Same payload the heatmap consumes — a
 * different render, not a new data path.
 *
 * Render is decoupled from the ~10 Hz push rate exactly like {@link HeatmapCanvas}:
 * `push()` only mutates a bounded ref and marks dirty; one requestAnimationFrame loop
 * repaints when there is new data. No React re-render per frame, no growth.
 */
export const InstantAmplitudeCanvas = forwardRef<
  InstantAmplitudeHandle,
  InstantAmplitudeCanvasProps
>(function InstantAmplitudeCanvas(
  { bins, smooth = false, className, color = "#38bdf8" },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Latest spectrum + display state, all in refs (never React state per frame).
  const latest = useRef<Float32Array>(new Float32Array(bins)); // raw, as-pushed
  const shown = useRef<Float32Array>(new Float32Array(bins)); // what we draw (raw or EMA)
  const hasData = useRef(false);
  const scaleMax = useRef(1e-6);
  const dirty = useRef(true);
  // Keep the latest `smooth` flag readable from the push callback without re-binding it.
  const smoothRef = useRef(smooth);

  // (Re)allocate when the bin count changes.
  useEffect(() => {
    latest.current = new Float32Array(bins);
    shown.current = new Float32Array(bins);
    hasData.current = false;
    scaleMax.current = 1e-6;
    dirty.current = true;
  }, [bins]);

  // Toggling smoothing re-seeds the display buffer from the raw latest so the trace
  // switches cleanly (no carried-over EMA tail when turning it off).
  useEffect(() => {
    smoothRef.current = smooth;
    shown.current.set(latest.current);
    dirty.current = true;
  }, [smooth]);

  useImperativeHandle(
    ref,
    () => ({
      push: (spectrum) => {
        const raw = latest.current;
        const disp = shown.current;
        const n = Math.min(bins, spectrum.length);
        let colMax = 0;
        const useEma = smoothRef.current && hasData.current;
        for (let i = 0; i < bins; i++) {
          const v = i < n ? spectrum[i] : 0;
          raw[i] = v;
          // EMA is DISPLAY-ONLY: `raw` always holds the untouched amplitude.
          disp[i] = useEma ? disp[i] + EMA_ALPHA * (v - disp[i]) : v;
          if (v > colMax) colMax = v;
        }
        hasData.current = true;
        // Adaptive scale: track a slowly-decaying running max so the trace fills the
        // height without a fixed ceiling (matches HeatmapCanvas' contrast behaviour).
        scaleMax.current = Math.max(scaleMax.current * 0.98, colMax, 1e-6);
        dirty.current = true;
      },
      clear: () => {
        latest.current.fill(0);
        shown.current.fill(0);
        hasData.current = false;
        scaleMax.current = 1e-6;
        dirty.current = true;
      },
    }),
    [bins],
  );

  // ── rAF paint loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match the backing store to the element's CSS box at device resolution so the
    // line stays crisp; re-measure on resize rather than every frame.
    let cssW = 1;
    let cssH = 1;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      if (!dirty.current) return;
      dirty.current = false;

      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);

      // Background.
      ctx.fillStyle = "#020617"; // slate-950, matches the heatmap wells
      ctx.fillRect(0, 0, w, h);

      // Faint horizontal gridlines (25 / 50 / 75 %).
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)"; // slate-400 @ low alpha
      ctx.lineWidth = 1;
      for (let g = 1; g < 4; g++) {
        const y = (h * g) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      if (!hasData.current || bins < 1) return;

      const disp = shown.current;
      const smax = scaleMax.current;
      // Map bin index → x centre, magnitude → y (0 at bottom). Leave a 1px top margin
      // so a full-scale peak isn't clipped at the very edge.
      const xAt = (i: number) =>
        bins === 1 ? w / 2 : (i / (bins - 1)) * w;
      const yAt = (v: number) => {
        const t = v / smax;
        const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
        return h - clamped * (h - 1);
      };

      // Filled area under the trace.
      ctx.beginPath();
      ctx.moveTo(xAt(0), h);
      for (let i = 0; i < bins; i++) ctx.lineTo(xAt(i), yAt(disp[i]));
      ctx.lineTo(xAt(bins - 1), h);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(color, 0.15);
      ctx.fill();

      // Trace line on top.
      ctx.beginPath();
      for (let i = 0; i < bins; i++) {
        const x = xAt(i);
        const y = yAt(disp[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();
    };

    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bins, color]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
});

/** #rrggbb → rgba() with the given alpha (for the translucent area fill). */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex; // already a CSS colour; let the fill be opaque-ish via caller
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
