// ─────────────────────────────────────────────────────────────────────────────
// Backend SignalR contract. Canonical definition: /CONTRACTS.md (Seam B).
// Every event/DTO is camelCase — there is no PascalCase exception anymore.
// Payloads are validated at the connection boundary (lib/validation.ts), never cast.
// ─────────────────────────────────────────────────────────────────────────────

/** Wire-contract version this client expects. Must match the backend's GetServerInfo. */
export const CONTRACT_VERSION = "1.5";

/** What a recording is for. Mirrors the backend `RecordingKind` wire tokens. */
export type RecordingKind = "activity" | "identity";

/** One RX's viz data inside a {@link DspFrame}. */
export interface DspRx {
  /** 0 = RX0 (primary), 1 = RX1 (secondary). */
  rxIndex: number;
  /** `|CSI|` per subcarrier (length `subcarriers`, 64). Raw magnitude → NON-NEGATIVE. */
  amplitude: number[];
  /**
   * VIZ-ONLY mean STFT magnitude across subcarriers (length `dopplerBins`, 33 =
   * one-sided DC…Nyquist). Empty until the first STFT window fills (~0.6 s per RX).
   */
  dopplerMean: number[];
}

/**
 * `ReceiveDspFrame` — throttled (10 Hz) per-RX amplitude + aggregated Doppler tap off
 * the backend DSP stage, for the live canvases. Replaces the V1 `ReceiveCsiData`.
 */
export interface DspFrame {
  /** Shared sequence number of the aligned RX pair. */
  seqNo: number;
  /** Always two entries: rxIndex 0 (RX0) and 1 (RX1). */
  rx: DspRx[];
}

/** `RecordingState` broadcast + `Start/Stop/GetRecordingStatus` return value. */
export interface RecordingStatus {
  isRecording: boolean;
  sessionId: number;
  /** What the session is for: "activity" | "identity" (empty when idle). */
  kind: string;
  label: string;
  /** Who performed the activity (e.g. the person walking). Empty when N/A. */
  subject: string;
  framesCaptured: number;
  framesDropped: number;
  startedAtUnixMs: number;
  /** Unix ms when the recording auto-stops, or 0 for a manual (open-ended) recording. */
  stopAtUnixMs: number;
}

/** `ReceiveInference` — per-window classification (Phase 4, not yet emitted). */
export interface InferenceResult {
  predictedLabel: string;
  confidence: number;
  scores: Record<string, number>;
  timestampMs: number;
}

/** `ReceiveStatus` — confirmed automation change (camelCase, like every other event). */
export interface StatusEvent {
  status: string;
  /** Unix epoch milliseconds. */
  timestampMs: number;
}

/** `GetServerInfo` return value — the contract handshake read on connect (Seam B.3). */
export interface ServerInfo {
  contractVersion: string;
  windowSize: number;
  slideStep: number;
  sampleRateHz: number;
  subcarrierCount: number;
  modelLoaded: boolean;
  classes: string[];
  isCalibrating: boolean;
  baselineActive: boolean;
  /** Subcarriers per RX in a DSP frame (viz canvas height). */
  subcarriers: number;
  /** Doppler magnitude bins per RX (`dopplerMean` length). */
  dopplerBins: number;
  /** Throttled cadence of `ReceiveDspFrame`, in Hz. */
  dopplerCadenceHz: number;
}

/** `CalibrationState` — baseline (tare) progress, pushed on start/finish + on connect. */
export interface CalibrationState {
  isCalibrating: boolean;
  baselineActive: boolean;
  /** True if the last attempt failed (almost always: no CSI frames were flowing). */
  failed: boolean;
  framesRequested: number;
  timestampMs: number;
}

/** SignalR event names, server → client. */
export const HubEvent = {
  DspFrame: "ReceiveDspFrame",
  RecordingState: "RecordingState",
  Inference: "ReceiveInference",
  Status: "ReceiveStatus",
  Calibration: "CalibrationState",
} as const;

/** Hub methods, client → server. */
export const HubMethod = {
  StartRecording: "StartRecording",
  StopRecording: "StopRecording",
  GetRecordingStatus: "GetRecordingStatus",
  GetServerInfo: "GetServerInfo",
  Calibrate: "Calibrate",
} as const;

export type ConnectionState =
  | "Disconnected"
  | "Connecting"
  | "Connected"
  | "Reconnecting";

export const IDLE_STATUS: RecordingStatus = {
  isRecording: false,
  sessionId: 0,
  kind: "",
  label: "",
  subject: "",
  framesCaptured: 0,
  framesDropped: 0,
  startedAtUnixMs: 0,
  stopAtUnixMs: 0,
};
