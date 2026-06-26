import type { CsiFrame } from "./types";

/**
 * Synthetic CSI source for developing the live graph without an ESP32 streaming
 * (README §6). Emits frames in the exact `ReceiveCsiData` shape at ~2 Hz.
 *
 * Signal model: a few standing-wave bumps across the subcarrier axis plus
 * slow drift and noise, with values swinging both sides of zero to mimic the
 * baseline-subtracted, low-pass-filtered amplitudes the backend produces.
 */
export function startMockCsiEmitter(
  emit: (frame: CsiFrame) => void,
  opts: { subcarriers?: number; intervalMs?: number } = {},
): () => void {
  const subcarrierCount = opts.subcarriers ?? 52;
  const intervalMs = opts.intervalMs ?? 500;
  let t = 0;

  const id = setInterval(() => {
    t += intervalMs / 1000;
    const amplitudes = new Array<number>(subcarrierCount);
    for (let k = 0; k < subcarrierCount; k++) {
      const x = k / subcarrierCount;
      const envelope =
        Math.sin(Math.PI * x) * 6 + // gentle band-shape
        Math.sin(2 * Math.PI * (x * 3 + t * 0.15)) * 4; // travelling ripple
      const motion = Math.sin(t * 1.3 + k * 0.2) * 2; // "activity" wobble
      const noise = (Math.random() - 0.5) * 1.5;
      amplitudes[k] = envelope * Math.exp(-2 * Math.abs(x - 0.5)) + motion + noise;
    }
    emit({
      timestampMs: Date.now(),
      rssi: -55 + Math.round((Math.random() - 0.5) * 6),
      subcarrierCount,
      amplitudes,
    });
  }, intervalMs);

  return () => clearInterval(id);
}
