# CsiRadar — Frontend Integration Guide

A guide for building the web client against the `CsiRadar.Backend` real-time
pipeline. This document is **contract + architecture + build plan only** — no
implementation code. It assumes working familiarity with React and Next.js, so it
skips framework basics and focuses on what is specific to this system: the SignalR
contract, the streaming/charting concerns, the recording UX, and the gotchas that
will actually bite.

---

## 1. Where the frontend sits

The frontend is a **thin client**. All signal processing, inference, and recording
happen server-side. The client does exactly two things:

1. **Subscribes** to real-time streams over a single SignalR (WebSocket) connection
   and renders them (live CSI graph, inference label, recorder state).
2. **Issues commands** — start/stop/label a recording session — by invoking hub
   methods. It never touches CSI data files; the backend writes training data to
   disk directly.

```
ESP32 → MQTT → [Backend pipeline] ──SignalR/WebSocket──► Frontend (render)
                                   ◄──invoke (start/stop)── Frontend (control)
```

There is **no REST API** in the current backend. Everything the frontend needs
flows through the one hub. Keep that in mind: there is nothing to `fetch()` — the
entire integration surface is the SignalR connection.

---

## 2. Backend contract (authoritative)

### 2.1 Connection

| Property | Value |
|---|---|
| Transport | SignalR over WebSocket |
| Hub URL | `{BACKEND_ORIGIN}/hubs/radar` |
| CORS | Dev: any origin reflected, credentials allowed. **Tighten for prod.** |
| Server keep-alive | 15 s |
| Server client-timeout | 30 s (send something — even pings — within this window) |
| Detailed errors | Enabled in backend `Development` only |

Use the official `@microsoft/signalr` client. Prefer the WebSocket transport; allow
the library's automatic fallback only if you expect restrictive proxies.

### 2.2 Server → client events (subscribe with `connection.on`)

| Event | Payload shape | Casing | Cadence | Status |
|---|---|---|---|---|
| `ReceiveDspFrame` | `{ seqNo, rx:[{ rxIndex, amplitude[64], dopplerMean[33] }] }` | camelCase | **10 Hz** (throttled) | **Live** (when both RX stream + pair) |
| `RecordingState` | `{ isRecording, sessionId, kind, label, subject, framesCaptured, framesDropped, startedAtUnixMs, stopAtUnixMs }` | camelCase | On connect + every start/stop | **Live now** |
| `ReceiveInference` | `{ predictedLabel, confidence, scores{label:number}, timestampMs }` | camelCase | Per window | **Pending (Phase 4)** — won't fire until the ONNX model + debounce are wired |
| `ReceiveStatus` | `{ Status, Timestamp }` | **PascalCase** ⚠️ | On confirmed automation change | **Pending (Phase 4)** |

**Casing gotcha (read this twice).** Typed DTOs are camelCased via explicit
serializer attributes. `ReceiveStatus` is sent as an anonymous object with **no**
attributes, so it arrives **PascalCase** (`Status`, `Timestamp`) — inconsistent
with every other event. Handle it as-is on the client, or raise it with the backend
to normalize before Phase 4 lands. Don't let it silently break a typed mapping.

### 2.3 `ReceiveDspFrame` payload semantics (V2 per-RX DSP)

- `rx` always carries two entries, `rxIndex` 0 (RX0/primary) and 1 (RX1/secondary) —
  the two synchronized receivers, never fused (fusion is a later backend phase).
- `amplitude` is `|CSI|` per subcarrier (length 64), **raw magnitude → non-negative**.
- `dopplerMean` is a **viz-only** aggregate: the mean STFT magnitude across subcarriers
  for that RX's latest Doppler column (length 33 = one-sided DC…Nyquist). Empty (`[]`)
  until the first STFT window fills (~0.6 s per RX). The model-facing per-subcarrier
  Doppler stays server-side.
- Throttled to **10 Hz** (not the full frame rate); loss-tolerant, so a dropped frame
  is harmless. `seqNo` is the shared alignment key of the RX pair.

The live panel renders, per RX: an amplitude heatmap (subcarrier × time) and a Doppler
spectrogram (0 Hz centered — the symmetric magnitude mirrored about DC — × time). Empty
room concentrates Doppler energy at the center bin; walking spreads it outward.

Rendering pattern (unchanged discipline):
- **Time view (waterfall/spectrogram):** append one column per event and append their
  values to a client-side rolling buffer over time.

### 2.4 Client → server methods (call with `connection.invoke`)

| Method | Args | Returns |
|---|---|---|
| `StartRecording` | `kind: "activity"\|"identity", label: string, subject: string, durationMs: int` (0 = manual) | `RecordingStatus` |
| `StopRecording` | — | `RecordingStatus` |
| `GetRecordingStatus` | — | `RecordingStatus` |

