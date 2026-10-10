import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Device } from "@cave/shared";
import { DeviceCard } from "./components/DeviceCard";
import { salonApi } from "./lib/api";

export function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [hourlyRate, setHourlyRate] = useState(100);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => { setError(null); try { setDevices(await salonApi.listDevices()); } catch (e) { setError(String(e)); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); salonApi.getHourlyRate().then(setHourlyRate).catch((e) => setError(String(e))); }, []);
  const summary = useMemo(() => ({ empty: devices.filter((d) => d.status === "bos").length, busy: devices.filter((d) => d.status === "mesgul").length }), [devices]);
  const addDevice = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; await salonApi.addDevice(name.trim()); setName(""); await refresh(); };
  const saveRate = async () => { await salonApi.setHourlyRate(hourlyRate); await refresh(); };
  const run = async (action: () => Promise<unknown>) => { try { setError(null); await action(); await refresh(); } catch (e) { setError(String(e)); } };
  if (loading) return <main className="grid min-h-screen place-items-center bg-slate-950 text-slate-300">Salon verileri yükleniyor…</main>;
  return <main className="min-h-screen bg-slate-950 text-slate-100"><div className="mx-auto max-w-7xl px-5 py-8 sm:px-8">
    <header className="flex flex-col justify-between gap-6 border-b border-slate-800 pb-8 md:flex-row md:items-end"><div><p className="text-sm font-bold uppercase tracking-[.25em] text-indigo-400">Cave</p><h1 className="mt-2 text-3xl font-black tracking-tight text-white">Salon Yönetimi</h1><p className="mt-2 text-slate-400">Cihazlar ve açık oturumlar bu bilgisayarda güvenle saklanır.</p></div><div className="flex flex-wrap gap-2 text-sm"><span className="stat-pill text-emerald-300">{summary.empty} boş</span><span className="stat-pill text-amber-300">{summary.busy} meşgul</span></div></header>
    {error && <p className="mt-5 rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">İşlem yapılamadı: {error}</p>}
    <section className="mt-7 grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 lg:grid-cols-[1fr_auto]"><form onSubmit={(e) => void addDevice(e)} className="flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="device-name">Cihaz adı</label><input id="device-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn. PS5 - 1" className="input" /><button className="action-button bg-white text-slate-900 hover:bg-slate-200">Cihaz ekle</button></form><div className="flex items-center gap-2"><label htmlFor="hourly-rate" className="whitespace-nowrap text-sm text-slate-400">Saatlik ücret</label><input id="hourly-rate" min="0" step="1" type="number" value={hourlyRate} onChange={(e) => setHourlyRate(Number(e.target.value))} className="input w-24" /><span className="text-slate-400">₺</span><button onClick={() => void saveRate()} className="action-button border border-slate-700 text-slate-200 hover:border-slate-500">Kaydet</button></div></section>
    <section className="mt-7"><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold text-white">Cihazlar</h2><button onClick={() => void refresh()} className="text-sm text-indigo-300 hover:text-indigo-200">Yenile</button></div>{devices.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{devices.map((device) => <DeviceCard key={device.id} device={device} onStart={() => void run(() => salonApi.startSession(device.id))} onStop={() => void run(() => salonApi.stopSession(device.id))} />)}</div> : <div className="rounded-2xl border border-dashed border-slate-700 p-12 text-center text-slate-500">İlk cihazınızı ekleyerek başlayın.</div>}</section>
  </div></main>;
}
