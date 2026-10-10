import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import DatePicker from "react-datepicker";
import { tr } from "date-fns/locale/tr";
import { TimeControls } from "./ReportDateRangeDialog";

export function FilterIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" strokeLinejoin="round" /></svg>;
}

type SelectProps = { value: string | number; onChange: (event: { target: { value: string } }) => void; children: ReactNode; className?: string; style?: CSSProperties; disabled?: boolean; "aria-label"?: string };
export function SiteSelect({ value, onChange, children, className = "", style, disabled, "aria-label": ariaLabel }: SelectProps) {
  const options = Children.toArray(children).filter(isValidElement).map(child => {
    const props = child.props as { value: string | number; children: ReactNode; disabled?: boolean };
    return { value: String(props.value), label: props.children, disabled: props.disabled };
  });
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const selected = options.findIndex(option => option.value === String(value));
  const [highlight, setHighlight] = useState(0);
  const close = () => setPosition(null);
  const open = () => {
    const rect = trigger.current!.getBoundingClientRect();
    const height = Math.min(options.length * 42 + 10, 240);
    const below = window.innerHeight - rect.bottom;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)), width: Math.min(Math.max(rect.width, 180), window.innerWidth - 16), ...(below >= height || below > rect.top ? { top: rect.bottom + 5, maxHeight: Math.max(80, below - 13) } : { bottom: window.innerHeight - rect.top + 5, maxHeight: Math.max(80, rect.top - 13) }) });
    setHighlight(Math.max(0, selected));
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange({ target: { value: option.value } });
    close();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!list.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); document.removeEventListener("scroll", scroll, true); };
  }, [position]);
  useEffect(() => { if (position) list.current?.children[highlight]?.scrollIntoView({ block: "nearest" }); }, [highlight, Boolean(position)]);
  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={Boolean(position)} aria-controls={position ? `${id}-list` : undefined} aria-activedescendant={position ? `${id}-${highlight}` : undefined} disabled={disabled} className={`site-select ${className}`} style={style}
      onClick={() => position ? close() : open()} onBlur={event => { if (!list.current?.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (!position) { open(); return; }
          if (event.key === "Enter" || event.key === " ") choose(highlight);
          else setHighlight(previous => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, previous + (event.key === "ArrowDown" ? 1 : -1))));
        }
      }}>
      <span>{options[selected]?.label ?? "Seçin"}</span><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m5 7 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
    </button>
    {position && createPortal(<div ref={list} id={`${id}-list`} role="listbox" aria-labelledby={id} className="site-select-list" style={position} onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div role="option" aria-selected={index === selected} aria-disabled={option.disabled} id={`${id}-${index}`} key={option.value} className={`site-select-option ${index === highlight ? "highlighted" : ""}`} onMouseEnter={() => setHighlight(index)} onClick={() => choose(index)}><span>{option.label}</span>{index === selected && <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}</div>)}
    </div>, document.body)}
  </>;
}

export function SiteDateTime({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  type PopupPosition = { left: number; top: number; width: number; placement: "bottom" | "left" | "right"; ready: boolean };
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const [draft, setDraft] = useState("");
  const close = () => setPosition(null);
  const open = () => {
    const rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(330, window.innerWidth - 24);
    setDraft(value || (() => { const date = new Date(); date.setHours(0, 0, 0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); })());
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 8, width, placement: "bottom", ready: false });
  };
  useLayoutEffect(() => {
    if (!position || position.ready || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    const below = window.innerHeight - rect.bottom - 12;
    const right = window.innerWidth - rect.right - 12;
    const left = rect.left - 12;
    if (below >= height + 8) {
      setPosition({ ...position, ready: true });
      return;
    }
    if (right >= position.width + 8 || left >= position.width + 8) {
      const placement = right >= position.width + 8 ? "right" : "left";
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - height - 12));
      setPosition({ ...position, placement, left: placement === "right" ? rect.right + 8 : rect.left - position.width - 8, top, ready: true });
      return;
    }
    setPosition({ ...position, ready: true });
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); };
  }, [position]);
  const selected = new Date(draft);
  return <>
    <div className="site-date-filter-field">
      <button ref={trigger} type="button" className="site-date-filter-trigger" aria-label={label} aria-expanded={Boolean(position)} onClick={() => position ? close() : open()}>{value ? new Date(value).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) : "Tarih ve saat seçin"}</button>
      {value && <button type="button" className="site-date-filter-clear" aria-label={`${label} filtresini temizle`} onClick={() => { onChange(""); close(); }}>✕</button>}
    </div>
    {position && createPortal(<div ref={panel} className={`site-date-filter-popup site-date-filter-popup--${position.placement}${position.ready ? " is-ready" : ""}`} role="dialog" aria-label={`${label} seçimi`} style={{ left: position.left, top: position.top, width: position.width, visibility: position.ready ? "visible" : "hidden" }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); trigger.current?.focus(); } }}>
      <div className="site-date-filter-popup-header"><strong>{label}</strong><button type="button" className="icon-btn" aria-label="Takvimi kapat" onClick={close}>✕</button></div>
      <DatePicker inline selected={selected} onChange={(date: Date | null) => { if (!date) return; date.setHours(selected.getHours(), selected.getMinutes(), 0, 0); setDraft(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)); }} locale={tr} dateFormat="dd.MM.yyyy" calendarClassName="compact-date-calendar" />
      <TimeControls value={draft} onChange={setDraft} />
      <div className="site-date-filter-popup-actions"><button type="button" className="secondary compact-btn" onClick={close}>İptal</button><button type="button" className="primary-btn compact-btn" onClick={() => { onChange(draft); close(); }}>Uygula</button></div>
    </div>, document.body)}
  </>;
}
