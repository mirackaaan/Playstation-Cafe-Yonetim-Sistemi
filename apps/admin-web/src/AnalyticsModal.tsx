import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Session } from "./App";
import { analyticsOverview, analyticsProducts, analyticsTables, analyticsTimeline } from "./AnalyticsTools";
import { ReportDateRangeDialog } from "./ReportDateRangeDialog";
import { ReliableButton } from "./ReliableButton";

type Range = { start: string; end: string };
type ReportJump = Range & { deviceId?: string; productName?: string };

const money = (value: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);
const localDateTime = (date: Date, time: "00:00" | "23:59") => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${time}`;

function presetRange(preset: "today" | "yesterday" | "week" | "month"): Range {
  const end = new Date();
  const start = new Date(end);
  if (preset === "yesterday") { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  if (preset === "week") start.setDate(start.getDate() - 6);
  if (preset === "month") start.setDate(start.getDate() - 29);
  return { start: localDateTime(start, "00:00"), end: localDateTime(end, "23:59") };
}

export function AnalyticsModal({ token, onClose, onOpenReport }: { token: string; onClose: () => void; onOpenReport: (jump: ReportJump) => void }) {
  const [range, setRange] = useState<Range>(() => presetRange("today"));
  const [preset, setPreset] = useState<"today" | "yesterday" | "week" | "month" | "custom">("today");
  const [draft, setDraft] = useState<Range>(range);
  const [dateDialog, setDateDialog] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [productMetric, setProductMetric] = useState<"quantity" | "amount">("quantity");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = `?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`;
    fetch(`/api/reports${query}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Analizler yüklenemedi.");
        return data as { sessions: Session[] };
      })
      .then(data => setSessions(data.sessions))
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Analizler yüklenemedi."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, range.start, range.end, refresh]);

  const overview = useMemo(() => analyticsOverview(sessions, range.start, range.end), [sessions, range]);
  const topTables = useMemo(() => analyticsTables(sessions).slice(0, 8), [sessions]);
  const products = useMemo(() => analyticsProducts(sessions, range.start, range.end), [sessions, range]);
  const topProducts = useMemo(() => [...products].sort((a, b) => b[productMetric] - a[productMetric]).slice(0, 8), [products, productMetric]);
  const timeline = useMemo(() => analyticsTimeline(sessions, range.start, range.end), [sessions, range]);
  const periodLabel = timeline.granularity === "hour" ? "Saatlik" : timeline.granularity === "day" ? "Günlük" : "Aylık";
  const duration = `${Math.floor(overview.playMinutes / 60)} sa ${overview.playMinutes % 60} dk`;
  const detail = (filter: Omit<ReportJump, keyof Range>) => onOpenReport({ ...range, ...filter });
  const chartTooltip = { backgroundColor: "rgba(15, 23, 42, .98)", border: "1px solid #36506e", borderRadius: 10, color: "#e2e8f0" };

  const selectPreset = (next: "today" | "yesterday" | "week" | "month") => { setPreset(next); setRange(presetRange(next)); };
  const applyCustom = (event: FormEvent) => { event.preventDefault(); setPreset("custom"); setRange(draft); setDateDialog(false); };

  return <div className="modal-backdrop">
    <div className={`modal-card wide reports-modal analytics-modal ${fullscreen ? "fullscreen-modal" : ""}`}>
      <div className="modal-header">
        <div className="analytics-heading"><h3>📈 Analizler</h3><button type="button" className="secondary compact-btn" onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? "🗗 Normal Boyut" : "⛶ Tam Ekran"}</button></div>
        <ReliableButton type="button" className="icon-btn analytics-close-btn" onActivate={onClose} aria-label="Analizleri kapat">✕</ReliableButton>
      </div>
      <div className="analytics-controls">
        <div className="analytics-periods" aria-label="Analiz dönemi">
          {([ ["today", "Bugün"], ["yesterday", "Dün"], ["week", "Son 7 Gün"], ["month", "Son 30 Gün"] ] as const).map(([value, label]) => <button key={value} type="button" className={`secondary compact-btn ${preset === value ? "analytics-active" : ""}`} onClick={() => selectPreset(value)}>{label}</button>)}
          <button type="button" className={`secondary compact-btn ${preset === "custom" ? "analytics-active" : ""}`} onClick={() => { setDraft(range); setDateDialog(true); }}>📅 Özel Tarih</button>
        </div>
        <button type="button" className="secondary compact-btn" onClick={() => setRefresh(value => value + 1)}>↻ Yenile</button>
      </div>
      <div className="analytics-range-label">{new Date(range.start).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} – {new Date(range.end).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })}</div>
      {error && <p className="error notice">{error}</p>}
      {loading ? <div className="loading" style={{ padding: "2rem" }}>Analizler yükleniyor...</div> : !error && <div className="modal-body analytics-dashboard">
        <div className="analytics-kpis">
          <div className="analytics-kpi"><span>Tahsilat</span><strong>{money(overview.tahsilat)}</strong><small>Seçilen dönemde alınan ödemeler</small></div>
          <div className="analytics-kpi"><span>Tamamlanan masa</span><strong>{overview.closedCount}</strong><small>Ücretsiz kapanışlar dahil</small></div>
          <div className="analytics-kpi"><span>Ort. kapanan hesap</span><strong>{money(overview.averageBill)}</strong><small>Ücretsiz hesaplar hariç</small></div>
          <div className="analytics-kpi"><span>Oyun süresi</span><strong>{duration}</strong><small>Seçilen döneme düşen süre</small></div>
        </div>

        <section className="chart-card analytics-ranking"><div className="analytics-card-title"><h4>🎮 En Yüksek Oyun Ücretli Masalar</h4><small>Kapanan ilk 8 masa · ücretsiz hariç</small></div>
          {topTables.length ? <div className="analytics-rank-list">{topTables.map(item => <button type="button" key={item.deviceId} className="analytics-rank-row" onClick={() => detail({ deviceId: item.deviceId })}><span className="analytics-rank-label">{item.name}</span><span className="analytics-rank-track"><span style={{ width: `${Math.max(2, item.ciro / topTables[0].ciro * 100)}%` }} /></span><strong>{money(item.ciro)}</strong></button>)}</div> : <p className="analytics-empty">Bu dönemde kapanan ücretli masa yok.</p>}
        </section>

        <section className="chart-card analytics-ranking"><div className="analytics-card-title"><h4>🍟 En Çok Sipariş Edilen Ürünler</h4><div className="analytics-switch"><button type="button" className={productMetric === "quantity" ? "active" : ""} onClick={() => setProductMetric("quantity")}>Adet</button><button type="button" className={productMetric === "amount" ? "active" : ""} onClick={() => setProductMetric("amount")}>Tutar</button></div></div>
          {topProducts.length ? <div className="analytics-rank-list">{topProducts.map(item => <button type="button" key={item.name} className="analytics-rank-row" onClick={() => detail({ productName: item.name })}><span className="analytics-rank-label">{item.name}</span><span className="analytics-rank-track product"><span style={{ width: `${Math.max(2, item[productMetric] / topProducts[0][productMetric] * 100)}%` }} /></span><strong>{productMetric === "quantity" ? `${item.quantity} adet` : money(item.amount)}</strong></button>)}</div> : <p className="analytics-empty">Bu dönemde sipariş yok.</p>}
          <small className="analytics-footnote">Sipariş zamanı esas alınır; henüz tahsil edilmemiş adisyonlar dahil.</small>
        </section>

        <section className="chart-card analytics-wide"><div className="analytics-card-title"><h4>💰 {periodLabel} Tahsil Edilen Tutar</h4><small>Ödemenin alındığı zamana göre · ₺</small></div>
          <div className="analytics-plot"><ResponsiveContainer><BarChart data={timeline.points} margin={{ top: 12, right: 20, left: 10, bottom: 10 }}><CartesianGrid strokeDasharray="3 3" stroke="#2e1a26" vertical={false} /><XAxis dataKey="label" stroke="#9aa1b2" minTickGap={30} /><YAxis stroke="#9aa1b2" tickFormatter={(value: number) => `${value} ₺`} /><Tooltip cursor={false} contentStyle={chartTooltip} formatter={value => [money(Number(value ?? 0)), "Tahsil edilen"]} labelFormatter={(_label, payload) => payload?.[0]?.payload?.key ?? ""} /><Bar dataKey="tahsilat" fill="#34d399" radius={[4, 4, 0, 0]} maxBarSize={42} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
        </section>

        <section className="chart-card analytics-wide"><div className="analytics-card-title"><h4>🟢 Ortalama Açık Masa Sayısı</h4><small>{periodLabel} · açık kalınan süreye göre</small></div>
          <div className="analytics-plot"><ResponsiveContainer><LineChart data={timeline.points} margin={{ top: 12, right: 20, left: 10, bottom: 10 }}><CartesianGrid strokeDasharray="3 3" stroke="#2e1a26" vertical={false} /><XAxis dataKey="label" stroke="#9aa1b2" minTickGap={30} /><YAxis stroke="#9aa1b2" /><Tooltip contentStyle={chartTooltip} formatter={value => [`${Number(value ?? 0).toLocaleString("tr-TR", { maximumFractionDigits: 2 })} masa`, "Ort. açık masa"]} labelFormatter={(_label, payload) => payload?.[0]?.payload?.key ?? ""} /><Line type="linear" dataKey="doluMasa" stroke="#60a5fa" strokeWidth={3} dot={timeline.points.length <= 31} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>
        </section>
      </div>}
    </div>
    {dateDialog && <ReportDateRangeDialog start={draft.start} end={draft.end} onStartChange={value => setDraft(previous => ({ ...previous, start: value }))} onEndChange={value => setDraft(previous => ({ ...previous, end: value }))} onApply={applyCustom} onClose={() => setDateDialog(false)} />}
  </div>;
}