**SignalR binds args positionally — send all four `StartRecording` args explicitly** (it
does not fill C# defaults). The server **validates**: `kind` must be `activity` or
`identity`, and an `identity` session requires a non-blank `subject` (gait data with no
person is useless; the activity is forced to `walking`). A rejected request comes back as
the idle `RecordingStatus` (`isRecording:false`) — nothing starts.

`Start`/`Stop` both return the resulting `RecordingStatus` to the caller **and** broadcast
it to all clients via `RecordingState`. So you can either use the invoke return value or
rely on the broadcast — prefer treating `RecordingState` as the single source of truth so
multiple open tabs/clients stay consistent. `RecordingStatus` now carries `kind` (contract
1.5): `{ isRecording, sessionId, kind, label, subject, framesCaptured, framesDropped,
startedAtUnixMs, stopAtUnixMs }`.

---

## 3. Recommended stack

| Concern | Recommendation | Why |
|---|---|---|
| Framework | Next.js (App Router) | You know it; SSG/CSR split is fine here |
| Realtime | `@microsoft/signalr` | First-party, matches the backend protocol exactly |
| Charting | A streaming-oriented lib (e.g. uPlot) for the live graph; a general lib (Recharts/Chart.js) is fine for low-rate panels | At ~1–2 Hz almost anything works, but a canvas/WebGL renderer keeps you safe if cadence rises |
| State | React Context for the connection + recorder state; local state per panel | The connection is a singleton cross-cutting concern |
| Styling | Your choice (Tailwind pairs well with the design tokens in the backend repo's `frontend-design` skill if you adopt it) | — |

**SignalR is client-only.** It must never run during SSR. Isolate everything that
touches the connection inside client components (`"use client"`), and gate it on
mount. Treat the hub connection as a browser-only resource.

---

## 4. Connection lifecycle — the part that causes the most bugs

Design the connection as a **single long-lived instance** shared across the app,
not one per component. Concretely:

- Build the connection once (with automatic reconnect) and expose it + the latest
  `RecordingState` through a Context provider mounted high in the client tree.
- **React StrictMode (dev) double-invokes effects.** Naive "connect in effect,
  disconnect in cleanup" will connect→disconnect→connect and can leave you fighting
  phantom disconnects. Guard against double-start (ref flag / connection-state
  check) and make cleanup idempotent.
- Handle the full state machine: `Connecting → Connected → Reconnecting →
  Disconnected`. Surface it in the UI — the user needs to know when the graph is
  stale because the socket dropped, not because the room is empty.
- On (re)connect, you'll receive a fresh `RecordingState` push; use it to resync.
  Don't assume the recorder is idle just because you reconnected — a session may
  have been started from another client and still be running server-side.
- Always remove handlers and stop the connection on final unmount.

---

## 5. Suggested structure (described, not prescribed)

A minimal, sane layout:

- **Connection/recorder context** — owns the singleton connection, exposes
  `connectionState`, `recordingStatus`, and `start(label)`/`stop()` actions.
- **Live DSP panel** — subscribes to `ReceiveDspFrame`, owns bounded per-RX ring
  buffers, renders the amplitude heatmap + Doppler spectrogram for RX0 and RX1 side by
  side (canvas + rAF). Also surfaces pairing health from `/health`. Self-contained.
- **Recorder panel** — label input, start/stop button driven by `recordingStatus`,
  live `framesCaptured` counter, and a **drop warning** when `framesDropped > 0`.
- **Inference panel** — subscribes to `ReceiveInference`/`ReceiveStatus`; renders a
  "waiting for model" placeholder until Phase 4. Build the shell now, wire later.
- **Connection-status indicator** — small, always visible.

Keep each panel's subscription local to that panel (subscribe on mount, unsubscribe
on unmount) so panels compose cleanly.

---

## 6. Live graph design considerations

- **Client-side ring buffer.** For the time view, keep a fixed-length rolling
  window (e.g. last N seconds) and drop the oldest as new frames arrive. Never let
  an unbounded array grow for a long-running session.
- **Decouple render from event rate.** Even at ~2 Hz, push incoming frames into a
  ref/buffer and let the chart read on its own `requestAnimationFrame` tick rather
  than re-rendering React state on every event. This pattern costs nothing now and
  saves you if the backend cadence increases.
- **Color scale.** Amplitude and Doppler magnitude are both non-negative; the heatmap
  auto-scales its color range to a slowly-decaying running max so contrast follows the
  signal without a fixed ceiling.
- **Dev without hardware = no `ReceiveDspFrame`.** With no ESP32 transmitting (or the
  RX pair not aligning), the stream is silent. `NEXT_PUBLIC_MOCK_DSP=1` starts a local
  emitter pushing synthetic `ReceiveDspFrame`s in the same shape so you can develop the
  canvases without the full hardware loop. Coordinate the exact shape from §2.2/§2.3.

---

## 7. Recording UX flow

The recorder captures **raw aligned dual-RX I/Q** (`.csibin` v3) server-side; the client is
control + status only. The panel (`RecorderPanel`) has an **Activity | Identity** mode toggle
because the two produce different datasets:

- **Activity** — a class selector (`empty` / `standing` / `walking` / `sitting`) sets the
  label; subject is optional. Sends `kind="activity"`.
- **Identity** — gait recognition, so the activity is **locked to `walking`** and a
  **subject (person) is required** (Start stays disabled until it's non-empty). Sends
  `kind="identity", label="walking", subject=<person>`.

The loop:

1. Pick mode + class/subject (+ optional auto-stop duration) and press **Start**.
2. Client `invoke("StartRecording", kind, label, subject, durationMs)`; UI flips to a
   recording state driven by the returned/broadcast `RecordingStatus`.
3. While recording, show **live `framesCaptured`**, `kind`, `label`, `subject`, and elapsed
   time (from `startedAtUnixMs`) so the user has feedback that data is flowing.
4. **Surface `framesDropped` prominently if non-zero** — a dropped frame (backpressure / RX
   dropout) makes the session **not ML-grade** (flagged incomplete in its manifest), so the
   user should re-record. First-class signal, not a footnote.
5. **Stop** → `invoke("StopRecording")`; the server finalizes the file + manifest.

Guardrails:
- **Disable Start unless `hasLiveData`** (CSI frames actually flowing) — recording nothing
  is worse than not recording; show the "no CSI reaching the server" message otherwise.
- Disable Start while `isRecording` is true (and Stop while idle) — drive both off
  `RecordingState`, never off optimistic local state alone.
- Because state is server-authoritative and broadcast to all clients, two open tabs stay in
  sync for free if you treat `RecordingState` as the source of truth.
- The class set is a fixed dropdown (consistent training labels); the backend sanitizes
  labels for filenames regardless.

---

## 8. Inference panel (Phase 4 — build the shell, render-pending)

`ReceiveInference` and `ReceiveStatus` will not fire until the ONNX model and the
debounce state machine are wired on the backend. Build the panel now against the
documented shapes, but render an explicit "model not yet active" state and ensure
the app behaves correctly when these events never arrive. When Phase 4 lands you'll
display `predictedLabel`, a `confidence` bar, and the per-class `scores`. Remember
`ReceiveStatus` is PascalCase (§2.2).

---

## 9. Environment & configuration

- Put the backend origin in a public env var (e.g. `NEXT_PUBLIC_HUB_URL`) so the
  hub URL is build-time configurable across local/staging/prod. Never hardcode it.
- **Prod CORS:** the backend currently reflects any origin with credentials —
  acceptable for local dev, **not** for production. Flag with the backend owner that
  the allowed-origins list must be locked down before any public deployment, and
  ensure the frontend origin is on it.
- **WebSockets behind a proxy:** if you deploy behind a reverse proxy/CDN, confirm
  WebSocket upgrade is allowed end-to-end, or SignalR will silently fall back to
  slower transports.

---

## 10. Suggested build order

1. **Connection shell** — Context provider, connection-status indicator, reconnect
   handling. Verify `RecordingState` arrives on connect.
2. **Recorder panel** — start/stop/label, live counters, drop warning. This is fully
   testable today without hardware (the control path doesn't need a CSI stream).
3. **Live graph** — with the dev mock emitter first, then against real hardware.
4. **Inference panel shell** — render-pending, ready for Phase 4.
5. **Polish** — error/empty/stale states, prod CORS coordination, responsive layout.

Order rationale: 1–2 deliver a working, demonstrable app with zero hardware
dependency; 3 needs the ESP32 loop (or the mock); 4 is gated on backend Phase 4.

---

## 11. Known pitfalls checklist

- [ ] SignalR code never executes during SSR (client components only).
- [ ] Single shared connection, not one per component.
- [ ] StrictMode double-mount handled; cleanup idempotent.
- [ ] `RecordingState` treated as the source of truth for recorder UI.
- [ ] `framesDropped > 0` surfaced as a session-integrity warning.
- [ ] `ReceiveStatus` parsed as **PascalCase**; all other events camelCase.
- [ ] Client-side buffer is bounded (no unbounded growth on long sessions).
- [ ] Render decoupled from event rate (buffer + rAF, not state-per-event).
- [ ] Dev mock (`NEXT_PUBLIC_MOCK_DSP=1`) for `ReceiveDspFrame` when no hardware is streaming.
- [ ] Connection state visible to the user (stale vs empty are different things).

---

## 12. Open questions to settle with the backend before/while building

- **Label vocabulary:** fixed enum of activity classes, or free text? Align with the
  model team's class list.
- **`ReceiveStatus` casing:** normalize to camelCase before Phase 4, or leave and
  special-case it on the client?
- **Graph cadence:** is ~1–2 Hz the intended live-graph rate, or should a separate,
  higher-rate visualization stream exist later? (Affects renderer choice.)
- **Auth:** the hub is currently open (dev CORS, no auth). If the deployment needs
  access control, decide the mechanism (token in the SignalR handshake) early — it
  changes the connection setup.
