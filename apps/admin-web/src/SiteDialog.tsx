import { useEffect, useRef, useSyncExternalStore } from "react";

type DialogOptions = { title?: string; confirmLabel?: string; danger?: boolean };
type DialogRequest = DialogOptions & { message: string; confirmation: boolean; resolve: (accepted: boolean) => void };
const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => queue[0] ?? null;

function openDialog(message: string, confirmation: boolean, options: DialogOptions) {
  return new Promise<boolean>(resolve => {
    queue.push({ message, confirmation, ...options, resolve });
    notify();
  });
}

export const confirmAction = (message: string, options: DialogOptions = {}) => openDialog(message, true, options);
export const showNotice = (message: string, options: DialogOptions = {}) => openDialog(message, false, options);

export function SiteDialog() {
  const request = useSyncExternalStore(subscribe, snapshot);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const finish = (accepted: boolean) => {
    if (!request || queue[0] !== request) return;
    queue.shift();
    request.resolve(accepted);
    notify();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!request || !dialog) return;
    dialog.showModal();
    // Start destructive confirmations on Cancel; the native dialog contains keyboard focus.
    (request.confirmation ? cancelRef.current : acceptRef.current)?.focus();
    return () => dialog.close();
  }, [request]);

  return <dialog ref={dialogRef} className="site-dialog" aria-labelledby="site-dialog-title" aria-describedby="site-dialog-message"
    onCancel={event => { event.preventDefault(); finish(false); }}>
    {request && <>
      <header className="site-dialog-header">
        <h3 id="site-dialog-title">{request.confirmation ? "⚠️" : "ℹ️"} {request.title ?? (request.confirmation ? "İşlem Onayı" : "Bilgilendirme")}</h3>
        <button type="button" className="icon-btn" aria-label="Kapat" onClick={() => finish(false)}>✕</button>
      </header>
      <p id="site-dialog-message" className="site-dialog-message">{request.message}</p>
      <footer className="site-dialog-actions">
        {request.confirmation && <button ref={cancelRef} type="button" className="secondary-btn" onClick={() => finish(false)}>Vazgeç</button>}
        <button ref={acceptRef} type="button" className={`btn site-dialog-accept${request.danger ? " danger" : ""}`} onClick={() => finish(true)}>
          {request.confirmLabel ?? (request.confirmation ? "Evet, Onayla" : "Tamam")}
        </button>
      </footer>
    </>}
  </dialog>;
}
