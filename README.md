# CsiRadar Frontend

Thin real-time client for the `CsiRadar.Backend` SignalR pipeline. See
[FRONTEND_README.md](./FRONTEND_README.md) for the full backend contract.

## Stack

- **Next.js (App Router)** + React 19, TypeScript
- **@microsoft/signalr** — single long-lived hub connection
- **uPlot** — streaming live graph (rAF-driven, bounded buffer)
- **Tailwind CSS v4**

## Run

```bash
npm install
cp .env.local.example .env.local   # then edit
npm run dev
```

| Env var | Meaning |
|---|---|
| `NEXT_PUBLIC_HUB_URL` | Backend origin; hub is at `{origin}/hubs/radar` |
| `NEXT_PUBLIC_MOCK_CSI` | `1` → local synthetic CSI emitter (develop the graph with no ESP32) |

## Architecture

- [`src/context/RadarConnectionProvider.tsx`](src/context/RadarConnectionProvider.tsx) —
  owns the singleton connection (auto-reconnect, StrictMode-safe, idempotent
  cleanup), exposes `connectionState`, `recordingStatus`, `start/stop`, and a
  local `on(event, handler)` bus that bridges both real hub events and the mock.
- [`src/components/LiveGraphPanel.tsx`](src/components/LiveGraphPanel.tsx) —
  spectrum + rolling time view. Events land in refs; a `requestAnimationFrame`
  loop reads them (render decoupled from event rate). Buffer bounded to
  `MAX_TIME_POINTS`. Y-axis auto-scales (amplitudes can be negative).
- [`src/components/RecorderPanel.tsx`](src/components/RecorderPanel.tsx) —
  driven entirely off `RecordingState`; live `framesCaptured`/elapsed, prominent
  `framesDropped` warning.
- [`src/components/InferencePanel.tsx`](src/components/InferencePanel.tsx) —
  Phase-4 shell; "model not yet active" until `ReceiveInference` fires.
  Handles the PascalCase `ReceiveStatus` quirk.

`RecordingState` is the single source of truth — multiple tabs stay in sync.
```
