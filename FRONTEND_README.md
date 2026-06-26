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
| `ReceiveCsiData` | `{ timestampMs, rssi, subcarrierCount, amplitudes[] }` | camelCase | ~1–2 Hz (one per SlideStep) | **Live** (when ESP32 streams) |
| `RecordingState` | `{ isRecording, sessionId, label, framesCaptured, framesDropped, startedAtUnixMs }` | camelCase | On connect + every start/stop | **Live now** |
| `ReceiveInference` | `{ predictedLabel, confidence, scores{label:number}, timestampMs }` | camelCase | Per window | **Pending (Phase 4)** — won't fire until the ONNX model + debounce are wired |
| `ReceiveStatus` | `{ Status, Timestamp }` | **PascalCase** ⚠️ | On confirmed automation change | **Pending (Phase 4)** |

**Casing gotcha (read this twice).** Typed DTOs are camelCased via explicit
serializer attributes. `ReceiveStatus` is sent as an anonymous object with **no**
attributes, so it arrives **PascalCase** (`Status`, `Timestamp`) — inconsistent
with every other event. Handle it as-is on the client, or raise it with the backend
to normalize before Phase 4 lands. Don't let it silently break a typed mapping.

### 2.3 `ReceiveCsiData` payload semantics

- `amplitudes` is **one filtered value per subcarrier** for the latest frame —
  i.e. an amplitude-vs-subcarrier vector at a single instant, length
  `subcarrierCount`.
- Values are **baseline-subtracted and low-pass filtered**, so they **can be
  negative**. Do not assume a non-negative y-axis.
- This is emitted once per processing window slide, **not** at the full 100 Hz
  ingest rate. At `SlideStep = 50` that is ~2 Hz; at `100` it is ~1 Hz. The live
  graph is therefore comfortably renderable — you are not fighting a firehose.
- `rssi` (dBm, negative) and `timestampMs` (Unix ms) accompany each frame.

Two reasonable visualizations from this payload:
- **Spectrum view:** plot `amplitudes` vs subcarrier index, refreshed each event.
- **Time view (waterfall/line):** pick one or a few subcarriers and append their
  values to a client-side rolling buffer over time.

### 2.4 Client → server methods (call with `connection.invoke`)

| Method | Args | Returns |
|---|---|---|
| `StartRecording` | `label: string` (blank → `"unlabeled"`) | `RecordingStatus` |
| `StopRecording` | — | `RecordingStatus` |
| `GetRecordingStatus` | — | `RecordingStatus` |

`Start`/`Stop` both return the resulting `RecordingStatus` to the caller **and**
broadcast it to all clients via `RecordingState`. So you can either use the invoke
return value or rely on the broadcast — prefer treating `RecordingState` as the
single source of truth so multiple open tabs/clients stay consistent.

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
- **Live graph panel** — subscribes to `ReceiveCsiData`, owns a client-side rolling
  buffer, renders the chart. Self-contained.
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
- **Negative values.** Auto-scale the y-axis or center it on zero; baseline
  subtraction makes amplitudes swing both ways.
- **Dev without hardware = no `ReceiveCsiData`.** With no ESP32 transmitting, the
  graph stream is silent. Build a small mock emitter (a local interval pushing
  synthetic frames in the same shape) behind a dev flag so you can develop the chart
  without the full hardware loop running. Coordinate the exact shape from §2.2/§2.3.

---

## 7. Recording UX flow

The interaction loop is deliberately simple because the backend owns the hard parts:

1. User types a **label** (the activity class: e.g. `Walking`, `EmptyRoom`,
   `LyingOnCouch`) and presses **Start**.
2. Client `invoke("StartRecording", label)`; UI flips to a recording state driven by
   the returned/broadcast `RecordingStatus`.
3. While recording, show **live `framesCaptured`** (and elapsed time from
   `startedAtUnixMs`) so the user has feedback that data is flowing.
4. **Surface `framesDropped` prominently if non-zero** — a dropped frame flags the
   session incomplete in its server-side manifest, so the user should know to redo
   the take. This is a first-class signal, not a footnote.
5. **Stop** → `invoke("StopRecording")`; the server finalizes the file + manifest.

Guardrails:
- Disable Start while `isRecording` is true (and Stop while idle) — drive both off
  `RecordingState`, never off optimistic local state alone.
- Because state is server-authoritative and broadcast to all clients, two open tabs
  stay in sync for free if you treat `RecordingState` as the source of truth.
- Consider a fixed label set (dropdown) over free text to keep class names
  consistent for the training set — the model team will thank you. The backend
  sanitizes labels for filenames regardless, so free text is safe, just messier.

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
- [ ] Graph y-axis tolerates negative (baseline-subtracted) amplitudes.
- [ ] Client-side buffer is bounded (no unbounded growth on long sessions).
- [ ] Render decoupled from event rate (buffer + rAF, not state-per-event).
- [ ] Dev mock for `ReceiveCsiData` when no hardware is streaming.
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
