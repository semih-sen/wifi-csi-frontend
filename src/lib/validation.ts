// ─────────────────────────────────────────────────────────────────────────────
// Boundary validation (Seam B.2). The SignalR bus hands panels raw `unknown`
// payloads; these validators PARSE them into typed values and return null on drift,
// so a renamed/missing field fails loudly at the seam instead of rendering
// `undefined` three layers down. Hand-rolled (no schema lib) — these DTOs are small
// and the single source of truth is /CONTRACTS.md.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CalibrationState,
  DspFrame,
  DspRx,
  InferenceResult,
  RecordingStatus,
  ServerInfo,
  StatusEvent,
} from "./types";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isNum);
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}

function parseDspRx(p: unknown): DspRx | null {
  if (!isObject(p)) return null;
  if (!isNum(p.rxIndex)) return null;
  // amplitude must be present + non-empty; dopplerMean may be [] until the STFT fills.
  if (!isNumArray(p.amplitude) || p.amplitude.length === 0) return null;
  if (!isNumArray(p.dopplerMean)) return null;
  return {
    rxIndex: p.rxIndex,
    amplitude: p.amplitude,
    dopplerMean: p.dopplerMean,
  };
}

export function parseDspFrame(p: unknown): DspFrame | null {
  if (!isObject(p)) return null;
  if (!isNum(p.seqNo)) return null;
  if (!Array.isArray(p.rx) || p.rx.length === 0) return null;
  const rx: DspRx[] = [];
  for (const entry of p.rx) {
    const parsed = parseDspRx(entry);
    if (!parsed) return null;
    rx.push(parsed);
  }
  return { seqNo: p.seqNo, rx };
}

export function parseInferenceResult(p: unknown): InferenceResult | null {
  if (!isObject(p)) return null;
  if (!isStr(p.predictedLabel) || !isNum(p.confidence) || !isNum(p.timestampMs)) return null;
  if (!isObject(p.scores)) return null;
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.scores)) {
    if (!isNum(v)) return null;
    scores[k] = v;
  }
  return {
    predictedLabel: p.predictedLabel,
    confidence: p.confidence,
    scores,
    timestampMs: p.timestampMs,
  };
}

export function parseStatusEvent(p: unknown): StatusEvent | null {
  if (!isObject(p)) return null;
  if (!isStr(p.status) || !isNum(p.timestampMs)) return null;
  return { status: p.status, timestampMs: p.timestampMs };
}

export function parseRecordingStatus(p: unknown): RecordingStatus | null {
  if (!isObject(p)) return null;
  if (
    !isBool(p.isRecording) ||
    !isNum(p.sessionId) ||
    !isStr(p.label) ||
    !isStr(p.subject) ||
    !isNum(p.framesCaptured) ||
    !isNum(p.framesDropped) ||
    !isNum(p.startedAtUnixMs)
  ) {
    return null;
  }
  return {
    isRecording: p.isRecording,
    sessionId: p.sessionId,
    label: p.label,
    subject: p.subject,
    framesCaptured: p.framesCaptured,
    framesDropped: p.framesDropped,
    startedAtUnixMs: p.startedAtUnixMs,
    // Additive in contract 1.3; tolerate an older backend that omits it.
    stopAtUnixMs: isNum(p.stopAtUnixMs) ? p.stopAtUnixMs : 0,
  };
}

export function parseServerInfo(p: unknown): ServerInfo | null {
  if (!isObject(p)) return null;
  if (
    !isStr(p.contractVersion) ||
    !isNum(p.windowSize) ||
    !isNum(p.slideStep) ||
    !isNum(p.sampleRateHz) ||
    !isNum(p.subcarrierCount) ||
    !isBool(p.modelLoaded) ||
    !isStrArray(p.classes) ||
    !isBool(p.isCalibrating) ||
    !isBool(p.baselineActive)
  ) {
    return null;
  }
  return {
    contractVersion: p.contractVersion,
    windowSize: p.windowSize,
    slideStep: p.slideStep,
    sampleRateHz: p.sampleRateHz,
    subcarrierCount: p.subcarrierCount,
    modelLoaded: p.modelLoaded,
    classes: p.classes,
    isCalibrating: p.isCalibrating,
    baselineActive: p.baselineActive,
    // Viz metadata is additive in contract 1.4; fall back to the pinned defaults so a
    // slightly older backend still renders (canvases just size from 64/33/10).
    subcarriers: isNum(p.subcarriers) ? p.subcarriers : 64,
    dopplerBins: isNum(p.dopplerBins) ? p.dopplerBins : 33,
    dopplerCadenceHz: isNum(p.dopplerCadenceHz) ? p.dopplerCadenceHz : 10,
  };
}

export function parseCalibrationState(p: unknown): CalibrationState | null {
  if (!isObject(p)) return null;
  if (
    !isBool(p.isCalibrating) ||
    !isBool(p.baselineActive) ||
    !isNum(p.framesRequested) ||
    !isNum(p.timestampMs)
  ) {
    return null;
  }
  return {
    isCalibrating: p.isCalibrating,
    baselineActive: p.baselineActive,
    // `failed` is additive; tolerate an older backend that omits it.
    failed: isBool(p.failed) ? p.failed : false,
    framesRequested: p.framesRequested,
    timestampMs: p.timestampMs,
  };
}
