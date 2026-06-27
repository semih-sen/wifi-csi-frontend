// ─────────────────────────────────────────────────────────────────────────────
// Backend SignalR contract. Canonical definition: /CONTRACTS.md (Seam B).
// Every event/DTO is camelCase — there is no PascalCase exception anymore.
// Payloads are validated at the connection boundary (lib/validation.ts), never cast.
// ─────────────────────────────────────────────────────────────────────────────

/** Wire-contract version this client expects. Must match the backend's GetServerInfo. */
export const CONTRACT_VERSION = "1.0";

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
  GetServerInfo: "GetServerInfo",
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
