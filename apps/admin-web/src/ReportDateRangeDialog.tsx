import { useState, type FormEvent } from "react";
import DatePicker from "react-datepicker";
import { tr } from "date-fns/locale/tr";

type Props = {
  start: string;
  end: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onApply: (event: FormEvent) => void;
  onClose: () => void;
};

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function TimeControls({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const initial = new Date(value);
  const [hours, setHours] = useState(String(initial.getHours()).padStart(2, "0"));
  const [minutes, setMinutes] = useState(String(initial.getMinutes()).padStart(2, "0"));
  const edit = (part: "hours" | "minutes", raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    const setDraft = part === "hours" ? setHours : setMinutes;
    if (digits === "") { setDraft(""); return; }
    const number = Number(digits);
    if (number > (part === "hours" ? 23 : 59)) return;
    setDraft(digits);
    const next = new Date(value);
    if (part === "hours") next.setHours(number);
    else next.setMinutes(number);
    onChange(localDateTime(next));
  };
  const normalize = (part: "hours" | "minutes") => {
    const current = new Date(value);
    (part === "hours" ? setHours : setMinutes)(String(part === "hours" ? current.getHours() : current.getMinutes()).padStart(2, "0"));
  };
  return <div className="compact-time-controls" aria-label="Saat ayarı">
    <span>Saat</span>
    <label><span>Saat</span><input aria-label="Saat" type="text" inputMode="numeric" maxLength={2} pattern="[0-9]{1,2}" required value={hours} onFocus={event => event.currentTarget.select()} onChange={event => edit("hours", event.target.value)} onBlur={() => normalize("hours")} /></label>
    <b>:</b>
    <label><span>Dakika</span><input aria-label="Dakika" type="text" inputMode="numeric" maxLength={2} pattern="[0-9]{1,2}" required value={minutes} onFocus={event => event.currentTarget.select()} onChange={event => edit("minutes", event.target.value)} onBlur={() => normalize("minutes")} /></label>
    <small>24 saat biçimi</small>
  </div>;
}

export function ReportDateRangeDialog({ start, end, onStartChange, onEndChange, onApply, onClose }: Props) {
  const [active, setActive] = useState<"start" | "end">("start");
  const [error, setError] = useState("");
  const value = active === "start" ? start : end;
  const change = active === "start" ? onStartChange : onEndChange;
  const selected = new Date(value);
  const validRange = Number.isFinite(new Date(start).getTime()) && Number.isFinite(new Date(end).getTime()) && new Date(start).getTime() <= new Date(end).getTime();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validRange) { setError("Bitiş tarihi ve saati başlangıçtan önce olamaz."); return; }
    onApply(event);
  };

  return <div className="modal-backdrop custom-date-dialog-backdrop">
    <div className="modal-card custom-date-dialog-card compact-date-dialog" role="dialog" aria-modal="true" aria-labelledby="report-date-title">
      <div className="modal-header">
        <h3 id="report-date-title">📆 Özel Tarih ve Saat Aralığı</h3>
        <button type="button" className="icon-btn" aria-label="Kapat" onClick={onClose}>✕</button>
      </div>
      <form onSubmit={submit} className="compact-date-form">
        <div className="compact-date-tabs" role="tablist" aria-label="Tarih seçimi">
          {(["start", "end"] as const).map(part => {
            const date = new Date(part === "start" ? start : end);
            return <button type="button" role="tab" aria-selected={active === part} key={part} className={active === part ? "active" : ""} onClick={() => { setActive(part); setError(""); }}>
              <span>{part === "start" ? "Başlangıç" : "Bitiş"}</span>
              <strong>{date.toLocaleDateString("tr-TR")} · {date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</strong>
            </button>;
          })}
        </div>
        <div className="compact-date-workspace" role="tabpanel" aria-label={active === "start" ? "Başlangıç tarihi ve saati" : "Bitiş tarihi ve saati"}>
          <DatePicker inline selected={selected} onChange={(date: Date | null) => {
            if (!date) return;
            date.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
            change(localDateTime(date));
            setError("");
          }} locale={tr} dateFormat="dd.MM.yyyy" calendarClassName="compact-date-calendar" />
          <TimeControls key={active} value={value} onChange={next => { change(next); setError(""); }} />
        </div>
        {error && <p className="error compact-date-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>İptal</button>
          <button type="submit" className="primary-btn">Uygula</button>
        </div>
      </form>
    </div>
  </div>;
}
