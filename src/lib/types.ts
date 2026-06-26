// ─────────────────────────────────────────────────────────────────────────────
// Backend SignalR contract (authoritative — see FRONTEND_README.md §2).
// All typed DTOs are camelCase. ReceiveStatus is the one PascalCase exception.
// ─────────────────────────────────────────────────────────────────────────────

/** `ReceiveCsiData` — one amplitude-vs-subcarrier vector per processing slide (~1–2 Hz). */
export interface CsiFrame {
  /** Unix epoch milliseconds. */
  timestampMs: number;
  /** Received signal strength, dBm (negative). */
  rssi: number;
  /** Length of `amplitudes`. */
  subcarrierCount: number;
  /** One filtered value per subcarrier. Baseline-subtracted → CAN BE NEGATIVE. */
  amplitudes: number[];
}

/** `RecordingState` broadcast + `Start/Stop/GetRecordingStatus` return value. */
export interface RecordingStatus {
  isRecording: boolean;
  sessionId: number;
  label: string;
  framesCaptured: number;
  framesDropped: number;
  startedAtUnixMs: number;
}

/** `ReceiveInference` — per-window classification (Phase 4, not yet emitted). */
export interface InferenceResult {
  predictedLabel: string;
  confidence: number;
  scores: Record<string, number>;
  timestampMs: number;
}

/**
 * `ReceiveStatus` — confirmed automation change (Phase 4).
 * ⚠️ PascalCase on the wire, unlike every other event (README §2.2).
 */
export interface StatusEvent {
  Status: string;
  Timestamp: string;
}

/** SignalR event names, server → client. */
export const HubEvent = {
  CsiData: "ReceiveCsiData",
  RecordingState: "RecordingState",
  Inference: "ReceiveInference",
  Status: "ReceiveStatus",
} as const;

/** Hub methods, client → server. */
export const HubMethod = {
  StartRecording: "StartRecording",
  StopRecording: "StopRecording",
  GetRecordingStatus: "GetRecordingStatus",
} as const;

export type ConnectionState =
  | "Disconnected"
  | "Connecting"
  | "Connected"
  | "Reconnecting";

export const IDLE_STATUS: RecordingStatus = {
  isRecording: false,
  sessionId: 0,
  label: "",
  framesCaptured: 0,
  framesDropped: 0,
  startedAtUnixMs: 0,
};
