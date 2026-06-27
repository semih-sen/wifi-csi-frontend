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
  parseCsiFrame,
  parseInferenceResult,
  parseRecordingStatus,
  parseServerInfo,
  parseStatusEvent,
} from "@/lib/validation";
import { startMockCsiEmitter } from "@/lib/mockEmitter";

type EventHandler = (payload: unknown) => void;

/** Per-event boundary validators. A payload that fails is dropped (logged), never dispatched. */
const VALIDATORS: Record<string, (p: unknown) => unknown | null> = {
  [HubEvent.CsiData]: parseCsiFrame,
  [HubEvent.Inference]: parseInferenceResult,
  [HubEvent.Status]: parseStatusEvent,
  [HubEvent.RecordingState]: parseRecordingStatus,
};

interface RadarContextValue {
  connectionState: ConnectionState;
  /** True once we've heard back from the server at least once. */
  recordingStatus: RecordingStatus | null;
  startRecording: (label: string) => Promise<void>;
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
}

const RadarContext = createContext<RadarContextValue | null>(null);

function resolveHubUrl(): string {
  const origin = process.env.NEXT_PUBLIC_HUB_URL ?? "http://localhost:5000";
  return `${origin.replace(/\/$/, "")}/hubs/radar`;
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

  const connectionRef = useRef<HubConnection | null>(null);
  // StrictMode (dev) double-invokes effects; this guards against a second start.
  const startedRef = useRef(false);
  // Local event bus: bridges both real hub events and the mock emitter so panels
  // subscribe through one path regardless of source.
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  const mockActive = process.env.NEXT_PUBLIC_MOCK_CSI === "1";

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
    // Stream + Phase-4 events are forwarded onto the local bus for panels.
    connection.on(HubEvent.CsiData, (p) => dispatch(HubEvent.CsiData, p));
    connection.on(HubEvent.Inference, (p) => dispatch(HubEvent.Inference, p));
    connection.on(HubEvent.Status, (p) => dispatch(HubEvent.Status, p));

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
      stopMock = startMockCsiEmitter((frame) =>
        dispatch(HubEvent.CsiData, frame),
      );
    }

    return () => {
      stopMock?.();
      connection.off(HubEvent.RecordingState);
      connection.off(HubEvent.CsiData);
      connection.off(HubEvent.Inference);
      connection.off(HubEvent.Status);
      // Idempotent: stop() is safe even if never fully connected.
      connection.stop().catch(() => undefined);
      connectionRef.current = null;
      startedRef.current = false;
    };
    // Intentionally run once. mockActive is a build-time constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = useCallback(async (label: string) => {
    const c = connectionRef.current;
    if (!c || c.state !== HubConnectionState.Connected) {
      throw new Error("Not connected");
    }
    // We rely on the broadcast RecordingState for UI; return value is ignored.
    await c.invoke(HubMethod.StartRecording, label);
  }, []);

  const stopRecording = useCallback(async () => {
    const c = connectionRef.current;
    if (!c || c.state !== HubConnectionState.Connected) {
      throw new Error("Not connected");
    }
    await c.invoke(HubMethod.StopRecording);
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
