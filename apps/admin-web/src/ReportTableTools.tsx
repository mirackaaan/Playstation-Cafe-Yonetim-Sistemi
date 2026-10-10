import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "./App";
import { FilterIcon, SiteDateTime, SiteSelect } from "./SiteControls";

const columns = { table: "Masa & Çeşit", start: "Açılış Saati", end: "Kapanış Saati", duration: "Süre", package: "Kol & Paket", orders: "Adisyon", payment: "Ödeme & Tutar" };
type Column = keyof typeof columns;
const labels = { startMin: "Açılış başlangıcı", startMax: "Açılış sonu", endMin: "Kapanış başlangıcı", endMax: "Kapanış sonu", status: "Durum", durationMin: "En az dakika", durationMax: "En fazla dakika", controllers: "Kol", package: "Paket", orders: "Adisyon", ordersMin: "En az adisyon ₺", ordersMax: "En fazla adisyon ₺", method: "Ödeme", amountMin: "En az hesap ₺", amountMax: "En fazla hesap ₺" };
type FilterKey = keyof typeof labels;
type Filters = Partial<Record<FilterKey, string>>;
type PopoverPosition = { left: number; top: number; width: number; ready: boolean };
const values: Record<string, string> = { open: "Açık", closed: "Kapanmış", timed: "Süreli", unlimited: "Süresiz", yes: "Var", no: "Yok", nakit: "Nakit", kredi_karti: "Kredi kartı", mixed: "Karma ödeme", ucretsiz: "Ücretsiz" };
const keys: Record<Column, FilterKey[]> = { table: [], start: ["startMin", "startMax"], end: ["status", "endMin", "endMax"], duration: ["durationMin", "durationMax"], package: ["controllers", "package"], orders: ["orders", "ordersMin", "ordersMax"], payment: ["method", "amountMin", "amountMax"] };
const rangePairs: [FilterKey, FilterKey][] = [["startMin", "startMax"], ["endMin", "endMax"], ["durationMin", "durationMax"], ["ordersMin", "ordersMax"], ["amountMin", "amountMax"]];
function hasInvalidRange(filters: Filters) {
  return rangePairs.some(([min, max]) => {
    if (!filters[min] || !filters[max]) return false;
    const number = (value: string) => min.startsWith("start") || min.startsWith("end") ? Date.parse(value) : Number(value);
    return number(filters[min]!) > number(filters[max]!);
  });
}

