"use client";

import { useRadar } from "@/context/RadarConnectionProvider";
import type { ConnectionState } from "@/lib/types";

const META: Record<
  ConnectionState,
  { label: string; dot: string; text: string }
> = {
  Connected: { label: "Connected", dot: "bg-emerald-400", text: "text-emerald-300" },
  Connecting: { label: "Connecting…", dot: "bg-amber-400 animate-pulse", text: "text-amber-300" },
  Reconnecting: { label: "Reconnecting…", dot: "bg-amber-400 animate-pulse", text: "text-amber-300" },
  Disconnected: { label: "Disconnected", dot: "bg-rose-500", text: "text-rose-300" },
};

export function ConnectionStatusIndicator() {
  const { connectionState } = useRadar();
  const m = META[connectionState];
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${m.dot}`} />
      <span className={`font-medium ${m.text}`}>{m.label}</span>
    </div>
  );
}
