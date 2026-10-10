import { useEffect, useState } from "react";
import { calculateSessionTotal, elapsedMilliseconds, formatElapsed, type Device } from "@cave/shared";

const statusMeta = {
  bos: { label: "Boş", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30" },
  mesgul: { label: "Meşgul", className: "bg-amber-500/15 text-amber-300 ring-amber-400/30" },
};

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), interval); return () => window.clearInterval(id); }, [interval]);
  return now;
}

export function DeviceCard({ device, onStart, onStop }: {
  device: Device; onStart: () => void; onStop: () => void;
}) {
  const now = useNow();
  const session = device.activeSession;
  const meta = statusMeta[device.status];
  const elapsed = session ? elapsedMilliseconds(session.startedAt, now) : 0;
  const amount = session ? calculateSessionTotal(session.startedAt, session.hourlyRate, session.first30Rate, now) : 0;

  return <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl shadow-black/10">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[.18em] text-slate-500">PlayStation cihazı</p><h2 className="mt-1 text-xl font-bold text-white">{device.name}</h2></div>
      <span className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${meta.className}`}>{meta.label}</span>
    </div>
    {session ? <div className="mt-6 rounded-xl bg-slate-950/70 p-4"><p className="text-sm text-slate-400">Açık oturum</p><p className="mt-1 font-mono text-3xl font-bold tracking-tight text-white">{formatElapsed(elapsed)}</p><p className="mt-2 text-sm text-amber-300">{amount.toFixed(2)} ₺ <span className="text-slate-500">· {session.hourlyRate.toFixed(2)} ₺/saat</span></p></div> : <div className="mt-6 rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-500">Aktif oturum yok</div>}
    <div className="mt-5 flex gap-2">
      {session ? <button onClick={onStop} className="action-button flex-1 bg-rose-500 text-white hover:bg-rose-400">Oturumu bitir</button> : <button onClick={onStart} className="action-button flex-1 bg-indigo-500 text-white hover:bg-indigo-400">Oturum başlat</button>}
    </div>
  </article>;
}
