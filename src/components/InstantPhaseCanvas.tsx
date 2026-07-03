"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

/** Imperative handle: panels push the LATEST phase spectrum; drawing is on rAF. */
export interface InstantPhaseHandle {
  /** Replace the current spectrum (length should equal `bins`; extra/missing are clamped). */
  push: (spectrum: ArrayLike<number>) => void;
  /** Drop the current trace (e.g. on RX change). */
  clear: () => void;
}

interface InstantPhaseCanvasProps {
  /** Horizontal resolution: number of subcarriers on the x axis (e.g. 64). */
  bins: number;
  className?: string;
  /** Trace accent as a CSS colour. Defaults to amber-500 (distinct from amplitude/Doppler). */
  color?: string;
}

// Minimum half-range for the symmetric axis, in radians. Sanitized phase is detrended and
// near-zero, so without a floor the axis would stretch noise to full height. 0.2 rad keeps
// a quiet trace visually small instead of exploding it.
const HALF_RANGE_FLOOR = 0.2;

/**
 * Instantaneous sanitized-phase view: the LATEST `phase[bins]` drawn as a subcarrier (x)
 * vs signed phase (y) line, on a ZERO-CENTERED symmetric axis — 0 rad sits on the
 * horizontal midline and the trace swings above/below it.
 *
 * Deliberately NOT a clone of {@link InstantAmplitudeCanvas}'s adaptive `scaleMax` over raw
 * values: phase is signed and relative, so we track a slowly-decaying running `max(|value|)`
 * as the half-range instead. Render is decoupled from the ~10 Hz push rate: `push()` only
 * mutates a bounded ref and marks dirty; one requestAnimationFrame loop repaints. No React
 * re-render per frame, no growth.
 */
export const InstantPhaseCanvas = forwardRef<
  InstantPhaseHandle,
  InstantPhaseCanvasProps
>(function InstantPhaseCanvas(
  { bins, className, color = "#f59e0b" },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Latest spectrum + display state, all in refs (never React state per frame).
  const latest = useRef<Float32Array>(new Float32Array(bins));
  const hasData = useRef(false);
  // Symmetric half-range: max(|value|) with a slow decay, floored so quiet phase stays small.
  const halfRange = useRef(HALF_RANGE_FLOOR);
  const dirty = useRef(true);

  // (Re)allocate when the bin count changes.
  useEffect(() => {
    latest.current = new Float32Array(bins);
    hasData.current = false;
    halfRange.current = HALF_RANGE_FLOOR;
    dirty.current = true;
  }, [bins]);

  useImperativeHandle(
    ref,
    () => ({
      push: (spectrum) => {
        // Empty input (older backend without `phase`) → no-op; panel stays blank.
        if (spectrum.length === 0) return;
        const raw = latest.current;
        const n = Math.min(bins, spectrum.length);
        let colMaxAbs = 0;
        for (let i = 0; i < bins; i++) {
          const v = i < n ? spectrum[i] : 0;
          raw[i] = v;
          const a = v < 0 ? -v : v;
          if (a > colMaxAbs) colMaxAbs = a;
        }
        hasData.current = true;
        // Slow decay toward the current peak, floored — symmetric axis half-range.
        halfRange.current = Math.max(
          halfRange.current * 0.98,
          colMaxAbs,
          HALF_RANGE_FLOOR,
        );
        dirty.current = true;
      },
      clear: () => {
        latest.current.fill(0);
        hasData.current = false;
        halfRange.current = HALF_RANGE_FLOOR;
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

    // Match the backing store to the element's CSS box at device resolution so the line
    // stays crisp; re-measure on resize rather than every frame.
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

    // Top/bottom padding so a peak at ±H doesn't clip against the edge.
    const PAD = 3;

    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      if (!dirty.current) return;
      dirty.current = false;

      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);

      // Background.
      ctx.fillStyle = "#020617"; // slate-950, matches the other wells
      ctx.fillRect(0, 0, w, h);

      const midline = h / 2;
      const amp = h / 2 - PAD; // pixels from midline to ±H

      // Faint ±H/2 gridlines.
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)"; // slate-400 @ low alpha
      ctx.lineWidth = 1;
      for (const frac of [-0.5, 0.5]) {
        const y = midline - frac * amp;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Emphasized zero midline.
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midline);
      ctx.lineTo(w, midline);
      ctx.stroke();

      if (!hasData.current || bins < 1) return;

      const raw = latest.current;
      const H = halfRange.current;
      const xAt = (i: number) => (bins === 1 ? w / 2 : (i / (bins - 1)) * w);
      // 0 → midline; +H → top; −H → bottom; clamped so an outlier can't leave the box.
      const yAt = (v: number) => {
        let t = v / H;
        if (t > 1) t = 1;
        else if (t < -1) t = -1;
        return midline - t * amp;
      };

      // Signed trace on the zero-centered axis.
      ctx.beginPath();
      for (let i = 0; i < bins; i++) {
        const x = xAt(i);
        const y = yAt(raw[i]);
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
