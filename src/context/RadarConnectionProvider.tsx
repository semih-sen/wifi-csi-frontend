"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import {
  type ConnectionState,
  type RecordingStatus,
  type ServerInfo,
  CONTRACT_VERSION,
  HubEvent,
  HubMethod,
} from "@/lib/types";
import {
  parseCalibrationState,
  parseDspFrame,
  parseInferenceResult,
  parseRecordingStatus,
  parseServerInfo,
  parseStatusEvent,
} from "@/lib/validation";
import { startMockDspEmitter } from "@/lib/mockEmitter";

type EventHandler = (payload: unknown) => void;

/** Per-event boundary validators. A payload that fails is dropped (logged), never dispatched. */
const VALIDATORS: Record<string, (p: unknown) => unknown | null> = {
  [HubEvent.DspFrame]: parseDspFrame,
  [HubEvent.Inference]: parseInferenceResult,
  [HubEvent.Status]: parseStatusEvent,
  [HubEvent.RecordingState]: parseRecordingStatus,
};

/** Baseline-calibration state surfaced to the UI. */
interface CalibrationView {
  isCalibrating: boolean;
  baselineActive: boolean;
}

const NO_CALIBRATION: CalibrationView = { isCalibrating: false, baselineActive: false };

interface RadarContextValue {
  connectionState: ConnectionState;
  /** True once we've heard back from the server at least once. */
  recordingStatus: RecordingStatus | null;
  startRecording: (
    label: string,
    subject?: string,
    durationMs?: number,
  ) => Promise<void>;
  stopRecording: () => Promise<void>;
  /** Subscribe to a hub event. Returns an unsubscribe fn. Safe to call pre-connect. */
  on: (event: string, handler: EventHandler) => () => void;
  /** Whether the synthetic CSI emitter is feeding the graph. */
  mockActive: boolean;
  /** Contract handshake read on connect (null until the server answers). */
  serverInfo: ServerInfo | null;
  /** True when the server's contract version disagrees with this client's. */
  contractMismatch: boolean;
  /** Manually re-establish the connection after automatic reconnect was exhausted. */
  reconnect: () => void;
  /** Baseline (tare) calibration state. */
  calibration: CalibrationView;
  /** Trigger an empty-room baseline calibration (captures ~5 s of frames server-side). */
  calibrate: () => Promise<void>;
  /** Set when a calibration request did not complete (e.g. no CSI frames arriving). */
  calibrationError: string | null;
  /** True while real CSI frames are arriving from the backend (not the mock emitter). */
  hasLiveData: boolean;
}

const RadarContext = createContext<RadarContextValue | null>(null);

// Backend port the SignalR hub is served on (see Program.cs UseUrls).
const HUB_PORT = 5000;

function resolveHubUrl(): string {
  // An explicit override always wins — use this only when the backend runs on a
  // different host/port than the page was served from (e.g. a separate server box).
  const override = process.env.NEXT_PUBLIC_HUB_URL?.trim();
  if (override) {
    return `${override.replace(/\/$/, "")}/hubs/radar`;
  }

  // Default: derive the backend origin from whatever host loaded this page. This
  // makes one build work everywhere on the LAN — opening the UI from the laptop
  // (localhost) talks to the laptop's backend; opening it from a phone at
  // http://192.168.x.y talks to that same machine, not the phone itself. Hardcoding
  // "localhost" here is exactly what breaks the graph/prediction on remote devices.
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${HUB_PORT}/hubs/radar`;
  }

  // SSR fallback only — the real connection is always established client-side.
  return `http://localhost:${HUB_PORT}/hubs/radar`;
}

function toState(s: HubConnectionState): ConnectionState {
  switch (s) {
    case HubConnectionState.Connected:
      return "Connected";
    case HubConnectionState.Connecting:
      return "Connecting";
    case HubConnectionState.Reconnecting:
      return "Reconnecting";
    default:
      return "Disconnected";
  }
}

