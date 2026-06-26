"use client";

import { RadarConnectionProvider } from "@/context/RadarConnectionProvider";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { RecorderPanel } from "@/components/RecorderPanel";
import { LiveGraphPanel } from "@/components/LiveGraphPanel";
import { InferencePanel } from "@/components/InferencePanel";

export default function Home() {
  return (
    <RadarConnectionProvider>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              CsiRadar
            </h1>
            <p className="text-sm text-slate-500">
              Real-time CSI streaming &amp; recording control
            </p>
          </div>
          <ConnectionStatusIndicator />
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <LiveGraphPanel />
          </div>
          <div className="flex flex-col gap-6">
            <RecorderPanel />
            <InferencePanel />
          </div>
        </div>
      </main>
    </RadarConnectionProvider>
  );
}
