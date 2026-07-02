"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useRadar } from "@/context/RadarConnectionProvider";
import { type DspFrame, type DspRx, HubEvent } from "@/lib/types";
import { HeatmapCanvas, type HeatmapHandle } from "@/components/HeatmapCanvas";
import {
  InstantAmplitudeCanvas,
  type InstantAmplitudeHandle,
} from "@/components/InstantAmplitudeCanvas";

// Bounded client-side history: 256 columns ≈ 25 s at the 10 Hz DSP cadence.
const MAX_COLS = 256;

// ── Pairing health (from /health) so a dropped RX is visible, not a frozen panel ──

interface HealthView {
  rx0Rate: number;
  rx1Rate: number;
  pairRate: number;
  pairingRatio: number;
  unpairedRx0: number;
  unpairedRx1: number;
  dspRate: number;
  ok: boolean;
}

function resolveHealthUrl(): string {
  const override = process.env.NEXT_PUBLIC_HUB_URL?.trim();
  if (override) return `${override.replace(/\/$/, "")}/health`;
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:5000/health`;
  }
  return "http://localhost:5000/health";
}

function useDspHealth(): HealthView | null {
  const [health, setHealth] = useState<HealthView | null>(null);
  useEffect(() => {
    let alive = true;
    const url = resolveHealthUrl();
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const j = await res.json();
        const ing = j?.ingestion ?? {};
        const dsp = j?.dsp ?? {};
        if (alive) {
          setHealth({
            rx0Rate: Number(ing.rx0FrameRateHz ?? 0),
            rx1Rate: Number(ing.rx1FrameRateHz ?? 0),
            pairRate: Number(ing.pairRateHz ?? 0),
            pairingRatio: Number(ing.pairingRatio ?? 0),
            unpairedRx0: Number(ing.unpairedRx0 ?? 0),
            unpairedRx1: Number(ing.unpairedRx1 ?? 0),
            dspRate: Number(dsp.frameRateHz ?? 0),
            ok: true,
          });
        }
      } catch {
        if (alive) setHealth((h) => (h ? { ...h, ok: false } : null));
      }
    };
    void poll();
    const id = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return health;
}

// ── One RX's two stacked visuals (amplitude heatmap + centered Doppler spectrogram) ──

interface RxVizHandle {
  push: (rx: DspRx) => void;
}

interface RxVizProps {
  label: string;
  subcarriers: number;
  dopplerBins: number;
  /** null = unknown; true/false = alive per /health frame rate. */
  alive: boolean | null;
}

const RxViz = forwardRef<RxVizHandle, RxVizProps>(function RxViz(
  { label, subcarriers, dopplerBins, alive },
  ref,
) {
  const ampRef = useRef<HeatmapHandle | null>(null);
  const instantRef = useRef<InstantAmplitudeHandle | null>(null);
  const dopRef = useRef<HeatmapHandle | null>(null);
  // Per-panel amplitude render: "heatmap" (time-scroll) or "instant" (latest spectrum).
  // Both are renders of the SAME amplitude[64]; this only picks which one is drawn.
  const [ampView, setAmpView] = useState<"heatmap" | "instant">("heatmap");
  // Display-only EMA on the instant trace (off by default — raw is the honest view).
  const [smooth, setSmooth] = useState(false);
  // A real magnitude spectrum is symmetric, so we mirror the one-sided bins about DC
  // for the classic centered-Doppler look: DC (bin 0) at the middle row.
  const dopplerRows = 2 * dopplerBins - 1;

  useImperativeHandle(
    ref,
    () => ({
      push: (rx: DspRx) => {
        // Feed both amplitude renders the same array; only the mounted one has a
        // non-null ref, so this costs nothing for the hidden view.
        ampRef.current?.push(rx.amplitude);
        instantRef.current?.push(rx.amplitude);
        if (rx.dopplerMean.length === dopplerBins) {
          const mirrored = new Float32Array(dopplerRows);
          const center = dopplerBins - 1;
          for (let r = 0; r < dopplerRows; r++) {
            mirrored[r] = rx.dopplerMean[Math.abs(r - center)];
          }
          dopRef.current?.push(mirrored);
        }
      },
    }),
    [dopplerBins, dopplerRows],
  );

  const aliveDot =
    alive === null ? "bg-slate-500" : alive ? "bg-emerald-400" : "bg-rose-500";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-slate-900/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          {label}
        </h3>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className={`h-2 w-2 rounded-full ${aliveDot}`} />
          {alive === null ? "—" : alive ? "live" : "no frames"}
        </span>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">
            {ampView === "heatmap"
              ? "Amplitude — subcarrier (↓) × time (→)"
              : "Amplitude — subcarrier (→) × |CSI| (↑), latest frame"}
          </p>
          <div className="flex items-center gap-2">
            {ampView === "instant" && (
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-sky-400"
                  checked={smooth}
                  onChange={(e) => setSmooth(e.target.checked)}
                />
                smooth
              </label>
            )}
            <AmpViewToggle view={ampView} onChange={setAmpView} />
          </div>
        </div>
        <div className="h-40 w-full overflow-hidden rounded-md bg-slate-950">
          {ampView === "heatmap" ? (
            <HeatmapCanvas ref={ampRef} rows={subcarriers} maxCols={MAX_COLS} />
          ) : (
            <InstantAmplitudeCanvas
              ref={instantRef}
              bins={subcarriers}
              smooth={smooth}
            />
          )}
        </div>
      </div>

      <div>
        <p className="mb-1 text-[11px] text-slate-500">
          Doppler — 0&nbsp;Hz centered (↕) × time (→)
        </p>
        <div className="h-40 w-full overflow-hidden rounded-md bg-slate-950">
          <HeatmapCanvas ref={dopRef} rows={dopplerRows} maxCols={MAX_COLS} />
        </div>
      </div>
    </div>
  );
});

export function LiveDspPanel() {
  const { on, serverInfo, connectionState, mockActive, hasLiveData } = useRadar();
  const health = useDspHealth();

  const subcarriers = serverInfo?.subcarriers ?? 64;
  const dopplerBins = serverInfo?.dopplerBins ?? 33;
  const cadence = serverInfo?.dopplerCadenceHz ?? 10;

  const rx0Ref = useRef<RxVizHandle | null>(null);
  const rx1Ref = useRef<RxVizHandle | null>(null);

  useEffect(() => {
    const off = on(HubEvent.DspFrame, (payload) => {
      const frame = payload as DspFrame;
      for (const rx of frame.rx) {
        if (rx.rxIndex === 0) rx0Ref.current?.push(rx);
        else if (rx.rxIndex === 1) rx1Ref.current?.push(rx);
      }
    });
    return off;
  }, [on]);

  const stale = connectionState !== "Connected" && !mockActive;
  const rx0Alive = health ? health.rx0Rate > 1 : null;
  const rx1Alive = health ? health.rx1Rate > 1 : null;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Live DSP — per RX
          </h2>
          <p className="text-[11px] text-slate-500">
            amplitude + Doppler, {cadence} Hz · empty room → energy at the 0&nbsp;Hz
            center; walking → it spreads outward
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          {mockActive && (
            <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-fuchsia-300">
              MOCK
            </span>
          )}
          <PairingHealthBadge health={health} />
        </div>
      </header>

      {!hasLiveData && !mockActive && (
        <div className="rounded-lg border border-white/10 bg-slate-800/40 px-3 py-2 text-sm text-slate-400">
          {stale
            ? "Waiting for the hub connection…"
            : "Connected — waiting for DSP frames (no ESP32 streaming, or RX not pairing?). Set NEXT_PUBLIC_MOCK_DSP=1 to develop without hardware."}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RxViz
          ref={rx0Ref}
          label="RX0 (primary)"
          subcarriers={subcarriers}
          dopplerBins={dopplerBins}
          alive={rx0Alive}
        />
        <RxViz
          ref={rx1Ref}
          label="RX1 (secondary)"
          subcarriers={subcarriers}
          dopplerBins={dopplerBins}
          alive={rx1Alive}
        />
      </div>
    </section>
  );
}

// Compact segmented toggle: Heatmap (time-scroll) ↔ Instant (latest spectrum).
function AmpViewToggle({
  view,
  onChange,
}: {
  view: "heatmap" | "instant";
  onChange: (v: "heatmap" | "instant") => void;
}) {
  const opts: Array<{ key: "heatmap" | "instant"; label: string }> = [
    { key: "heatmap", label: "Heatmap" },
    { key: "instant", label: "Instant" },
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={view === o.key}
          className={`px-2 py-0.5 transition-colors ${
            view === o.key
              ? "bg-sky-500/20 text-sky-200"
              : "text-slate-400 hover:bg-white/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PairingHealthBadge({ health }: { health: HealthView | null }) {
  if (!health) {
    return <span className="text-slate-500">health —</span>;
  }
  if (!health.ok) {
    return (
      <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-300">
        /health unreachable
      </span>
    );
  }
  const pct = Math.round(health.pairingRatio * 100);
  const pairTone =
    pct >= 80 ? "text-emerald-300" : pct >= 40 ? "text-amber-300" : "text-rose-300";
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={pairTone} title="pairsEmitted / RX0 frames">
        pairing {pct}%
      </span>
      <span className="text-slate-400" title="per-RX frame rate (Hz)">
        RX0 {health.rx0Rate.toFixed(0)}Hz · RX1 {health.rx1Rate.toFixed(0)}Hz
      </span>
      <span className="text-slate-500" title="unpaired frames dropped per RX">
        unpaired {health.unpairedRx0}/{health.unpairedRx1}
      </span>
    </span>
  );
}