export function RadarConnectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("Disconnected");
  const [recordingStatus, setRecordingStatus] =
    useState<RecordingStatus | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [contractMismatch, setContractMismatch] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationView>(NO_CALIBRATION);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [hasLiveData, setHasLiveData] = useState(false);

  const connectionRef = useRef<HubConnection | null>(null);
  // Safety timer: if a calibration never reports completion (e.g. no CSI frames are
  // arriving), reset the UI instead of hanging on "Calibrating…" forever.
  const calTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock of the last REAL (backend) DSP frame — drives hasLiveData and the
  // "no data" guard on calibrate(). Mock frames intentionally don't count here.
  const lastFrameAtRef = useRef(0);
  // StrictMode (dev) double-invokes effects; this guards against a second start.
  const startedRef = useRef(false);
  // Local event bus: bridges both real hub events and the mock emitter so panels
  // subscribe through one path regardless of source.
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  const mockActive = process.env.NEXT_PUBLIC_MOCK_DSP === "1";

  // Validate at the boundary, then dispatch the typed payload. A payload that fails
  // validation is dropped here (logged once), so panels never see malformed data.
  const dispatch = useCallback((event: string, payload: unknown) => {
    const set = handlersRef.current.get(event);
    if (!set) return;

    const validate = VALIDATORS[event];
    let typed: unknown = payload;
    if (validate) {
      const parsed = validate(payload);
      if (parsed === null) {
        console.error(
          `[radar] dropped "${event}" payload failing contract validation`,
          payload,
        );
        return;
      }
      typed = parsed;
    }

    for (const h of set) {
      try {
        h(typed);
      } catch (err) {
        console.error(`[radar] handler for "${event}" threw`, err);
      }
    }
  }, []);

  const on = useCallback((event: string, handler: EventHandler) => {
    let set = handlersRef.current.get(event);
    if (!set) {
      set = new Set();
      handlersRef.current.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }, []);

  // Contract handshake (Seam B.3): read server config + version on (re)connect.
  const fetchServerInfo = useCallback(async (c: HubConnection) => {
    try {
      const info = parseServerInfo(await c.invoke(HubMethod.GetServerInfo));
      if (!info) {
        console.error("[radar] GetServerInfo returned an invalid payload");
        return;
      }
      setServerInfo(info);
      // Seed the calibration badge from the handshake so a reconnecting client renders
      // the right state immediately (a CalibrationState event also arrives on connect).
      setCalibration({
        isCalibrating: info.isCalibrating,
        baselineActive: info.baselineActive,
      });
      const mismatch = info.contractVersion !== CONTRACT_VERSION;
      setContractMismatch(mismatch);
      if (mismatch) {
        console.warn(
          `[radar] contract version mismatch: server=${info.contractVersion} client=${CONTRACT_VERSION}`,
        );
      }
    } catch (err) {
      console.error("[radar] GetServerInfo failed", err);
    }
  }, []);

  // Manual recovery after withAutomaticReconnect() exhausts its schedule (Seam B.5).
  const reconnect = useCallback(() => {
    const c = connectionRef.current;
    if (!c || c.state !== HubConnectionState.Disconnected) return;
    setConnectionState("Connecting");
    c.start()
      .then(() => {
        setConnectionState(toState(c.state));
        void fetchServerInfo(c);
      })
      .catch((err) => {
        console.error("[radar] manual reconnect failed", err);
        setConnectionState("Disconnected");
      });
  }, [fetchServerInfo]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const connection = new HubConnectionBuilder()
      .withUrl(resolveHubUrl())
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();
    connectionRef.current = connection;

    // Source of truth for recorder state (README §4) — validated at the boundary.
    connection.on(HubEvent.RecordingState, (raw) => {
      const status = parseRecordingStatus(raw);
      if (!status) {
        console.error("[radar] dropped invalid RecordingState payload", raw);
        return;
      }
      setRecordingStatus(status);
      dispatch(HubEvent.RecordingState, status);
    });
    // Stream + Phase-4 events are forwarded onto the local bus for panels. Real DSP
    // frames also stamp lastFrameAtRef so we know live data is actually flowing.
    connection.on(HubEvent.DspFrame, (p) => {
      lastFrameAtRef.current = Date.now();
      dispatch(HubEvent.DspFrame, p);
    });
    connection.on(HubEvent.Inference, (p) => dispatch(HubEvent.Inference, p));
    connection.on(HubEvent.Status, (p) => dispatch(HubEvent.Status, p));

    // Baseline calibration progress (drives the button state + "Baseline: Active" badge).
    connection.on(HubEvent.Calibration, (raw) => {
      const cal = parseCalibrationState(raw);
      if (!cal) {
        console.error("[radar] dropped invalid CalibrationState payload", raw);
        return;
      }
      setCalibration({
        isCalibrating: cal.isCalibrating,
        baselineActive: cal.baselineActive,
      });
      // A definitive (finished) state clears the optimistic safety timer and resolves
      // the outcome: failure → explain why; success → clear any stale error.
      if (!cal.isCalibrating) {
        if (calTimeoutRef.current) {
          clearTimeout(calTimeoutRef.current);
          calTimeoutRef.current = null;
        }
        if (cal.failed) {
          setCalibrationError(
            "Calibration failed — no CSI frames were received. Is the sensor streaming to the broker?",
          );
        } else if (cal.baselineActive) {
          setCalibrationError(null);
        }
      }
    });

    connection.onreconnecting(() => setConnectionState("Reconnecting"));
    connection.onreconnected(() => {
      setConnectionState("Connected");
      void fetchServerInfo(connection);
    });
    connection.onclose(() => setConnectionState("Disconnected"));

    setConnectionState("Connecting");
    connection
      .start()
      .then(() => {
        setConnectionState(toState(connection.state));
        void fetchServerInfo(connection);
      })
      .catch((err) => {
        console.error("[radar] initial connection failed", err);
        setConnectionState("Disconnected");
      });

    let stopMock: (() => void) | undefined;
    if (mockActive) {
      stopMock = startMockDspEmitter((frame) =>
        dispatch(HubEvent.DspFrame, frame),
      );
    }

    return () => {
      stopMock?.();
      if (calTimeoutRef.current) clearTimeout(calTimeoutRef.current);
      connection.off(HubEvent.RecordingState);
      connection.off(HubEvent.DspFrame);
      connection.off(HubEvent.Inference);
      connection.off(HubEvent.Status);
      connection.off(HubEvent.Calibration);
      // Idempotent: stop() is safe even if never fully connected.
      connection.stop().catch(() => undefined);
      connectionRef.current = null;
      startedRef.current = false;
    };
    // Intentionally run once. mockActive is a build-time constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll whether real DSP frames are still arriving (stale after ~4 s of silence).
  useEffect(() => {
    const id = setInterval(() => {
      setHasLiveData(Date.now() - lastFrameAtRef.current < 4000);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const startRecording = useCallback(
    async (label: string, subject = "", durationMs = 0) => {
      const c = connectionRef.current;
      if (!c || c.state !== HubConnectionState.Connected) {
        throw new Error("Not connected");
      }
      // We rely on the broadcast RecordingState for UI; return value is ignored.
      // All three args are sent explicitly — SignalR binds positionally.
      await c.invoke(HubMethod.StartRecording, label, subject, durationMs);
    },
    [],
  );

  const stopRecording = useCallback(async () => {
    const c = connectionRef.current;
    if (!c || c.state !== HubConnectionState.Connected) {
      throw new Error("Not connected");
    }
    await c.invoke(HubMethod.StopRecording);
  }, []);

  const calibrate = useCallback(async () => {
    const c = connectionRef.current;
    if (!c || c.state !== HubConnectionState.Connected) {
      throw new Error("Not connected");
    }
    setCalibrationError(null);

    // Fast fail: calibration averages live CSI frames. If none are arriving there is
    // nothing to average — don't spin, explain the real problem immediately.
    if (Date.now() - lastFrameAtRef.current > 4000) {
      setCalibrationError(
        "No CSI data is reaching the server — start the sensor (ESP32) streaming to the broker before calibrating.",
      );
      return;
    }

    // Optimistically enter the calibrating state for instant UX; the server's
    // CalibrationState events confirm start and (~5 s later) completion.
    setCalibration((prev) => ({ ...prev, isCalibrating: true }));

    // Arm the safety net BEFORE awaiting invoke, so a hung/failed invoke can never
    // leave the UI spinning forever. The server's "finished" event clears it.
    if (calTimeoutRef.current) clearTimeout(calTimeoutRef.current);
    calTimeoutRef.current = setTimeout(() => {
      calTimeoutRef.current = null;
      setCalibration((prev) =>
        prev.isCalibrating ? { ...prev, isCalibrating: false } : prev,
      );
      setCalibrationError(
        "Calibration timed out with no completion signal — are CSI frames still streaming?",
      );
    }, 14_000);

    try {
      // Pass an explicit argument: SignalR binds hub args positionally and does NOT
      // fill C# default parameters, so invoking Calibrate(int frames=500) with zero
      // args is rejected ("provides 0 argument(s) but target expects 1"). 0 tells the
      // backend to use its default capture size (~5 s).
      await c.invoke(HubMethod.Calibrate, 0);
    } catch (err) {
      if (calTimeoutRef.current) {
        clearTimeout(calTimeoutRef.current);
        calTimeoutRef.current = null;
      }
      setCalibration((prev) => ({ ...prev, isCalibrating: false }));
      const detail = err instanceof Error ? err.message : String(err);
      setCalibrationError(`Could not start calibration: ${detail}`);
      throw err;
    }
  }, []);

  return (
    <RadarContext.Provider
      value={{
        connectionState,
        recordingStatus,
        startRecording,
        stopRecording,
        on,
        mockActive,
        serverInfo,
        contractMismatch,
        reconnect,
        calibration,
        calibrate,
        calibrationError,
        hasLiveData,
      }}
    >
      {children}
    </RadarContext.Provider>
  );
}

export function useRadar(): RadarContextValue {
  const ctx = useContext(RadarContext);
  if (!ctx) {
    throw new Error("useRadar must be used within <RadarConnectionProvider>");
  }
  return ctx;
}
