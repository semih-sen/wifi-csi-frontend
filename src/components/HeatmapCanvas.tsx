"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

/** Imperative handle: panels push one column per DSP frame; drawing is on rAF. */
export interface HeatmapHandle {
  /** Append one column (length should equal `rows`; extra/missing entries are clamped). */
  push: (column: ArrayLike<number>) => void;
  /** Drop all history (e.g. on RX change). */
  clear: () => void;
}

interface HeatmapCanvasProps {
  /** Vertical resolution (e.g. subcarriers, or mirrored Doppler bins). */
  rows: number;
  /** Bounded horizontal history in columns (the "last N seconds" cap). */
  maxCols?: number;
  className?: string;
  gamma?: number;
  /** value→[r,g,b] after normalization to [0,1]. Defaults to a magma-like ramp. */
  palette?: (t: number) => [number, number, number];
}

const MAGMA: Array<[number, [number, number, number]]> = [
  [0.0, [0, 0, 4]],
  [0.25, [60, 15, 110]],
  [0.5, [140, 40, 120]],
  [0.75, [230, 90, 60]],
  [1.0, [252, 220, 90]],
];

function magma(t: number): [number, number, number] {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 1; i < MAGMA.length; i++) {
    const [x1, c1] = MAGMA[i];
    if (x <= x1) {
      const [x0, c0] = MAGMA[i - 1];
      const f = (x - x0) / (x1 - x0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return MAGMA[MAGMA.length - 1][1];
}

/**
 * A scrolling heatmap/spectrogram. History lives in a BOUNDED ring buffer (never
 * grows); the newest column is anchored at the right edge and older columns scroll
 * left. Render is decoupled from the push rate: `push()` only mutates the ring and
 * marks dirty; a single requestAnimationFrame loop repaints when there is new data.
 *
 * The canvas backing store is exactly `maxCols × rows` pixels; CSS stretches it to the
 * element box, so there is no per-frame scaling maths.
 */
export const HeatmapCanvas = forwardRef<HeatmapHandle, HeatmapCanvasProps>(
  function HeatmapCanvas({ rows, maxCols = 256, className, palette = magma, gamma = 1 }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Ring buffer + draw state, all in refs (never React state per column).
    const ring = useRef<Float32Array>(new Float32Array(rows * maxCols));
    const head = useRef(0); // next column slot to write (== oldest once full)
    const count = useRef(0);
    const scaleMax = useRef(1e-6);
    const dirty = useRef(true);

    // (Re)allocate when geometry changes.
    useEffect(() => {
      ring.current = new Float32Array(rows * maxCols);
      head.current = 0;
      count.current = 0;
      scaleMax.current = 1e-6;
      dirty.current = true;
    }, [rows, maxCols]);

    useImperativeHandle(
      ref,
      () => ({
        push: (column) => {
          const r = ring.current;
          const base = head.current * rows;
          let colMax = 0;
          const n = Math.min(rows, column.length);
          for (let y = 0; y < rows; y++) {
            const v = y < n ? column[y] : 0;
            r[base + y] = v;
            if (v > colMax) colMax = v;
          }
          head.current = (head.current + 1) % maxCols;
          count.current = Math.min(count.current + 1, maxCols);
          // Adaptive scale: track a slowly-decaying running max so contrast follows the
          // signal without a fixed ceiling (amplitude and Doppler have very different ranges).
          scaleMax.current = Math.max(scaleMax.current * 0.98, colMax, 1e-6);
          dirty.current = true;
        },
        clear: () => {
          ring.current.fill(0);
          head.current = 0;
          count.current = 0;
          scaleMax.current = 1e-6;
          dirty.current = true;
        },
      }),
      [rows, maxCols],
    );

    // ── rAF paint loop ──
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const image = ctx.createImageData(maxCols, rows);
      const data = image.data;
      let raf = 0;

      const paint = () => {
        raf = requestAnimationFrame(paint);
        if (!dirty.current) return;
        dirty.current = false;

        const r = ring.current;
        const smax = scaleMax.current;
        const filled = count.current;
        const h = head.current;

        for (let x = 0; x < maxCols; x++) {
          const ageFromRight = maxCols - 1 - x; // 0 = newest, at the right edge
          if (ageFromRight < filled) {
            const srcCol = ((h - 1 - ageFromRight) % maxCols + maxCols) % maxCols;
            const base = srcCol * rows;
            for (let y = 0; y < rows; y++) {
                 let t = r[base + y] / smax;               // 0..1 linear
if (gamma !== 1) t = Math.pow(t, gamma);  // gamma<1 → alçak değerleri yukarı çeker
const [cr, cg, cb] = palette(t);
              const idx = (y * maxCols + x) * 4;
              data[idx] = cr;
              data[idx + 1] = cg;
              data[idx + 2] = cb;
              data[idx + 3] = 255;
            }
          } else {
            // No data yet for this column — paint it background (dark).
            for (let y = 0; y < rows; y++) {
              const idx = (y * maxCols + x) * 4;
              data[idx] = 2;
              data[idx + 1] = 6;
              data[idx + 3] = 255;
              data[idx + 2] = 23;
            }
          }
        }
        ctx.putImageData(image, 0, 0);
      };

   

      raf = requestAnimationFrame(paint);
      return () => cancelAnimationFrame(raf);
    }, [rows, maxCols, palette]);

    return (
      <canvas
        ref={canvasRef}
        width={maxCols}
        height={rows}
        className={className}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    );
  },
);
