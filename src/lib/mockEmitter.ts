import type { DspFrame } from "./types";

/**
 * Synthetic per-RX DSP source for developing the live canvases without an ESP32
 * streaming. Emits frames in the exact `ReceiveDspFrame` shape at the contract cadence
 * (~10 Hz), two RX side by side.
 *
 * Signal model: amplitude is a few travelling standing-wave bumps across the 64
 * subcarriers; the Doppler column keeps most energy in the DC (zero) bin — like a
 * static room — with a slow, small spread into low non-zero bins so the spectrogram
 * looks alive. RX1 lags RX0 slightly so the two panels are visibly distinct.
 */
export function startMockDspEmitter(
  emit: (frame: DspFrame) => void,
  opts: { subcarriers?: number; dopplerBins?: number; intervalMs?: number } = {},
): () => void {
  const subcarriers = opts.subcarriers ?? 64;
  const dopplerBins = opts.dopplerBins ?? 33;
  const intervalMs = opts.intervalMs ?? 100; // 10 Hz
  let t = 0;
  let seq = 0;

  const buildRx = (rxIndex: number, rxPhase: number): DspFrame["rx"][number] => {
    const amplitude = new Array<number>(subcarriers);
    for (let k = 0; k < subcarriers; k++) {
      const x = k / subcarriers;
      const envelope =
        18 +
        Math.sin(Math.PI * x) * 8 +
        Math.sin(2 * Math.PI * (x * 3 + t * 0.15 + rxPhase)) * 4;
      const noise = (Math.random() - 0.5) * 1.2;
      amplitude[k] = Math.max(0, envelope + noise); // |CSI| ≥ 0
    }

    // Sanitized phase is detrended → a small signed ripple centered on 0 (NOT the
    // amplitude envelope). Model it so the zero-centered phase panel reads as alive.
    const phase = new Array<number>(subcarriers);
    for (let k = 0; k < subcarriers; k++) {
      const x = k / subcarriers;
      phase[k] =
        Math.sin(2 * Math.PI * (x * 2 + t * 0.1 + rxPhase)) * 0.15 +
        (Math.random() - 0.5) * 0.03;
    }

    // Doppler: strong DC (bin 0) + a small, slowly-breathing low-frequency spread.
    const spread = 1.5 + Math.sin(t * 0.5 + rxPhase) * 1.0; // "activity" breathing
    const dopplerMean = new Array<number>(dopplerBins);
    for (let b = 0; b < dopplerBins; b++) {
      const dc = b === 0 ? 30 : 0;
      const tail = 12 * Math.exp(-b / Math.max(0.5, spread));
      dopplerMean[b] = dc + tail + Math.random() * 0.4;
    }

    return { rxIndex, amplitude, phase, dopplerMean };
  };

  const id = setInterval(() => {
    t += intervalMs / 1000;
    seq += 1;
    emit({ seqNo: seq, rx: [buildRx(0, 0), buildRx(1, 0.6)] });
  }, intervalMs);

  return () => clearInterval(id);
}