export function reportDuration(s: Session, at: number) {
  if (s.deviceId == null) return 0;
  const start = Date.parse(s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : at;
  return Math.max(1, Math.round(((s.targetMinutes ? Math.min(end, start + s.targetMinutes * 60000) : end) - start) / 60000));
}

function paymentMethods(s: Session) {
  const payments = s.ledgerPayments?.length ? s.ledgerPayments : s.periodPayments?.length ? s.periodPayments : s.partialPayments ?? [];
  const totals = new Map<string, number>();
  for (const p of payments) totals.set(p.paymentMethod, (totals.get(p.paymentMethod) ?? 0) + p.amount);
  if (!payments.length) {
    if (s.paymentMethod && (s.endedAt || s.isPaid)) totals.set(s.paymentMethod, 1);
    if (s.checkoutPaymentMethod && (s.checkoutAmount ?? 0) > 0) totals.set(s.checkoutPaymentMethod, 1);
  }
  return { cash: (totals.get("nakit") ?? 0) > 0.001, card: (totals.get("kredi_karti") ?? 0) > 0.001 };
}

export function reportDeviceLabels(sessions: Session[], devices: { id: number; name: string }[] = []) {
  const names = new Map(devices.map(device => [String(device.id), device.name]));
  for (const session of sessions) {
    if (session.deviceId == null) continue;
    const id = String(session.deviceId);
    if (!names.has(id)) names.set(id, session.deviceName || `Silinmiş masa #${id}`);
  }
  const nameCounts = new Map<string, number>();
  for (const name of names.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  return new Map([...names].map(([id, name]) => [id, (nameCounts.get(name) ?? 0) > 1 ? `${name} · #${id}` : name]));
}

export function reportRevenueByDevice(sessions: Session[]) {
  const labels = reportDeviceLabels(sessions);
  const totals = new Map<string, { name: string; ciro: number }>();
  for (const session of sessions) {
    const amount = (session.periodPayments ?? []).filter(payment => payment.paymentMethod !== "ucretsiz").reduce((sum, payment) => sum + payment.amount, 0);
    if (amount === 0) continue;
    const id = session.deviceId == null ? "direct-sale" : String(session.deviceId);
    const name = id === "direct-sale" ? "Direkt Adisyon Satışı" : labels.get(id) ?? session.deviceName ?? `Silinmiş masa #${id}`;
    const current = totals.get(id);
    totals.set(id, { name, ciro: (current?.ciro ?? 0) + amount });
  }
  return [...totals.values()].map(({ name, ciro }) => ({ name, ciro: Math.round(ciro * 100) / 100 })).sort((a, b) => b.ciro - a.ciro);
}

export function filterReport(s: Session, f: Filters, at: number) {
  const range = (value: number, min?: string, max?: string) => (!min || value >= Number(min)) && (!max || value <= Number(max));
  const dateRange = (value: string | null | undefined, min?: string, max?: string) => (!min && !max) || Boolean(value && (!min || Date.parse(value) >= Date.parse(min)) && (!max || Date.parse(value) < Date.parse(max) + 60000));
  if (!dateRange(s.startedAt, f.startMin, f.startMax) || !dateRange(s.endedAt, f.endMin, f.endMax)) return false;
  if (f.status && (f.status === "open") !== !s.endedAt) return false;
  if ((f.durationMin || f.durationMax) && s.deviceId == null) return false;
  if (!range(reportDuration(s, at), f.durationMin, f.durationMax)) return false;
  if (f.controllers && (s.deviceId == null || s.controllerCount !== Number(f.controllers))) return false;
  if (f.package && (s.deviceId == null || (f.package === "timed") !== Boolean(s.targetMinutes))) return false;
  if (f.orders && (f.orders === "yes") !== ((s.ordersTotal ?? 0) > 0)) return false;
  if (!range(s.ordersTotal ?? 0, f.ordersMin, f.ordersMax) || !range(s.totalAmount ?? 0, f.amountMin, f.amountMax)) return false;
  const methods = paymentMethods(s);
  if (f.method === "nakit" && !methods.cash || f.method === "kredi_karti" && !methods.card || f.method === "mixed" && !(methods.cash && methods.card) || f.method === "ucretsiz" && s.closureMethod !== "ucretsiz" && s.paymentMethod !== "ucretsiz") return false;
  return true;
}

export function useReportTable(sessions: Session[], devices: { id: number; name: string }[], at: number, initial?: { start: string; end: string; deviceId?: string; productName?: string }) {
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<string[]>(initial?.deviceId ? [initial.deviceId] : []);
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<Column | null>(null);
  const [draftFilters, setDraftFilters] = useState<Filters>({});
  const [draftSelected, setDraftSelected] = useState<string[]>([]);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLElement>(null);
  const [sort, setSort] = useState<{ column: Column; direction: number } | null>(null);
  const [product, setProduct] = useState(initial?.productName ?? "");
  const deviceLabels = useMemo(() => reportDeviceLabels(sessions, devices), [sessions, devices]);
  const tableOptions = useMemo<[string, string][]>(() => [...deviceLabels.entries(), ["direct-sale", "Direkt Adisyon Satışı"]], [deviceLabels]);
  const filteredSessions = useMemo(() => sessions.filter(s => (!selected.length || selected.includes(s.deviceId == null ? "direct-sale" : String(s.deviceId))) && (!product || (s.orderItems ?? []).some(item => item.productName === product && (!initial || (Date.parse(item.createdAt ?? s.startedAt) >= Date.parse(initial.start) && Date.parse(item.createdAt ?? s.startedAt) < Date.parse(initial.end) + 60_000)))) && filterReport(s, filters, at)).sort((a, b) => {
    if (!sort) return Number(Boolean(a.endedAt)) - Number(Boolean(b.endedAt)) || Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt);
    if (sort.column === "table") return sort.direction * (a.deviceName ?? "").localeCompare(b.deviceName ?? "", "tr", { numeric: true });
    const value = (s: Session) => {
      switch (sort.column) {
        case "start": return Date.parse(s.startedAt);
        case "end": return s.endedAt ? Date.parse(s.endedAt) : null;
        case "duration": return s.deviceId == null ? null : reportDuration(s, at);
        case "package": return s.deviceId == null ? null : s.controllerCount;
        case "orders": return s.ordersTotal ?? 0;
        default: return s.totalAmount ?? 0;
      }
    };
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    return sort.direction * (av - bv);
  }), [sessions, filters, selected, product, sort, at, initial]);
  const update = (key: FilterKey, value: string) => setFilters(previous => ({ ...previous, [key]: value }));
  const updateDraft = (key: FilterKey, value: string) => setDraftFilters(previous => ({ ...previous, [key]: value }));
  const closePanel = () => { setPanel(null); setPopoverPosition(null); };
  const openPanel = (column: Column, button: HTMLButtonElement) => {
    if (panel === column) { closePanel(); return; }
    panelTrigger.current = button;
    const rect = button.getBoundingClientRect();
    const width = Math.min(column === "table" ? 330 : 380, window.innerWidth - 24);
    setDraftFilters({ ...filters });
    setDraftSelected([...selected]);
    setSearch("");
    setPopoverPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 6, width, ready: false });
    setPanel(column);
  };
  useLayoutEffect(() => {
    if (!panel || !popoverPosition || popoverPosition.ready || !panelElement.current || !panelTrigger.current) return;
    const rect = panelTrigger.current.getBoundingClientRect();
    const height = panelElement.current.offsetHeight;
    const top = rect.bottom + height + 18 <= window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
    setPopoverPosition({ ...popoverPosition, top, ready: true });
  }, [panel, popoverPosition]);
  useEffect(() => {
    if (!panel) return;
    const inNestedPopup = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".site-select-list, .site-date-filter-popup"));
    const outside = (event: PointerEvent) => {
      if (!panelElement.current?.contains(event.target as Node) && !panelTrigger.current?.contains(event.target as Node) && !inNestedPopup(event.target)) closePanel();
    };
    const scroll = (event: Event) => {
      if (!panelElement.current?.contains(event.target as Node) && !inNestedPopup(event.target)) closePanel();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", closePanel);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", closePanel); };
  }, [panel]);
  const applyPanel = () => {
    setFilters(draftFilters);
    if (panel === "table") setSelected(draftSelected);
    closePanel();
  };
  const chooseSingle = (key: FilterKey, value: string) => {
    const next = { ...draftFilters, [key]: value };
    if (hasInvalidRange(next)) { setDraftFilters(next); return; }
    setFilters(next);
    closePanel();
  };
  const active = Object.values(filters).some(Boolean) || selected.length > 0 || Boolean(product);
  const invalidRange = hasInvalidRange(draftFilters);
  const range = (min: FilterKey, max: FilterKey, type = "number") => <div className="report-filter-range">{[min, max].map(key => <label key={key}>{labels[key]}{type === "datetime-local" ? <SiteDateTime label={labels[key]} value={draftFilters[key] ?? ""} onChange={value => updateDraft(key, value)} /> : <input type="number" min="0" step="any" value={draftFilters[key] ?? ""} onChange={e => updateDraft(key, e.target.value)} />}</label>)}</div>;
  const select = (key: FilterKey, options: string[]) => <label>{labels[key]}<SiteSelect aria-label={labels[key]} value={draftFilters[key] ?? ""} onChange={e => chooseSingle(key, e.target.value)}><option value="">Tümü</option>{options.map(value => <option key={value} value={value}>{values[value] ?? value}</option>)}</SiteSelect></label>;
  const headers = (Object.entries(columns) as [Column, string][]).map(([column, label]) => <th key={column} aria-sort={sort?.column === column ? sort.direction === 1 ? "ascending" : "descending" : "none"}>
    <div className="report-column-heading"><button type="button" className="report-sort-button" data-site-tooltip={`${label}: sıralamayı değiştir`} onClick={() => setSort(previous => previous?.column !== column ? { column, direction: 1 } : previous.direction === 1 ? { column, direction: -1 } : null)}>{label}<span>{sort?.column === column ? sort.direction === 1 ? "↑" : "↓" : "↕"}</span></button>
      <button type="button" className={`report-filter-button ${(column === "table" ? selected.length > 0 : keys[column].some(key => filters[key])) ? "active" : ""}`} aria-label={`${label} filtresi`} aria-haspopup="dialog" aria-expanded={panel === column} onClick={event => openPanel(column, event.currentTarget)}><FilterIcon /></button></div>
  </th>);
  const toolbar = <div className="report-tools">
    <div className="report-filter-summary"><strong>{filteredSessions.length} kayıt gösteriliyor · Toplam {sessions.length}</strong>
      {selected.map(id => <button type="button" key={id} className="report-filter-chip" onClick={() => setSelected(previous => previous.filter(value => value !== id))}>{tableOptions.find(([value]) => value === id)?.[1] ?? id} ×</button>)}
      {product && <button type="button" className="report-filter-chip" onClick={() => setProduct("")}>Ürün: {product} ×</button>}
      {(Object.entries(filters) as [FilterKey, string][]).filter(([, value]) => value).map(([key, value]) => <button type="button" key={key} className="report-filter-chip" onClick={() => update(key, "")}>{labels[key]}: {values[value] ?? (key.startsWith("start") || key.startsWith("end") ? new Date(value).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) : value)} ×</button>)}
      {active && <button type="button" className="secondary compact-btn" onClick={() => { setFilters({}); setSelected([]); setSearch(""); setProduct(""); }}>Filtreleri Temizle</button>}
      {sort && <button type="button" className="secondary compact-btn" onClick={() => setSort(null)}>Varsayılan Sıralama</button>}
    </div>
    {panel && popoverPosition && createPortal(<section ref={panelElement} role="dialog" className="report-filter-panel report-filter-popover" aria-label={`${columns[panel]} filtreleri`} style={{ left: popoverPosition.left, top: popoverPosition.top, width: popoverPosition.width, visibility: popoverPosition.ready ? "visible" : "hidden" }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); panelTrigger.current?.focus(); } }}>
      <div className="report-filter-panel-title"><strong>{columns[panel]} filtresi</strong><button type="button" className="icon-btn" aria-label="Filtreyi kapat" onClick={closePanel}>✕</button></div>
      {panel === "table" ? <><input aria-label="Masa ara" placeholder="Masa adıyla ara…" value={search} onChange={e => setSearch(e.target.value)} /><div className="report-table-options">{tableOptions.filter(([, name]) => name.toLocaleLowerCase("tr-TR").includes(search.toLocaleLowerCase("tr-TR"))).map(([id, name]) => <label key={id}><input type="checkbox" checked={draftSelected.includes(id)} onChange={e => setDraftSelected(previous => e.target.checked ? [...previous, id] : previous.filter(value => value !== id))} />{name}</label>)}</div><small>Seçim yoksa tüm masalar gösterilir.</small></> : <div className="report-filter-fields">
        {panel === "start" && range("startMin", "startMax", "datetime-local")}
        {panel === "end" && <>{select("status", ["open", "closed"])}{range("endMin", "endMax", "datetime-local")}</>}
        {panel === "duration" && range("durationMin", "durationMax")}
        {panel === "package" && <>{select("controllers", ["1", "2", "3", "4"])}{select("package", ["timed", "unlimited"])}</>}
        {panel === "orders" && <>{select("orders", ["yes", "no"])}{range("ordersMin", "ordersMax")}</>}
        {panel === "payment" && <>{select("method", ["nakit", "kredi_karti", "mixed", "ucretsiz"])}{range("amountMin", "amountMax")}</>}
      </div>}
      <small>Filtreler seçili rapor dönemindeki kayıtlara uygulanır.{panel === "payment" && " Tutar aralığı hesap toplamıdır. Nakit ve kart filtreleri karma ödemeleri de içerir."}</small>
      {(panel === "table" || panel === "start" || panel === "end" || panel === "duration" || panel === "orders" || panel === "payment") && <div className="report-filter-panel-actions"><button type="button" className="primary-btn compact-btn" disabled={invalidRange} onClick={applyPanel}>Uygula</button></div>}
      {invalidRange && <p className="error" role="alert">Başlangıç veya alt sınır, bitişten veya üst sınırdan büyük olamaz.</p>}
    </section>, document.body)}
    {active && <small>Özetler filtrelenen kayıtların seçili dönemdeki tahsilatlarını gösterir; nakit ve kart ayrı hesaplanır.</small>}
  </div>;
  return { filteredSessions, toolbar, headers, active, deviceLabels };
}
