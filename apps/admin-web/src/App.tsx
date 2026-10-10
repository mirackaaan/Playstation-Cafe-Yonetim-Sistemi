import { calculateAmount, calculatePriceForMinutes, tariffRates, rateForControllers } from "../../shared/pricing.mjs";
import { ReportDateRangeDialog } from "./ReportDateRangeDialog";
import { SiteSelect } from "./SiteControls";
import { useReportTable, reportDuration } from "./ReportTableTools";
import { AnalyticsModal } from "./AnalyticsModal";
import { confirmAction, showNotice } from "./SiteDialog";
import { ReliableButton } from "./ReliableButton";
import "react-datepicker/dist/react-datepicker.css";
import { Fragment, FormEvent, useEffect, useState, useRef, useMemo } from "react";

type Category = { id: number; name: string; baseRate: number; first30Rate?: number | null; rate3?: number; first30Rate3?: number; rate4?: number; first30Rate4?: number };
type Product = { id: number; name: string; price: number; category?: string };
type OrderItem = { id: number; sessionId: number; productName: string; unitPrice: number; quantity: number; totalPrice: number; createdAt?: string };
type ActivityLog = { id: number; type: string; message: string; createdAt: string };
export type Session = {
  id: number;
  deviceId: number;
  deviceName?: string;
  categoryName?: string;
  startedAt: string;
  endedAt?: string | null;
  segmentStartedAt?: string | null;
  accruedAmount?: number;
  roundingStep?: number;
  hourlyRate: number;
  first30Rate?: number | null;
  controllerCount: number;
  targetMinutes: number | null;
  packageAmount?: number | null;
  isPaid: boolean;
  paymentMethod: "nakit" | "kredi_karti" | "ucretsiz" | null;
  closureMethod?: "nakit" | "kredi_karti" | "ucretsiz" | null;
  paidGameAmount?: number | null;
  paidOrdersAmount?: number | null;
  freeGameAmount?: number | null;
  freeOrdersAmount?: number | null;
  prepaidAmount?: number;
  collectedAmount?: number;
  remaining?: number;
  checkoutHeldAt?: string | null;
  gameAmount?: number;
  gameRemaining?: number;
  gamePaymentCredit?: number;
  paymentDifferenceReasons?: string[];
  partialPaidAmount?: number;
  partialPayments?: { id: number; amount: number; paymentMethod: string; createdAt: string }[];
  periodPayments?: { amount: number; paymentMethod: string; createdAt: string; kind: string }[];
  ledgerPayments?: { amount: number; paymentMethod: string; createdAt: string; kind: string }[];
  closedInPeriod?: boolean;
  ordersTotal?: number;
  orderItems?: OrderItem[];
  totalAmount?: number | null;
  checkoutPaymentMethod?: "nakit" | "kredi_karti" | "ucretsiz" | null;
  checkoutAmount?: number | null;
};
type Device = {
  id: number;
  name: string;
  status: "bos" | "mesgul";
  categoryId: number | null;
  categoryName?: string;
  displayOrder?: number;
  activeSession: Session | null;
  lastClosedSessionId?: number | null;
};
type Summary = {
  totalDevices: number;
  availableDevices: number;
  occupiedDevices: number;
  openSessions: number;
  liveAmount: number;
  dailyRevenue: number;
  roundingStep: number;
  warningMinutes: number;
  updatedAt: string;
};
type ReportData = {
  sessions: Session[];
  stats: {
    totalDailyRevenue: number;
    cashRevenue: number;
    cardRevenue: number;
    closedTodayCount: number;
  };
};

const tokenKey = "cave-admin-token";
const money = (value: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);

function sessionBalance(session: Session | null, timeAmount: number) {
  const round = (amount: number) => Math.round(amount * 100) / 100;
  const total = session ? round(timeAmount + (session.ordersTotal ?? 0)) : 0;
  const collected = session ? round(session.collectedAmount ?? ((session.prepaidAmount ?? 0) + (session.partialPaidAmount ?? 0))) : 0;
  return { total, collected, remaining: Math.max(0, round(total - collected)) };
}
const statusName = { bos: "Boş", mesgul: "Dolu" };

function calculateMinutesFromPrice(
  targetPrice: number,
  hourlyRate: number,
  first30Rate?: number | null,
  roundingStep: number = 1
): number {
  if (targetPrice <= 0 || hourlyRate <= 0) return 0;
  const base30 = first30Rate != null && first30Rate > 0 ? first30Rate : hourlyRate / 2;
  let low = 1;
  let high = 1440;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (calculatePriceForMinutes(middle, hourlyRate, base30, roundingStep) <= targetPrice) low = middle;
    else high = middle - 1;
  }
  return low;
}

function playChime(frequencies: number[] = [659.25, 880]) {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const audioCtx = new AudioContextClass();
    let startTime = audioCtx.currentTime;
    frequencies.forEach((freq) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.12, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.3);
      startTime += 0.12;
    });
  } catch (e) {
    console.error("Audio chime error:", e);
  }
}

let cachedVoices: SpeechSynthesisVoice[] = [];
const announcementRate = 1.35;
const announcementQueue: string[] = [];
let announcementPlaying = false;
function updateCachedVoices() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    cachedVoices = window.speechSynthesis.getVoices();
  }
}
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  updateCachedVoices();
  window.speechSynthesis.addEventListener("voiceschanged", updateCachedVoices);
}

function getAvailableVoices(): SpeechSynthesisVoice[] {
  updateCachedVoices();
  return cachedVoices;
}

function getPreferredFemaleVoice(): SpeechSynthesisVoice | undefined {
  const voices = getAvailableVoices();
  // 1. Google Türkçe (Chrome'un doğal kadın sesi)
  const googleTr = voices.find((v) => v.lang.toLowerCase().startsWith("tr") && v.name.toLowerCase().includes("google"));
  if (googleTr) return googleTr;

  // 2. Microsoft Emel, Suna, Filiz, Dilara (Kadın sesleri)
  const msFemale = voices.find(
    (v) =>
      v.lang.toLowerCase().startsWith("tr") &&
      (v.name.toLowerCase().includes("emel") ||
        v.name.toLowerCase().includes("suna") ||
        v.name.toLowerCase().includes("filiz") ||
        v.name.toLowerCase().includes("dilara") ||
        v.name.toLowerCase().includes("female") ||
        v.name.toLowerCase().includes("kadin") ||
        v.name.toLowerCase().includes("zira"))
  );
  if (msFemale) return msFemale;

  // 3. Adında tolga/ahmet/male geçmeyen herhangi bir Türkçe ses
  const anyOtherTr = voices.find(
    (v) =>
      v.lang.toLowerCase().startsWith("tr") &&
      !v.name.toLowerCase().includes("tolga") &&
      !v.name.toLowerCase().includes("ahmet") &&
      !v.name.toLowerCase().includes("male")
  );
  if (anyOtherTr) return anyOtherTr;

  // 4. Sistemde sadece tek bir Türkçe ses varsa (Tolga dahil)
  return voices.find((v) => v.lang.toLowerCase().startsWith("tr"));
}

function speakVoiceAnnouncement(text: string) {
  announcementQueue.push(text);
  playNextAnnouncement();
}

function playAnnouncementAudio(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error("Anons sesi zaman aşımına uğradı.")), 25_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.onended = null;
      audio.onerror = null;
      if (error) { audio.pause(); reject(error); }
      else resolve();
    };
    audio.defaultPlaybackRate = announcementRate;
    audio.playbackRate = announcementRate;
    audio.onloadedmetadata = () => { audio.playbackRate = announcementRate; };
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("Anons sesi yüklenemedi."));
    Promise.resolve(audio.play()).catch((error: Error) => finish(error));
  });
}

async function playNextAnnouncement() {
  if (announcementPlaying || announcementQueue.length === 0) return;
  announcementPlaying = true;
  const text = announcementQueue.shift()!;
  try {
    const token = localStorage.getItem(tokenKey) ?? sessionStorage.getItem(tokenKey) ?? "";
    const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/")) throw new Error(`Sunucu ses hizmeti: ${response.status}`);
    const blobUrl = URL.createObjectURL(await response.blob());
    try { await playAnnouncementAudio(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (serverError) {
    try {
      // Sunucu dış ses hizmetine erişemese bile tarayıcı doğrudan deneyebilir.
      await playAnnouncementAudio(`https://translate.google.com/translate_tts?ie=UTF-8&tl=tr&client=tw-ob&q=${encodeURIComponent(text)}`);
    } catch (remoteError) {
      console.warn("Anons için çevrim içi sesler kullanılamadı; cihazdaki Türkçe sese geçiliyor.", serverError, remoteError);
      await fallbackSpeechSynthesis(text);
    }
  } finally {
    announcementPlaying = false;
    playNextAnnouncement();
  }
}

function fallbackSpeechSynthesis(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    let settled = false;
    const timeout = window.setTimeout(finish, 25_000);
    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "tr-TR";
      utterance.rate = announcementRate;
      utterance.pitch = 1;
      const chosenVoice = getPreferredFemaleVoice();
      if (chosenVoice) utterance.voice = chosenVoice;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error("Cihazın seslendirme hizmeti kullanılamadı:", error);
      finish();
    }
  });
}

function notifyMinutesLeft(deviceName: string, minutes: number) {
  playChime([659.25, 880]);
  setTimeout(() => {
    speakVoiceAnnouncement(`${deviceName}, son ${minutes} dakika`);
  }, 350);
}

function notifyTimeExpired(deviceName: string) {
  playChime([880, 659.25]);
  setTimeout(() => {
    speakVoiceAnnouncement(`${deviceName}, süresi doldu`);
  }, 350);
}

function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return isMobile;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  }); } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("Sunucuya ulaşılamıyor. Bağlantıyı kontrol edip tekrar deneyin.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem(tokenKey);
      sessionStorage.removeItem(tokenKey);
      window.dispatchEvent(new Event("cave-auth-expired"));
    }
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || (response.status === 401 ? "Oturumunuz kapandı. Yeniden giriş yapın." : "İşlem tamamlanamadı. Lütfen tekrar deneyin."));
  }
  if (response.status === 204) return null as T;
  return response.json();
}

function formatDateString(date: Date): string {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
}

export function App() {

  const [token, setToken] = useState(() => {
    if (new URLSearchParams(window.location.search).has("connection-preview")) return "offline-preview";
    const saved = localStorage.getItem(tokenKey) ?? sessionStorage.getItem(tokenKey) ?? "";
    if (saved) localStorage.setItem(tokenKey, saved);
    return saved;
  });
  useEffect(() => {
    const expire = () => setToken("");
    window.addEventListener("cave-auth-expired", expire);
    return () => window.removeEventListener("cave-auth-expired", expire);
  }, []);
  return token ? (
    <Dashboard
      token={token}
      onLogout={() => {
        sessionStorage.removeItem(tokenKey);
        localStorage.removeItem(tokenKey);
        setToken("");
      }}
    />
  ) : (
    <Login
      onLogin={(value) => {
        localStorage.setItem(tokenKey, value);
        setToken(value);
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      onLogin(body.token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Giriş yapılamadı.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      {/* Tam ekran arka plan logosu */}
      <div className="login-logo-wrapper">
        <img src="/logo.jpg" alt="CAVE PlayStation Cafe" className="login-logo-img" />
      </div>

      <form onSubmit={submit} className="login-card">
        {/* Marka başlığı */}
        <div className="eyebrow-logo">
          <span className="login-brand-name">CAVE</span>
          <p>Devam etmek için şifrenizi girin.</p>
        </div>

        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Şifreniz"
        />
        {error && <small className="error">{error}</small>}
        <button disabled={busy}>{busy ? "Kontrol ediliyor…" : "Giriş Yap"}</button>
        <small>İlk kurulum şifresi: <code>cave123</code></small>
      </form>

    </main>
  );
}

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const mobile = useMobile();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [recentLogs, setRecentLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [lastSuccessfulUpdate, setLastSuccessfulUpdate] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadController = useRef<AbortController | null>(null);

  const [showGeneralSettingsModal, setShowGeneralSettingsModal] = useState(false);
  const [showReportsModal, setShowReportsModal] = useState(false);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  const immersiveModalOpen = showReportsModal || showAnalyticsModal;
  const dataModalOpen = showGeneralSettingsModal || immersiveModalOpen;
  const dataModalOpenRef = useRef(dataModalOpen);
  dataModalOpenRef.current = dataModalOpen;
  const [reportJump, setReportJump] = useState<{ start: string; end: string; deviceId?: string; productName?: string } | null>(null);
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [startSessionDevice, setStartSessionDevice] = useState<Device | null>(null);
  const [partialPaymentDevice, setPartialPaymentDevice] = useState<Device | null>(null);
  const [markPaidDevice, setMarkPaidDevice] = useState<Device | null>(null);
  const [checkoutDevice, setCheckoutDevice] = useState<Device | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; device: Device } | null>(null);
  const [orderModalDevice, setOrderModalDevice] = useState<Device | null>(null);
  const [adjustControllersDevice, setAdjustControllersDevice] = useState<Device | null>(null);
  const [adjustTimeDevice, setAdjustTimeDevice] = useState<Device | null>(null);
  const [convertToTimedDevice, setConvertToTimedDevice] = useState<Device | null>(null);
  const [showDirectSaleModal, setShowDirectSaleModal] = useState(false);
  const [selectedSidebarDeviceId, setSelectedSidebarDeviceId] = useState<number | null>(null);
  const [moveDevice, setMoveDevice] = useState<Device | null>(null);
  const [freeCheckoutDevice, setFreeCheckoutDevice] = useState<Device | null>(null);

  const load = async (force = false) => {
    if (loadController.current && !force) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setRefreshing(true);
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const [nextSummary, nextDevices, nextCategories, nextProducts, nextLogs] = await Promise.all([
        request<Summary>("/api/summary", token, { signal: controller.signal }),
        request<Device[]>("/api/devices", token, { signal: controller.signal }),
        request<Category[]>("/api/categories", token, { signal: controller.signal }),
        request<Product[]>("/api/products", token, { signal: controller.signal }),
        request<ActivityLog[]>("/api/logs", token, { signal: controller.signal }).catch(() => []),
      ]);
      if (loadController.current !== controller) return;
      setSummary(nextSummary);
      setDevices(nextDevices);
      setCategories(nextCategories);
      setProducts(nextProducts);
      setRecentLogs(nextLogs.slice(0, 12));
      setLastSuccessfulUpdate(nextSummary.updatedAt);
      setConnectionError("");
    } catch (reason) {
      if (loadController.current !== controller) return;
      setConnectionError(controller.signal.aborted ? "Sunucu 10 saniye içinde yanıt vermedi." : reason instanceof Error ? reason.message : "Veriler yüklenemedi.");
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      if (loadController.current === controller) {
        loadController.current = null;
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!dataModalOpenRef.current) void load();
    }, 5_000);
    const retry = () => void load(true);
    window.addEventListener("online", retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", retry);
      const controller = loadController.current;
      loadController.current = null;
      controller?.abort();
    };
  }, [token]);

  useEffect(() => {
    if (dataModalOpen) {
      const controller = loadController.current;
      loadController.current = null;
      controller?.abort();
      setRefreshing(false);
    }
  }, [dataModalOpen]);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  // Sesli uyarılar bir kez çalınır; bekleyen masalar açık oturumlardan yeniden oluşturulur.
  const warningAlertedRef = useRef<Set<number>>(new Set());
  const expiredAlertedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    warningAlertedRef.current.clear();
  }, [summary?.warningMinutes]);

  useEffect(() => {
    const checkTimer = () => {
      const now = Date.now();
      devices.forEach((d) => {
        const session = d.activeSession;
        if (!session || !session.targetMinutes) return;

        const startMs = new Date(session.startedAt).getTime();
        const endMs = startMs + session.targetMinutes * 60_000;
        const remainingSeconds = Math.floor((endMs - now) / 1000);

        const warningMinutes = summary?.warningMinutes ?? 5;
        const warningSeconds = warningMinutes * 60;
        // Süre uzatılırsa yeni eşik için anons hakkını geri ver.
        if (remainingSeconds > warningSeconds) {
          warningAlertedRef.current.delete(session.id);
        }
        if (remainingSeconds > 0) {
          expiredAlertedRef.current.delete(session.id);
        }

        if (remainingSeconds <= warningSeconds && remainingSeconds > 0) {
          if (!warningAlertedRef.current.has(session.id)) {
            warningAlertedRef.current.add(session.id);
            if (!mobile) notifyMinutesLeft(d.name, warningMinutes);
          }
        }

        // Süre dolduğunda bildirim ver; ödeme penceresi diğer uyarıları engellemesin.
        if (remainingSeconds <= 0) {
          if (!expiredAlertedRef.current.has(session.id)) {
            expiredAlertedRef.current.add(session.id);
            if (!mobile) notifyTimeExpired(d.name);
          }
        }
      });
    };

    checkTimer();
    const timer = window.setInterval(checkTimer, 1000);
    return () => clearInterval(timer);
  }, [devices, summary?.warningMinutes, mobile]);

  const action = async (path: string, init?: RequestInit) => {
    try {
      setError("");
      await request(path, token, init);
      await load(true);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "İşlem tamamlanamadı.");
      return false;
    }
  };

  const logout = async () => {
    await request("/api/auth/logout", token, { method: "POST" }).catch(() => undefined);
    onLogout();
  };

  const connectionNotice = (
    <section className="connection-status-inline" role={connectionError ? "alert" : "status"} aria-live="polite" data-site-tooltip={connectionError ? `${connectionError} Bağlantı otomatik olarak yeniden denenecek.` : undefined} style={{ color: connectionError ? "#fcd58a" : "#a7dfc6" }}>
      <span>{connectionError ? (summary ? "Bağlantı sorunu · Veriler eski" : "Sunucuya bağlanılamadı") : "Bağlantı başarılı"}</span>
      <span>· Son güncelleme: {lastSuccessfulUpdate ? <time dateTime={lastSuccessfulUpdate} data-site-tooltip={new Date(lastSuccessfulUpdate).toLocaleString("tr-TR")}>{new Date(lastSuccessfulUpdate).toLocaleTimeString("tr-TR")}</time> : "—"}</span>
      {connectionError && <button type="button" className="secondary compact-btn" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Bağlanılıyor…" : "Yeniden dene"}</button>}
    </section>
  );

  if (!summary) return mobile ? <main className="loading">{connectionError ? "Sunucuya bağlanılamadı. Bağlantı yeniden deneniyor…" : "Salon verileri yükleniyor…"}</main> : (
    <main className="connection-screen">
      <section className="connection-card" role={connectionError ? "alert" : "status"} aria-live="polite">
        <div className={`connection-card-icon ${connectionError ? "offline" : "pending"}`} aria-hidden="true">
          {connectionError ? <svg viewBox="0 0 48 48" fill="none"><path d="M10 17a20 20 0 0 1 28 0M16 24a12 12 0 0 1 16 0M22 31a4 4 0 0 1 4 0" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"/><path d="M8 8 40 40" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg> : <span className="connection-spinner" />}
        </div>
        <div className="connection-card-label">SALON BAĞLANTISI</div>
        <h2>{connectionError ? "Sunucuya bağlanılamıyor" : "Salon verileri yükleniyor"}</h2>
        <p>{connectionError ? "Veriler şu anda alınamıyor. Bağlantı otomatik olarak yeniden denenecek." : "Sunucuyla bağlantı kuruluyor. Lütfen kısa bir süre bekleyin."}</p>
        {connectionError && <>
          {lastSuccessfulUpdate && <div className="connection-card-detail">Son başarılı güncelleme: <time dateTime={lastSuccessfulUpdate}>{new Date(lastSuccessfulUpdate).toLocaleString("tr-TR")}</time></div>}
          <button type="button" className="connection-retry-btn" onClick={() => void load(true)}>↻ Yeniden dene</button>
        </>}
      </section>
    </main>
  );

  return (
    <main className={mobile ? "mobile-dashboard" : "desktop-dashboard"}>
      <div aria-hidden={immersiveModalOpen} style={{ visibility: immersiveModalOpen ? "hidden" : undefined }}>
        <header className="topbar">
          <div className="brand">
            <div className="brand-logo-container">
              <img src="/logo.jpg" alt="CAVE PlayStation Cafe Logo" className="header-logo-img" />
            </div>
            <div className="brand-text-container">
              <h1 className="brand-title">{mobile ? "CAVE SALON" : "CAVE PLAYSTATION CAFE"}</h1>
            </div>
          </div>
          <div className="topbar-actions">


            {!mobile && (
              <>
                <ReliableButton type="button" className="secondary compact-btn" onActivate={() => setShowGeneralSettingsModal(true)}>
                  ⚙️ Ayarlar
                </ReliableButton>
                <ReliableButton type="button" className="secondary compact-btn" onActivate={() => { setReportJump(null); setShowReportsModal(true); }}>
                  📊 Raporlar
                </ReliableButton>
                <ReliableButton type="button" className="secondary compact-btn" onActivate={() => setShowAnalyticsModal(true)}>
                  📈 Analizler
                </ReliableButton>
              </>
            )}
            <button className="danger-ghost compact-btn" onClick={() => void logout()}>
              Çıkış
            </button>
          </div>
        </header>

        {error && <p className="error notice dashboard-error" role="alert">{error}</p>}

        {mobile ? (
          <MobileSummary summary={summary} />
        ) : (
          <div className="dashboard-content">
            <DesktopGrid
              summary={summary}
              devices={devices}
              categories={categories}
              selectedDeviceId={selectedSidebarDeviceId}
              onSelectDevice={(device) => {
                setSelectedSidebarDeviceId(prev => prev === device?.id ? null : (device ? device.id : null));
              }}
              onStartSession={setStartSessionDevice}
              onStartSessionDirect={async (device, controllerCount, targetMinutes, isPaid, paymentMethod, startedAt) => {
                if (!await action(`/api/devices/${device.id}/start`, {
                  method: "POST",
                  body: JSON.stringify({ controllerCount, targetMinutes, isPaid, paymentMethod, startedAt }),
                })) return;
              }}
              onUpdateSession={async (device, updates) => {
                if (!device.activeSession) return false;
                return action(`/api/sessions/${device.activeSession.id}`, { method: "PUT", body: JSON.stringify(updates) });
              }}
              onStopSession={setCheckoutDevice}
              onOpenOrders={(device) => setOrderModalDevice(device)}
              onMoveDevice={(device) => setMoveDevice(device)}
              onFreeCheckout={(device) => setFreeCheckoutDevice(device)}
              onEditDevice={setEditingDevice}
              onDeleteDevice={async (device) => {
                if (await confirmAction(`"${device.name}" masasını silmek istediğinize emin misiniz?`, { title: "Masa Silme Onayı", confirmLabel: "Evet, Masayı Sil", danger: true })) {
                  action(`/api/devices/${device.id}`, { method: "DELETE" });
                }
              }}
              onContextMenu={(e, device) => {
                e.preventDefault();
                let adjustedX = e.clientX;
                let adjustedY = e.clientY;
                if (adjustedX + 260 > window.innerWidth) adjustedX = window.innerWidth - 260;
                if (adjustedY + 460 > window.innerHeight) adjustedY = Math.max(8, window.innerHeight - 460);
                setContextMenu({ x: adjustedX + window.scrollX, y: adjustedY + window.scrollY, device });
              }}
              onReorderDevices={async (updates) => {
                setDevices(prev => {
                  const newDevices = [...prev];
                  updates.forEach(u => {
                    const target = newDevices.find(d => d.id === u.id);
                    if (target) target.displayOrder = u.displayOrder;
                  });
                  return newDevices.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
                });
                await request("/api/devices/reorder", token, { method: "PUT", body: JSON.stringify(updates) });
                void load();
              }}
              onAddDevice={() => setShowAddDeviceModal(true)}
              onDirectSale={() => setShowDirectSaleModal(true)}
            />

            <section className="history-panel">
              <div className="history-header">
                Geçmiş
              </div>
              <div className="history-list">
                {recentLogs.map((log, index) => (
                  <div
                    key={log.id}
                    className={`history-item ${index % 2 === 0 ? 'even' : 'odd'}`}
                    onContextMenu={async (e) => {
                      e.preventDefault();
                      if (await confirmAction("Bu geçmiş kaydını silmek istediğinize emin misiniz?", { title: "Geçmiş Kaydını Sil", confirmLabel: "Evet, Kaydı Sil", danger: true })) {
                        try {
                          await request(`/api/logs/${log.id}`, token, { method: "DELETE" });
                          setRecentLogs(prev => prev.filter(l => l.id !== log.id));
                        } catch (err) {
                          await showNotice(err instanceof Error ? err.message : "Kayıt silinemedi. Lütfen yeniden deneyin.", { title: "Kayıt Silinemedi" });
                        }
                      }
                    }}
                    style={{ cursor: "context-menu" }}
                  >
                    <span className="history-time">{new Date(log.createdAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="history-sep"> : </span>
                    <span className="history-msg">{log.message}</span>
                  </div>
                ))}
              </div>
              <div className="history-connection-status">{connectionNotice}</div>
            </section>
          </div>
        )}
      </div>

      <ExpiredAlertList devices={devices} checkoutOpen={Boolean(checkoutDevice)} onCheckout={setCheckoutDevice} />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          device={contextMenu.device}
          onClose={() => setContextMenu(null)}
          onStartSession={() => setStartSessionDevice(contextMenu.device)}
          onStopSession={() => setCheckoutDevice(contextMenu.device)}
          onPartialPayment={() => setPartialPaymentDevice(contextMenu.device)}
          onFreeCheckout={() => {
            setFreeCheckoutDevice(contextMenu.device);
          }}
          onAdjustControllers={() => setAdjustControllersDevice(contextMenu.device)}
          onMoveDevice={() => setMoveDevice(contextMenu.device)}
          onAdjustTime={() => setAdjustTimeDevice(contextMenu.device)}
          onConvertToTimed={() => setConvertToTimedDevice(contextMenu.device)}
          onConvertToUntimed={async () => {
            if (contextMenu.device.activeSession) {
              if (!await action(`/api/sessions/${contextMenu.device.activeSession.id}`, {
                method: "PUT",
                body: JSON.stringify({ targetMinutes: null }),
              })) return;
            }
          }}
          onMarkPaid={() => setMarkPaidDevice(contextMenu.device)}
          onOpenOrders={() => setOrderModalDevice(contextMenu.device)}
          onEditDevice={() => setEditingDevice(contextMenu.device)}
          onDeleteDevice={async () => {
            if (await confirmAction(`"${contextMenu.device.name}" masasını silmek istediğinizden emin misiniz?`, { title: "Masa Silme Onayı", confirmLabel: "Evet, Masayı Sil", danger: true })) {
              void action(`/api/devices/${contextMenu.device.id}`, { method: "DELETE" });
            }
          }}
          onUndoCheckout={async () => {
            if (!contextMenu.device.activeSession) {
              if (await confirmAction(`"${contextMenu.device.name}" masasında son kapatılan hesabı geri almak istediğinizden emin misiniz?`, { title: "Son Hesabı Geri Alma Onayı", confirmLabel: "Evet, Hesabı Geri Al" })) {
                await action(`/api/devices/${contextMenu.device.id}/undo`, {
                  method: "POST",
                  body: JSON.stringify({ expectedSessionId: contextMenu.device.lastClosedSessionId }),
                });
              }
            }
          }}
        />
      )}

      {showGeneralSettingsModal && (
        <GeneralSettingsModal
          token={token}
          categories={categories}
          products={products}
          onClose={() => setShowGeneralSettingsModal(false)}
          onRefresh={() => void load()}
        />
      )}

      {showReportsModal && (
        <ReportsModal
          token={token}
          devices={devices}
          initial={reportJump}
          onClose={() => setShowReportsModal(false)}
        />
      )}

      {showAnalyticsModal && (
        <AnalyticsModal
          token={token}
          onClose={() => setShowAnalyticsModal(false)}
          onOpenReport={jump => { setReportJump(jump); setShowAnalyticsModal(false); setShowReportsModal(true); }}
        />
      )}

      {showAddDeviceModal && (
        <AddDeviceModal
          categories={categories}
          onClose={() => setShowAddDeviceModal(false)}
          onAdd={async (name, categoryId) => {
            if (!await action("/api/devices", {
              method: "POST",
              body: JSON.stringify({ name, categoryId }),
            })) return;
            setShowAddDeviceModal(false);
          }}
        />
      )}

      {editingDevice && (
        <EditDeviceModal
          device={editingDevice}
          categories={categories}
          onClose={() => setEditingDevice(null)}
          onSave={async (name, categoryId) => {
            if (!await action(`/api/devices/${editingDevice.id}`, {
              method: "PUT",
              body: JSON.stringify({ name, categoryId }),
            })) return;
            setEditingDevice(null);
          }}
        />
      )}

      {startSessionDevice && (
        <StartSessionModal
          device={startSessionDevice}
          categories={categories}
          roundingStep={summary.roundingStep}
          onClose={() => setStartSessionDevice(null)}
          onStart={async (controllerCount, targetMinutes, isPaid, paymentMethod, startedAt) => {
            if (!await action(`/api/devices/${startSessionDevice.id}/start`, {
              method: "POST",
              body: JSON.stringify({ controllerCount, targetMinutes, isPaid, paymentMethod, startedAt }),
            })) return;
            setStartSessionDevice(null);
          }}
        />
      )}

      {markPaidDevice && <MarkPaidModal
        device={devices.find(d => d.activeSession?.id === markPaidDevice.activeSession?.id) ?? markPaidDevice}
        onClose={() => setMarkPaidDevice(null)}
        onConfirm={async (paymentMethod, includeOrders, expectedAmount, payments) => {
          if (!await action(`/api/sessions/${markPaidDevice.activeSession!.id}`, { method: "PUT", body: JSON.stringify({ isPaid: true, paymentMethod, includeOrders, expectedAmount, payments }) })) return false;
          setMarkPaidDevice(null);
          return true;
        }}
      />}
      {partialPaymentDevice && (
        <CheckoutModal
          device={devices.find(d => d.activeSession?.id === partialPaymentDevice.activeSession?.id) ?? partialPaymentDevice}
          roundingStep={summary?.roundingStep ?? 1}
          partial
          onClose={() => setPartialPaymentDevice(null)}
          onConfirmCheckout={async (paymentMethod, _endedAt, amount) => {
            await request(`/api/sessions/${partialPaymentDevice.activeSession!.id}/payments`, token, {
              method: "POST", body: JSON.stringify({ paymentMethod, amount }),
            });
            setPartialPaymentDevice(null);
            await load();
          }}
        />
      )}
      {checkoutDevice && (
        <CheckoutModal
          device={devices.find(d => d.activeSession?.id === checkoutDevice.activeSession?.id) ?? checkoutDevice}
          roundingStep={summary?.roundingStep ?? 1}
          onClose={async () => {
            try {
              await request(`/api/devices/${checkoutDevice.id}/checkout-release`, token, {
                method: "POST",
                body: JSON.stringify({ expectedSessionId: checkoutDevice.activeSession?.id }),
              });
            } catch {}
            setCheckoutDevice(null);
          }}
          onFreezeCheckout={async () => {
            const data = await request<{ endedAt: string }>(`/api/devices/${checkoutDevice.id}/checkout-hold`, token, {
              method: "POST",
              body: JSON.stringify({ expectedSessionId: checkoutDevice.activeSession?.id }),
            });
            return data.endedAt;
          }}
          onConfirmCheckout={async (paymentMethod, _endedAt, _amount, payments) => {
            await request(`/api/devices/${checkoutDevice.id}/stop`, token, {
              method: "POST",
              body: JSON.stringify({
                paymentMethod,
                payments,
                expectedSessionId: checkoutDevice.activeSession?.id,
                useCheckoutHold: true,
              }),
            });
            setCheckoutDevice(null);
            await load();
          }}
        />
      )}

      {orderModalDevice && (
        <OrderModal
          token={token}
          device={orderModalDevice}
          products={products}
          onClose={() => setOrderModalDevice(null)}
          onRefresh={() => void load()}
        />
      )}

      {adjustControllersDevice && (
        <AdjustControllersModal
          device={adjustControllersDevice}
          onClose={() => setAdjustControllersDevice(null)}
          onSave={async (count) => {
            if (adjustControllersDevice.activeSession) {
              if (!await action(`/api/sessions/${adjustControllersDevice.activeSession.id}`, {
                method: "PUT",
                body: JSON.stringify({ controllerCount: count }),
              })) return;
            }
            setAdjustControllersDevice(null);
          }}
        />
      )}

      {adjustTimeDevice && (
        <AdjustTimeModal
          device={adjustTimeDevice}
          onClose={() => setAdjustTimeDevice(null)}
          onSave={async (targetMinutes) => {
            if (adjustTimeDevice.activeSession) {
              if (!await action(`/api/sessions/${adjustTimeDevice.activeSession.id}`, {
                method: "PUT",
                body: JSON.stringify({ targetMinutes }),
              })) return;
            }
            setAdjustTimeDevice(null);
          }}
        />
      )}

      {convertToTimedDevice && (
        <ConvertToTimedModal
          token={token}
          device={devices.find(d => d.activeSession?.id === convertToTimedDevice.activeSession?.id) ?? convertToTimedDevice}
          categories={categories}
          roundingStep={summary.roundingStep}
          onClose={() => setConvertToTimedDevice(null)}
          onSave={async (targetMinutes, isPaid, paymentMethod) => {
            if (convertToTimedDevice.activeSession) {
              if (!await action(`/api/sessions/${convertToTimedDevice.activeSession.id}`, {
                method: "PUT",
                body: JSON.stringify({ targetMinutes, isPaid, paymentMethod }),
              })) return;
            }
            setConvertToTimedDevice(null);
          }}
        />
      )}

      {showDirectSaleModal && (
        <DirectSaleModal
          token={token}
          products={products}
          onClose={() => setShowDirectSaleModal(false)}
          onSuccess={(amount, method) => {
            setShowDirectSaleModal(false);
            void load();
          }}
        />
      )}

      {moveDevice && (
        <MoveDeviceModal
          sourceDevice={moveDevice}
          availableDevices={devices.filter(d => d.status === "bos" && d.id !== moveDevice.id)}
          onClose={() => setMoveDevice(null)}
          onTransfer={async (targetDeviceId) => {
            if (!await action(`/api/devices/${moveDevice.id}/transfer`, {
              method: "POST",
              body: JSON.stringify({ targetDeviceId, expectedSessionId: moveDevice.activeSession?.id }),
            })) return;
            setMoveDevice(null);
            setSelectedSidebarDeviceId(targetDeviceId);
          }}
        />
      )}

      {freeCheckoutDevice && (
        <FreeCheckoutModal
          device={freeCheckoutDevice}
          onClose={() => setFreeCheckoutDevice(null)}
          onConfirm={async () => {
            if (!await action(`/api/devices/${freeCheckoutDevice.id}/stop`, {
              method: "POST",
              body: JSON.stringify({
                paymentMethod: "ucretsiz",
                expectedSessionId: freeCheckoutDevice.activeSession?.id,
              }),
            })) return;
            setFreeCheckoutDevice(null);
            setSelectedSidebarDeviceId(null);
          }}
        />
      )}
    </main>
  );
}

function MobileSummary({ summary }: { summary: Summary }) {
  return (
    <>
      <p className="subtle">Son Güncelleme: {new Date(summary.updatedAt).toLocaleTimeString("tr-TR")}</p>
      <section className="hero-stat">
        <p>Anlık Açık Masalar Toplamı</p>
        <strong>{money(summary.liveAmount)}</strong>
        <span>🎮 {summary.openSessions} aktif oturum açık</span>
      </section>
      <section className="mobile-grid">
        <Stat label="Dolu Masa" value={String(summary.occupiedDevices)} accent="amber" />
        <Stat label="Boş Masa" value={String(summary.availableDevices)} accent="green" />
        <Stat label="Günlük Kazanç" value={money(summary.dailyRevenue)} accent="blue" />
        <Stat label="Toplam Masa" value={String(summary.totalDevices)} accent="rose" />
      </section>
      <p className="mobile-note">
        📱 Mobil görünüm canlı özet amaçlıdır. Masa başlatma, durdurma ve düzenleme işlemleri masaüstü ekranından yapılır.
      </p>
    </>
  );
}

function DesktopGrid({
  summary,
  devices,
  categories,
  selectedDeviceId,
  onSelectDevice,
  onStartSession,
  onStartSessionDirect,
  onUpdateSession,
  onStopSession,
  onOpenOrders,
  onMoveDevice,
  onFreeCheckout,
  onEditDevice,
  onDeleteDevice,
  onContextMenu,
  onReorderDevices,
  onAddDevice,
  onDirectSale,
}: {
  summary: Summary;
  devices: Device[];
  categories: Category[];
  selectedDeviceId: number | null;
  onSelectDevice: (device: Device | null) => void;
  onStartSession: (device: Device) => void;
  onStartSessionDirect: (device: Device, controllerCount: number, targetMinutes: number | null, isPaid: boolean, paymentMethod: string | null, startedAt?: string) => Promise<void>;
  onUpdateSession: (device: Device, updates: { controllerCount?: number; targetMinutes?: number | null; startedAt?: string }) => Promise<boolean>;
  onStopSession: (device: Device) => void;
  onOpenOrders: (device: Device) => void;
  onMoveDevice: (device: Device) => void;
  onFreeCheckout: (device: Device) => void;
  onEditDevice: (device: Device) => void;
  onDeleteDevice: (device: Device) => void;
  onContextMenu: (e: React.MouseEvent, device: Device) => void;
  onReorderDevices: (updates: { id: number; displayOrder: number }[]) => Promise<void>;
  onAddDevice: () => void;
  onDirectSale: () => void;
}) {
  const [localDevices, setLocalDevices] = useState<Device[]>(devices);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  useEffect(() => {
    if (draggedIdx === null) {
      setLocalDevices(devices);
    }
  }, [devices, draggedIdx]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIdx(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnter = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === index) return;
    const newItems = [...localDevices];
    const temp = newItems[draggedIdx];
    newItems[draggedIdx] = newItems[index];
    newItems[index] = temp;
    setDraggedIdx(index);
    setLocalDevices(newItems);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragEnd = async () => {
    setDraggedIdx(null);
    const updates = localDevices.map((d, idx) => ({ id: d.id, displayOrder: idx }));
    await onReorderDevices(updates);
  };

  const selectedDevice = useMemo(() => {
    return localDevices.find((d) => d.id === selectedDeviceId) || null;
  }, [localDevices, selectedDeviceId]);

  return (
    <>
      <section className="stats top-stats">
        <Stat label="Toplam Masa" value={String(summary.totalDevices)} />
        <Stat label="Boş Masalar" value={String(summary.availableDevices)} accent="green" />
        <Stat label="Dolu Masalar" value={String(summary.occupiedDevices)} accent="amber" />
        <Stat label="Anlık Kazanç" value={money(summary.liveAmount)} accent="blue" />
      </section>

      <section className="grid-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h2>Masalar ({devices.length})</h2>
          <span className="grid-subtext">Hızlı yönetim paneli için masalara <strong>tek tıklayabilirsiniz</strong> 👈 (Sağ tık menüsü de aktiftir).</span>
        </div>
        <div style={{ display: "flex", gap: "0.8rem" }}>
          <button className="secondary compact-btn" data-site-tooltip="Direkt Adisyon Satışı" onClick={onDirectSale}>
            🛒 Direkt Adisyon Satışı
          </button>
          <button className="primary-glow compact-btn" data-site-tooltip="Yeni Masa Ekle" onClick={onAddDevice}>
            ➕ Masa Ekle
          </button>
        </div>
      </section>

      <div className="salon-workspace">
        <div className="sidebar-slot">
          {selectedDevice ? (
            <TableControlSidebar
              key={selectedDevice.id}
              device={selectedDevice}
              roundingStep={summary.roundingStep}
              categories={categories}
              onClose={() => onSelectDevice(null)}
              onStartSession={onStartSessionDirect}
              onStopSession={() => onStopSession(selectedDevice)}
              onUpdateSession={onUpdateSession}
              onAddOrder={() => onOpenOrders(selectedDevice)}
              onMoveDevice={() => onMoveDevice(selectedDevice)}
              onFreeCheckout={() => onFreeCheckout(selectedDevice)}
            />
          ) : (
            <div className="sidebar-placeholder">
              <h3>Kısayollar</h3>
              <p>İşlem yapmak için bir masaya tıklayın.</p>
            </div>
          )}
        </div>

        <div className="main-content-area">
          <section className="cards-grid">
          {localDevices.length ? (
            localDevices.map((device, index) => (
              <div
                key={device.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnter={(e) => handleDragEnter(e, index)}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                style={{
                  opacity: draggedIdx === index ? 0.4 : 1,
                  cursor: "default",
                  transition: "opacity 0.2s, transform 0.2s"
                }}
              >
                <DeviceCard
                  device={device}
                  roundingStep={summary.roundingStep}
                  isSelected={selectedDeviceId === device.id}
                  onSelect={() => onSelectDevice(device)}
                  onStartSession={() => onStartSession(device)}
                  onStopSession={() => onStopSession(device)}
                  onEditDevice={() => onEditDevice(device)}
                  onDeleteDevice={() => onDeleteDevice(device)}
                  onContextMenu={(e) => onContextMenu(e, device)}
                />
              </div>
            ))
          ) : (
            <div className="empty-grid">
              <p>Henüz kayıtlı masa bulunmuyor.</p>
              <small>Yukarıdaki "➕ Masa Ekle" butonunu kullanarak ilk masanızı oluşturabilirsiniz.</small>
            </div>
          )}
        </section>
      </div>
    </div>
    </>
  );
}

function DeviceCard({
  device,
  roundingStep,
  isSelected,
  onSelect,
  onStartSession,
  onStopSession,
  onEditDevice,
  onDeleteDevice,
  onContextMenu,
}: {
  device: Device;
  roundingStep: number;
  isSelected?: boolean;
  onSelect?: () => void;
  onStartSession: () => void;
  onStopSession: () => void;
  onEditDevice: () => void;
  onDeleteDevice: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [timeText, setTimeText] = useState("");
  const [isExpired, setIsExpired] = useState(false);
  const [timeAmount, setTimeAmount] = useState(0);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    };
  }, []);

  const handleClick = () => {
    if (clickTimeoutRef.current) {
      // İkinci tıklama geldi -> ÇİFT TIKLAMA!
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      if (device.activeSession) {
        onStopSession();
      } else {
        onStartSession();
      }
    } else {
      // Birinci tıklama -> 220ms bekle, ikinci tıklama gelmezse sol paneli aç/kapat
      clickTimeoutRef.current = setTimeout(() => {
        clickTimeoutRef.current = null;
        onSelect?.();
      }, 220);
    }
  };

  useEffect(() => {
    if (!device.activeSession) {
      setIsExpired(false);
      setTimeText("");
      setTimeAmount(0);
      return;
    }
    const update = () => {
      const now = Date.now();
      const start = new Date(device.activeSession!.startedAt).getTime();

      if (device.activeSession!.targetMinutes) {
        const targetMs = device.activeSession!.targetMinutes * 60 * 1000;
        const endTime = start + targetMs;
        const diffMs = endTime - now;
        const expired = diffMs <= 0;
        setIsExpired(expired);

        const remainingSeconds = Math.max(0, Math.floor(diffMs / 1000));
        const hours = String(Math.floor(remainingSeconds / 3600)).padStart(2, "0");
        const mins = String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, "0");
        const secs = String(remainingSeconds % 60).padStart(2, "0");
        setTimeText(`${hours}:${mins}:${secs}`);

        const calcTime = expired ? endTime : now;

        setTimeAmount(
          device.activeSession!.packageAmount ?? calculateAmount(
            device.activeSession!.startedAt,
            device.activeSession!.hourlyRate,
            device.activeSession!.first30Rate,
            calcTime,
            device.activeSession!.accruedAmount ?? 0,
            device.activeSession!.segmentStartedAt,
            device.activeSession!.targetMinutes,
            device.activeSession!.roundingStep ?? roundingStep, 'live'
          )
        );
      } else {
        setIsExpired(false);
        const diffSec = Math.max(0, Math.floor((now - start) / 1000));
        const hours = String(Math.floor(diffSec / 3600)).padStart(2, "0");
        const mins = String(Math.floor((diffSec % 3600) / 60)).padStart(2, "0");
        const secs = String(diffSec % 60).padStart(2, "0");
        setTimeText(`${hours}:${mins}:${secs}`);

        setTimeAmount(
          calculateAmount(
            device.activeSession!.startedAt,
            device.activeSession!.hourlyRate,
            device.activeSession!.first30Rate,
            now,
            device.activeSession!.accruedAmount ?? 0,
            device.activeSession!.segmentStartedAt,
            null,
            device.activeSession!.roundingStep ?? roundingStep, 'live'
          )
        );
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [device.activeSession, roundingStep]);

  const balance = sessionBalance(device.activeSession, timeAmount);
  const isUnpaid = Boolean(device.activeSession && balance.remaining > 0);

  return (
    <article
      className={`device-card status-${device.status} ${isExpired ? "expired-card" : ""} ${isUnpaid ? "unpaid-card" : ""} ${isSelected ? "selected-card" : ""}`}
      onClick={handleClick}
      onContextMenu={onContextMenu}
    >
      <div className="card-top">
        <div className="card-title-group">
          <h3 data-site-tooltip={device.name}>{device.name}</h3>
        </div>
        {device.activeSession && (
          <div className="controller-badge">
            🎮 {device.activeSession.controllerCount} Kol
          </div>
        )}
      </div>

      <div className="card-body">
        {device.activeSession ? (
          <div className={`session-active-info ${isExpired ? "expired-info" : ""}`}>
            <div className="timer-display">
              <span className={isExpired ? "timer-label expired-banner" : "timer-label"}>
                {isExpired ? "⚠️ SÜRE DOLDU!" : device.activeSession.targetMinutes ? "KALAN SÜRE" : "GEÇEN SÜRE"}
              </span>
              <div className="timer-readout">
                <span className="timer-icon" aria-hidden="true">
                  {device.activeSession.targetMinutes ? "⏳" : "⏱️"}
                </span>
                <span className={`timer-clock ${isExpired ? "expired-clock" : ""}`}>
                  {timeText}
                </span>
                <span aria-hidden="true" />
              </div>
            </div>

            <div className="amount-display">
              <span className="amount-label">
                {balance.remaining === 0 ? "✅ ÖDENDİ · KALAN ÖDEME" : "KALAN ÖDEME"}
              </span>
              <strong className="amount-value">{money(balance.remaining)}</strong>
            </div>

          </div>
        ) : (
          <div className="empty-card-info" />
        )}
      </div>

      {device.activeSession && (
        <div className="card-status-slot">
          {isUnpaid && <span className="unpaid-badge card-unpaid-badge">⚠️ ÜCRET ALINMADI</span>}
        </div>
      )}

    </article>
  );
}

function ContextMenu({
  x,
  y,
  device,
  onClose,
  onStartSession,
  onStopSession,
  onAdjustControllers,
  onMoveDevice,
  onAdjustTime,
  onConvertToTimed,
  onConvertToUntimed,
  onMarkPaid,
  onOpenOrders,
  onEditDevice,
  onDeleteDevice,
  onUndoCheckout,
  onFreeCheckout,
  onPartialPayment,
}: {
  x: number;
  y: number;
  device: Device;
  onClose: () => void;
  onStartSession: () => void;
  onStopSession: () => void;
  onAdjustControllers: () => void;
  onMoveDevice: () => void;
  onAdjustTime: () => void;
  onConvertToTimed: () => void;
  onConvertToUntimed: () => void;
  onMarkPaid: () => void;
  onOpenOrders: () => void;
  onEditDevice: () => void;
  onDeleteDevice: () => void;
  onUndoCheckout: () => void;
  onFreeCheckout?: () => void;
  onPartialPayment: () => void;
}) {
  const isTimed = Boolean(device.activeSession?.targetMinutes);
  const isUnpaid = Boolean(device.activeSession && isTimed && (device.activeSession.gameRemaining ?? 0) > 0);

  return (
    <div
      className="context-menu"
      style={{ top: `${y}px`, left: `${x}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-header">
        <strong>{device.name}</strong>
        <span>{device.categoryName ?? "Genel"}</span>
      </div>

      <div className="context-body">
        {device.activeSession ? (
          <>
            {isUnpaid && !device.activeSession.isPaid && !(device.activeSession.partialPaidAmount ?? 0) && (
              <button
                className="highlight-paid-btn"
                onClick={() => {
                  onClose();
                  onMarkPaid();
                }}
              >
                💳 Ücreti Ödendi İşaretle
              </button>
            )}

            <button
              onClick={() => {
                onClose();
                onOpenOrders();
              }}
            >
              🍟 Adisyon Ekle / Gör ({money(device.activeSession.ordersTotal ?? 0)})
            </button>

            <button
              onClick={() => {
                onClose();
                onAdjustControllers();
              }}
            >
              🎮 Kol Sayısı Değiştir ({device.activeSession.controllerCount} Kol)
            </button>

            <button
              onClick={() => {
                onClose();
                onMoveDevice();
              }}
            >
              🔀 Masa Değiştir
            </button>

            {isTimed ? (
              <>
                <button
                  onClick={() => {
                    onClose();
                    onAdjustTime();
                  }}
                >
                  ⏱️ Süre Ekle / Düş ({device.activeSession.targetMinutes} Dk)
                </button>
                <button
                  onClick={() => {
                    onClose();
                    onConvertToUntimed();
                  }}
                >
                  ♾️ Süresize Çevir
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  onClose();
                  onConvertToTimed();
                }}
              >
                ⏱️ Süreliye Çevir
              </button>
            )}

            {(!device.activeSession.targetMinutes || !device.activeSession.isPaid) && (
              <button onClick={() => { onClose(); onPartialPayment(); }}>💵 Kısmi ödeme al</button>
            )}
            <button
              className="danger-item"
              onClick={() => {
                onClose();
                onFreeCheckout?.();
              }}
              style={{ color: "var(--accent-rose)" }}
            >
              🎁 Ücretsiz Hesap Kes
            </button>

            <div className="context-divider" />
            <button
              className="danger-item"
              onClick={() => {
                onClose();
                onStopSession();
              }}
            >
              🏁 Oturumu Bitir / Hesabı Kes
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                onClose();
                onStartSession();
              }}
            >
              ▶️ Masa Aç
            </button>
            <button
              onClick={() => {
                onClose();
                onUndoCheckout();
              }}
              style={{ color: "var(--color-warning, #f59e0b)" }}
            >
              ↩️ Son Hesabı Geri Al
            </button>
            <button
              onClick={() => {
                onClose();
                onEditDevice();
              }}
            >
              ✏️ Masa İsmini / Çeşidini Düzenle
            </button>
            <button
              className="danger-item"
              onClick={() => {
                onClose();
                onDeleteDevice();
              }}
            >
              🗑️ Masayı Sil
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function MoveDeviceModal({
  sourceDevice,
  availableDevices,
  onClose,
  onTransfer,
}: {
  sourceDevice: Device;
  availableDevices: Device[];
  onClose: () => void;
  onTransfer: (targetDeviceId: number) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState<number | "">(availableDevices[0]?.id || "");
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h3>🔀 Masa Değiştir / Aktar</h3>
          <button type="button" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ marginTop: "1rem" }}>
          <p style={{ color: "#e2e8f0", fontSize: "0.95rem" }}>
            <strong>{sourceDevice.name}</strong> masasındaki hesabı ve adisyonları aktaracağınız boş masayı seçin. Süre hedef masanın tarifesine göre yeniden hesaplanır:
          </p>
          {availableDevices.length ? (
            <div className="form-group" style={{ marginTop: "1.2rem" }}>
              <label className="section-label">Hedef Boş Masa:</label>
              <SiteSelect
                className="custom-input"
                style={{ width: "100%", padding: "0.65rem", background: "#1e293b", color: "#fff", borderRadius: "6px", border: "1px solid #334155" }}
                value={targetId}
                onChange={(e) => setTargetId(Number(e.target.value))}
              >
                {availableDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.categoryName ?? "Genel"})
                  </option>
                ))}
              </SiteSelect>
            </div>
          ) : (
            <p className="notice" style={{ color: "#ef4444", marginTop: "1rem" }}>
              ⚠️ Salonda aktarılabilecek başka boş masa bulunmuyor.
            </p>
          )}
        </div>
        <div className="modal-actions" style={{ marginTop: "1.5rem" }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !targetId}
            onClick={async () => {
              if (!targetId) return;
              setBusy(true);
              try { await onTransfer(Number(targetId)); } finally { setBusy(false); }
            }}
          >
            {busy ? "Aktarılıyor…" : "Masayı Aktar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FreeCheckoutModal({
  device,
  onClose,
  onConfirm,
}: {
  device: Device;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-backdrop" style={{ zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        className="modal-card"
        style={{
          maxWidth: "440px",
          width: "90%",
          background: "rgba(18, 9, 26, 0.98)",
          border: "1.5px solid rgba(244, 63, 94, 0.5)",
          boxShadow: "0 25px 60px rgba(0, 0, 0, 0.95), 0 0 30px rgba(244, 63, 94, 0.2)",
          borderRadius: "16px",
          padding: "1.5rem",
          animation: "scaleUpModal 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div
          className="modal-header"
          style={{
            borderBottom: "1px solid rgba(244, 63, 94, 0.2)",
            paddingBottom: "0.8rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3 style={{ fontSize: "1.2rem", fontWeight: 800, color: "#fff", margin: 0 }}>
            🎁 Ücretsiz Hesap Kapatma Onayı
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>
        <div className="modal-body" style={{ marginTop: "1.2rem" }}>
          <p style={{ color: "#e2e8f0", fontSize: "0.95rem", lineHeight: "1.6" }}>
            <strong style={{ color: "#f43f5e", fontSize: "1.05rem" }}>{device.name}</strong> masasının açık oturumunu ve siparişlerini{" "}
            <strong style={{ color: "#34d399" }}>kalan borcunu silerek</strong> kapatmak üzeresiniz.
          </p>
          <div
            style={{
              marginTop: "0.9rem",
              padding: "0.65rem 0.85rem",
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "8px",
              color: "#fca5a5",
              fontSize: "0.83rem",
              lineHeight: "1.4",
            }}
          >
            Kalan borç silinir. Önceden alınan ödemeler kasada ve ödeme geçmişinde korunur; iade yapılmaz.
          </div>
        </div>
        <div className="modal-actions" style={{ marginTop: "1.6rem", display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); } finally { setBusy(false); }
            }}
            style={{
              background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
              color: "#fff",
              border: "none",
              padding: "0.65rem 1.25rem",
              borderRadius: "8px",
              fontWeight: 800,
              boxShadow: "0 4px 14px rgba(239, 68, 68, 0.4)",
              cursor: "pointer",
            }}
          >
            {busy ? "Kapatılıyor…" : "🎁 Evet, Ücretsiz Kapat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TableControlSidebar({
  device,
  roundingStep,
  categories,
  onClose,
  onStartSession,
  onStopSession,
  onUpdateSession,
  onAddOrder,
  onMoveDevice,
  onFreeCheckout,
}: {
  device: Device;
  roundingStep: number;
  categories: Category[];
  onClose: () => void;
  onStartSession: (device: Device, controllerCount: number, targetMinutes: number | null, isPaid: boolean, paymentMethod: string | null, startedAt?: string) => Promise<void>;
  onStopSession: (device: Device) => void;
  onUpdateSession: (device: Device, updates: { controllerCount?: number; targetMinutes?: number | null; startedAt?: string }) => Promise<boolean>;
  onAddOrder: (device: Device) => void;
  onMoveDevice: (device: Device) => void;
  onFreeCheckout: (device: Device) => void;
}) {
  // Boş masa state'leri
  const [controllerCount, setControllerCount] = useState<number>(2);
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [isPrepaid, setIsPrepaid] = useState<boolean>(false);
  const [quickPaymentMethod, setQuickPaymentMethod] = useState<"nakit" | "kredi_karti">("nakit");
  const [busy, setBusy] = useState(false);

  // Açık masa başlama saati düzenleme state'i
  const [startHour, setStartHour] = useState("");
  const [startMinute, setStartMinute] = useState("");
  const [hasTimeChanged, setHasTimeChanged] = useState(false);

  // Kol ve saat değişikliği için sol panelde gösterilen onay
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    description: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmModal) confirmationRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirmModal]);

  // Canlı sayaç ve tutar
  const [elapsedText, setElapsedText] = useState("");
  const [remainingText, setRemainingText] = useState("");
  const [closingTimeText, setClosingTimeText] = useState("");
  const [timeAmount, setTimeAmount] = useState(0);

  useEffect(() => {
    if (device.activeSession) {
      const startDate = new Date(device.activeSession.startedAt);
      setStartHour(String(startDate.getHours()).padStart(2, "0"));
      setStartMinute(String(startDate.getMinutes()).padStart(2, "0"));
      setHasTimeChanged(false);
    } else {
      setSelectedMinutes(null);
      setIsPrepaid(false);
      setQuickPaymentMethod("nakit");
      setControllerCount(2);
    }
  }, [device.id, device.activeSession?.startedAt]);

  // Canlı sayaç döngüsü
  useEffect(() => {
    if (!device.activeSession) return;
    const update = () => {
      const now = Date.now();
      const start = new Date(device.activeSession!.startedAt).getTime();

      // Gerçek Geçen Süre (Her zaman açılıştan şu ana kadar geçen süre)
      const deadline = device.activeSession!.targetMinutes
        ? start + device.activeSession!.targetMinutes * 60_000
        : Infinity;
      const elapsedSec = Math.max(0, Math.floor((Math.min(now, deadline) - start) / 1000));
      const elpHours = String(Math.floor(elapsedSec / 3600)).padStart(2, "0");
      const elpMins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, "0");
      const elpSecs = String(elapsedSec % 60).padStart(2, "0");
      setElapsedText(`${elpHours}:${elpMins}:${elpSecs}`);

      if (device.activeSession!.targetMinutes) {
        const targetMs = device.activeSession!.targetMinutes * 60 * 1000;
        const endTime = start + targetMs;
        const diffMs = endTime - now;
        const expired = diffMs <= 0;

        // Kalan Süre
        const remainingSeconds = Math.max(0, Math.floor(diffMs / 1000));
        const remHours = String(Math.floor(remainingSeconds / 3600)).padStart(2, "0");
        const remMins = String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, "0");
        const remSecs = String(remainingSeconds % 60).padStart(2, "0");
        setRemainingText(expired ? "Süre Bitti (00:00:00)" : `${remHours}:${remMins}:${remSecs}`);

        // Kapanış Saati
        const endDate = new Date(endTime);
        const endH = String(endDate.getHours()).padStart(2, "0");
        const endM = String(endDate.getMinutes()).padStart(2, "0");
        setClosingTimeText(`${endH}:${endM}`);

        const calcTime = expired ? endTime : now;
        setTimeAmount(
          device.activeSession!.packageAmount ?? calculateAmount(
            device.activeSession!.startedAt,
            device.activeSession!.hourlyRate,
            device.activeSession!.first30Rate,
            calcTime,
            device.activeSession!.accruedAmount ?? 0,
            device.activeSession!.segmentStartedAt,
            device.activeSession!.targetMinutes,
            device.activeSession!.roundingStep ?? roundingStep, 'live'
          )
        );
      } else {
        setRemainingText("");
        setClosingTimeText("");
        setTimeAmount(
          calculateAmount(
            device.activeSession!.startedAt,
            device.activeSession!.hourlyRate,
            device.activeSession!.first30Rate,
            now,
            device.activeSession!.accruedAmount ?? 0,
            device.activeSession!.segmentStartedAt,
            null,
            device.activeSession!.roundingStep ?? roundingStep, 'live'
          )
        );
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [device.activeSession, roundingStep]);

  const handleQuickStart = async (targetMins: number | null) => {
    try {
      setBusy(true);
      await onStartSession(device, controllerCount, targetMins, Boolean(targetMins && isPrepaid), targetMins && isPrepaid ? quickPaymentMethod : null);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveStartTime = () => {
    if (!device.activeSession) return;
    const h = parseInt(startHour, 10);
    const m = parseInt(startMinute, 10);
    if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
      void showNotice("Lütfen geçerli bir saat (00-23) ve dakika (00-59) girin.", { title: "Geçersiz Saat" });
      return;
    }
    const currentStart = new Date(device.activeSession.startedAt);
    const newStart = new Date(currentStart);
    newStart.setHours(h, m, 0, 0);

    if (newStart.getTime() > Date.now()) {
      void showNotice("Açılış saati gelecekte bir zaman olamaz.", { title: "Geçersiz Açılış Saati" });
      return;
    }
    if (Date.now() - newStart.getTime() > 12 * 60 * 60 * 1000) {
      void showNotice("Başlangıç saati en fazla 12 saat geriye alınabilir.", { title: "Geçersiz Açılış Saati" });
      return;
    }

    const oldFormatted = `${String(currentStart.getHours()).padStart(2, "0")}:${String(currentStart.getMinutes()).padStart(2, "0")}`;
    const newFormatted = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    setConfirmModal({
      title: "⏰ Açılış Saati Güncelleme",
      description: `${device.name} masasının açılış saati ${oldFormatted} yerine ${newFormatted} olarak güncellenecektir.\n\nMasanın toplam süresi ve kullanım ücreti yeni açılış saatine göre geriye dönük baştan hesaplanacaktır.\n\nBu değişikliği onaylıyor musunuz?`,
      onConfirm: async () => {
        try {
          setBusy(true);
          if (!await onUpdateSession(device, { startedAt: newStart.toISOString() })) return;
          setConfirmModal(null);
          setHasTimeChanged(false);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const handleControllerChange = (newCount: number) => {
    if (!device.activeSession || newCount === device.activeSession.controllerCount) return;
    const currentCount = device.activeSession.controllerCount;
    const oldName = currentCount === 2 ? "1-2 Kol" : `${currentCount} Kol`;
    const newName = newCount === 2 ? "1-2 Kol" : `${newCount} Kol`;

    setConfirmModal({
      title: "🎮 Kol Sayısı Değişikliği",
      description: `${device.name} masasının tarifesi "${oldName}" yerine "${newName}" olarak değiştirilecektir.\n\nŞu ana kadar geçen süre (${elapsedText}) eski tarife üzerinden dondurulacak, bundan sonraki süre ise ${newName} tarifesi üzerinden işlemeye devam edecektir.\n\nBu değişikliği onaylıyor musunuz?`,
      onConfirm: async () => {
        try {
          setBusy(true);
          if (!await onUpdateSession(device, { controllerCount: newCount })) return;
          setConfirmModal(null);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const isOccupied = Boolean(device.activeSession);
  const ordersTotal = device.activeSession?.ordersTotal ?? 0;
  const balance = sessionBalance(device.activeSession, timeAmount);

  return (
    <div className={`table-control-sidebar${confirmModal ? " has-confirmation" : ""}`}>
      {confirmModal && (
          <section ref={confirmationRef} className="sidebar-confirm-panel" role="group" aria-label={confirmModal.title} onKeyDown={event => { if (event.key === "Escape" && !busy) setConfirmModal(null); }}>
            <div className="sidebar-confirm-header">
              <h3 style={{ fontSize: "1.15rem", fontWeight: 800, color: "#fff" }}>{confirmModal.title}</h3>
              <button type="button" className="icon-btn" onClick={() => setConfirmModal(null)} disabled={busy} aria-label="Onayı kapat">✕</button>
            </div>
            <div className="sidebar-confirm-body">
              <p style={{ color: "#e2e8f0", fontSize: "0.92rem", lineHeight: "1.5", whiteSpace: "pre-line" }}>
                {confirmModal.description}
              </p>
            </div>
            <div className="sidebar-confirm-actions">
              <button type="button" className="secondary-btn" onClick={() => setConfirmModal(null)} disabled={busy}>
                Vazgeç
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => confirmModal.onConfirm()}
                style={{ background: "linear-gradient(135deg, #f43f5e 0%, #3b82f6 100%)", border: "none" }}
              >
                {busy ? "İşleniyor…" : "Onayla ve Değiştir"}
              </button>
            </div>
          </section>
      )}

      <div className="sidebar-header">
        <div>
          <h3>{device.name}</h3>
          <small style={{ color: "#9ca3af" }}>{device.categoryName ?? "Standart Tarife"}</small>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={`sidebar-badge ${isOccupied ? "mesgul" : "bos"}`}>
            {isOccupied ? "DOLU" : "BOŞ"}
          </span>
          <button className="sidebar-close-btn" data-site-tooltip="Kapat" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {!isOccupied ? (
        /* ========================================================
           BOŞ MASA GÖRÜNÜMÜ (Görsel 2)
           ======================================================== */
        <>
          <div className="sidebar-row">
            <span className="sidebar-row-label">Kol Tarife:</span>
            <div className="sidebar-row-val">
              <div style={{ display: "flex", gap: "0.3rem" }}>
                {[2, 3, 4].map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    className={`preset-btn ${controllerCount === cnt ? "active" : ""}`}
                    style={{ padding: "0.35rem 0.6rem", minWidth: "52px" }}
                    onClick={() => setControllerCount(cnt)}
                  >
                    {cnt === 2 ? "1-2 KOL" : `${cnt} KOL`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: "0.2rem" }}>
            <span className="sidebar-row-label" style={{ display: "block", marginBottom: "0.4rem" }}>
              Hızlı Süre Seçimi:
            </span>
            <div className="time-presets-grid">
              {[
                { label: "30 Dk", mins: 30 },
                { label: "45 Dk", mins: 45 },
                { label: "1 Saat", mins: 60 },
                { label: "1.5 Saat", mins: 90 },
                { label: "2 Saat", mins: 120 },
                { label: "2.5 Saat", mins: 150 },
              ].map((p) => (
                <button
                  key={p.mins}
                  type="button"
                  className={`preset-btn ${selectedMinutes === p.mins ? "active" : ""}`}
                  onClick={() => setSelectedMinutes(selectedMinutes === p.mins ? null : p.mins)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {selectedMinutes && (
            <div
              className={`prepaid-checkbox-label ${isPrepaid ? "active" : ""}`}
              onClick={() => setIsPrepaid(!isPrepaid)}
            >
              <div className="prepaid-custom-box">
                {isPrepaid ? "✓" : ""}
              </div>
              <span className="prepaid-checkbox-text">
                Ücreti Peşin Tahsil Edildi Olarak İşaretle
              </span>
            </div>
          )}

          {selectedMinutes && isPrepaid && (
            <div className="payment-method-subselector" style={{ marginTop: "0.8rem" }}>
              <label className="sub-label">Ödeme Yöntemi:</label>
              <div className="time-tabs">
                <button type="button" className={`time-tab ${quickPaymentMethod === "nakit" ? "active" : ""}`} onClick={() => setQuickPaymentMethod("nakit")}>💵 Nakit</button>
                <button type="button" className={`time-tab ${quickPaymentMethod === "kredi_karti" ? "active" : ""}`} onClick={() => setQuickPaymentMethod("kredi_karti")}>💳 Kredi Kartı</button>
              </div>
            </div>
          )}

          <div style={{ marginTop: "0.6rem" }}>
            {selectedMinutes ? (
              <button
                type="button"
                className="sidebar-start-btn-blue"
                disabled={busy}
                onClick={() => handleQuickStart(selectedMinutes)}
              >
                ⏱️ {selectedMinutes} DK SÜRELİ AÇ
              </button>
            ) : (
              <button
                type="button"
                className="sidebar-start-btn-green"
                disabled={busy}
                onClick={() => handleQuickStart(null)}
              >
                ▶ SÜRESİZ AÇ
              </button>
            )}
          </div>
        </>
      ) : (
        /* ========================================================
           AÇIK / DOLU MASA GÖRÜNÜMÜ (Görsel 1)
           ======================================================== */
        <>
          <div className="sidebar-row">
            <span className="sidebar-row-label">Tarife:</span>
            <div className="sidebar-row-val">
              <div style={{ display: "flex", gap: "0.3rem" }}>
                {[2, 3, 4].map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    disabled={busy}
                    className={`preset-btn ${device.activeSession?.controllerCount === cnt ? "active" : ""}`}
                    style={{ padding: "0.3rem 0.55rem", minWidth: "48px" }}
                    onClick={() => handleControllerChange(cnt)}
                  >
                    {cnt === 2 ? "1-2 KOL" : `${cnt} KOL`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="sidebar-row">
            <span className="sidebar-row-label">Açılış Saati:</span>
            <div className="sidebar-row-val">
              <div className="time-edit-group">
                <input
                  type="text"
                  maxLength={2}
                  className="time-num-input"
                  value={startHour}
                  onChange={(e) => {
                    setStartHour(e.target.value.replace(/\D/g, ""));
                    setHasTimeChanged(true);
                  }}
                  data-site-tooltip="Saat (00-23)"
                />
                <span style={{ fontWeight: 800, color: "#9ca3af" }}>:</span>
                <input
                  type="text"
                  maxLength={2}
                  className="time-num-input"
                  value={startMinute}
                  onChange={(e) => {
                    setStartMinute(e.target.value.replace(/\D/g, ""));
                    setHasTimeChanged(true);
                  }}
                  data-site-tooltip="Dakika (00-59)"
                />
                {hasTimeChanged && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    style={{ padding: "0.3rem 0.6rem", fontSize: "0.75rem", borderRadius: "4px" }}
                    onClick={handleSaveStartTime}
                    data-site-tooltip="Açılış Saatini Güncelle"
                  >
                    💾 Kaydet
                  </button>
                )}
              </div>
            </div>
          </div>

          {Boolean(device.activeSession?.targetMinutes) && (
            <div className="sidebar-row">
              <span className="sidebar-row-label">Kapanış Saati:</span>
              <div className="sidebar-row-val" style={{ fontWeight: 800, color: "#f43f5e", fontSize: "0.92rem", letterSpacing: "0.05em" }}>
                🏁 {closingTimeText}
              </div>
            </div>
          )}

          <div className="sidebar-row">
            <span className="sidebar-row-label">Geçen Süre:</span>
            <div className="sidebar-row-val">
              <div className="sidebar-live-timer" style={{ minWidth: "115px" }}>
                {elapsedText || "00:00:00"}
              </div>
            </div>
          </div>

          <div className="sidebar-row">
            <span className="sidebar-row-label">Kullanım Ücreti:</span>
            <div className="sidebar-row-val" style={{ fontWeight: 700, color: "#f8fafc" }}>
              {money(timeAmount)}
            </div>
          </div>

          <div className="sidebar-row">
            <span className="sidebar-row-label">Adisyon:</span>
            <div className="sidebar-row-val" style={{ fontWeight: 700, color: ordersTotal > 0 ? "#f59e0b" : "#9ca3af" }}>
              {money(ordersTotal)}
              {ordersTotal > 0 && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ marginLeft: "0.4rem", padding: "0.1rem 0.3rem", fontSize: "0.85rem" }}
                  data-site-tooltip="Adisyonu İncele"
                  onClick={() => onAddOrder(device)}
                >
                  👁️
                </button>
              )}
            </div>
          </div>

          <div className="sidebar-row">
            <span className="sidebar-row-label">Hesap Toplamı:</span>
            <div className="sidebar-row-val" style={{ fontWeight: 700 }}>{money(balance.total)}</div>
          </div>
          <div className="sidebar-row">
            <span className="sidebar-row-label">Alınan Ödeme:</span>
            <div className="sidebar-row-val" style={{ fontWeight: 700, color: "#34d399" }}>{money(balance.collected)}</div>
          </div>

          <div style={{ marginTop: "0.1rem" }}>
            <div style={{ fontSize: "0.72rem", color: "#9ca3af", marginBottom: "0.15rem", fontWeight: 700 }}>
              {balance.remaining === 0 ? "✅ ÖDENDİ · KALAN ÖDEME" : "KALAN ÖDEME"}
            </div>
            <div className="sidebar-total-card">
              {money(balance.remaining)}
            </div>
          </div>

          <div className="sidebar-action-grid" style={{ marginTop: "0.25rem" }}>
            <button
              type="button"
              className="sidebar-action-btn"
              onClick={() => onAddOrder(device)}
            >
              🍔 Adisyon Ekle
            </button>

            <button
              type="button"
              className="sidebar-action-btn pay-btn"
              onClick={() => onStopSession(device)}
            >
              🏁 Hesap Kes
            </button>

            <button
              type="button"
              className="sidebar-action-btn"
              onClick={() => onMoveDevice(device)}
            >
              🔀 Masa Değiştir
            </button>

            <button
              type="button"
              className="sidebar-action-btn free-btn"
              onClick={() => onFreeCheckout(device)}
            >
              🎁 Ücretsiz Kapat
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent = "" }: { label: string; value: string; accent?: string }) {
  return (
    <article className={`stat ${accent}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

type HistorySnapshot = { deviceName: string; hourlyRate: number; first30Rate: number; controllerCount: number; targetMinutes: number | null; startedAt: string; roundingStep: number };
type SessionHistory = { complete: boolean; settlement?: { paidGameAmount: number | null; paidOrdersAmount: number | null; freeGameAmount: number | null; freeOrdersAmount: number | null }; events: { id: string; type: string; message: string; createdAt: string; timestampEstimated?: boolean; before?: HistorySnapshot | null; after?: HistorySnapshot }[] };

function SessionHistoryDetails({ sessionId, token }: { sessionId: number; token: string }) {
  const [history, setHistory] = useState<SessionHistory | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<SessionHistory>(`/api/sessions/${sessionId}/history`, token, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setHistory(data); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Hareketler yüklenemedi."); });
    return () => controller.abort();
  }, [sessionId, token, attempt]);
  return <div className="session-history-details">
    <strong>Hesap hareketleri</strong>
    {error ? <p role="alert">{error} <button type="button" className="secondary compact-btn" onClick={() => setAttempt(v => v + 1)}>Yeniden dene</button></p> : !history ? <p>Hareketler yükleniyor…</p> : <>
      {history.settlement?.paidGameAmount != null && <p className="subtle">Oyun: tahsil edilen {money(history.settlement.paidGameAmount)} · ücretsiz {money(history.settlement.freeGameAmount ?? 0)}<br />Adisyon: tahsil edilen {money(history.settlement.paidOrdersAmount ?? 0)} · ücretsiz {money(history.settlement.freeOrdersAmount ?? 0)}</p>}
      {!history.complete && <p className="subtle">Bu hesapta hareket kaydı sonradan başladı. Önceki aktarım, kol ve süre değişiklikleri eksik olabilir.</p>}
      {history.events.length === 0 && <p>Bu hesaba ait kayıtlı hareket bulunmuyor.</p>}
      <ol>{history.events.map(event => <li key={event.id}>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("tr-TR")}{event.timestampEstimated ? " (tahmini)" : ""}</time>
        <div><strong>{event.message}</strong>
          {event.after && (event.type === "start" || event.type === "transfer" || event.type === "update") && <div className="subtle">
            {event.before && <>Önce: {event.before.deviceName} · İlk 30 dk {money(event.before.first30Rate)} · Saatlik {money(event.before.hourlyRate)}<br /></>}
            {event.before ? "Sonra" : "Açılış tarifesi"}: {event.after.deviceName} · İlk 30 dk {money(event.after.first30Rate)} · Saatlik {money(event.after.hourlyRate)}
            {event.type === "transfer" && <div>Süre: {event.before?.targetMinutes ? `${event.before.targetMinutes} dk` : "Süresiz"} → {event.after.targetMinutes ? `${event.after.targetMinutes} dk` : "Süresiz"}</div>}
          </div>}
        </div>
      </li>)}</ol>
    </>}
  </div>;
}

function ExpiredAlertList({ devices, checkoutOpen, onCheckout }: { devices: Device[]; checkoutOpen: boolean; onCheckout: (device: Device) => void }) {
  const [nowMs, setNowMs] = useState(Date.now());
  const hasTimedSession = devices.some(device => Boolean(device.activeSession?.targetMinutes));
  useEffect(() => {
    if (!hasTimedSession) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasTimedSession]);
  const expiredDevices = useMemo(() => devices
    .filter(device => {
      const session = device.activeSession;
      return Boolean(session?.targetMinutes && new Date(session.startedAt).getTime() + session.targetMinutes * 60_000 <= nowMs);
    })
    .sort((a, b) => {
      const first = a.activeSession!;
      const second = b.activeSession!;
      return new Date(first.startedAt).getTime() + first.targetMinutes! * 60_000
        - new Date(second.startedAt).getTime() - second.targetMinutes! * 60_000;
    }), [devices, nowMs]);
  if (checkoutOpen || expiredDevices.length === 0) return null;
  return <aside className="expired-alert-list" role="alert" aria-label="Süresi dolan masalar">
    <h3>⏰ Süresi Dolan Masalar ({expiredDevices.length})</h3>
    <p>Bu masaların süreleri ve ücretleri durdu. Hesapları sırayla kapatabilirsiniz.</p>
    {expiredDevices.map(device => {
      const session = device.activeSession!;
      const endedAt = new Date(new Date(session.startedAt).getTime() + session.targetMinutes! * 60_000);
      return <div className="expired-alert-item" key={session.id}>
        <div><strong>{device.name}</strong><small>Bitiş: {endedAt.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</small></div>
        <button type="button" onClick={() => onCheckout(device)}>Hesabı Kes</button>
      </div>;
    })}
  </aside>;
}

function ReportsModal({
  token,
  devices,
  initial,
  onClose,
}: {
  token: string;
  devices: Device[];
  initial?: { start: string; end: string; deviceId?: string; productName?: string } | null;
  onClose: () => void;
}) {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  const todayStartStr = `${year}-${month}-${day}T00:00`;
  const todayEndStr = `${year}-${month}-${day}T23:59`;

  const [mode, setMode] = useState<"today" | "custom">(initial ? "custom" : "today");
  const [startDate, setStartDate] = useState(initial?.start ?? todayStartStr);
  const [endDate, setEndDate] = useState(initial?.end ?? todayEndStr);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedHistorySessionId, setExpandedHistorySessionId] = useState<number | null>(null);

  const loadReports = async (start?: string, end?: string) => {
    setLoading(true);
    setError("");
    try {
      let query = "";
      if (start && end) {
        query = `?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`;
      } else {
        query = `?startDate=${encodeURIComponent(todayStartStr)}&endDate=${encodeURIComponent(todayEndStr)}`;
      }
      const data = await request<ReportData>(`/api/reports${query}`, token);
      setReportData(data);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raporlar yüklenemedi.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReports(startDate, endDate);
  }, [token]);

  const reportTableInitial = useMemo(() => initial ? { ...initial, start: startDate, end: endDate } : undefined, [initial, startDate, endDate]);
  const { filteredSessions, toolbar: reportToolbar, headers: reportHeaders, active: reportFiltersActive, deviceLabels } = useReportTable(reportData?.sessions ?? [], devices, lastUpdatedAt?.getTime() ?? Date.now(), reportTableInitial);

  const filteredStats = useMemo(() => {
    if (!reportData) return { totalDailyRevenue: 0, cashRevenue: 0, cardRevenue: 0, closedTodayCount: 0 };
    const closed = filteredSessions.filter(s => s.endedAt != null && s.closedInPeriod !== false);
    const revenueFor = (s: Session, method: string) =>
      (s.periodPayments ?? []).filter(p => p.paymentMethod === method).reduce((sum, p) => sum + p.amount, 0);
    const cashRevenue = filteredSessions.reduce((sum, s) => sum + revenueFor(s, "nakit"), 0);
    const cardRevenue = filteredSessions.reduce((sum, s) => sum + revenueFor(s, "kredi_karti"), 0);
    const totalDailyRevenue = cashRevenue + cardRevenue;

    const closedTodayCount = closed.filter(s => s.deviceId != null && s.paymentMethod !== "ucretsiz").length;
    return { totalDailyRevenue, cashRevenue, cardRevenue, closedTodayCount };
  }, [filteredSessions, reportData]);

  const [showDatePickerDialog, setShowDatePickerDialog] = useState(false);
  const [tempStartDate, setTempStartDate] = useState(startDate);
  const [tempEndDate, setTempEndDate] = useState(endDate);

  const openCustomDateDialog = () => {
    setTempStartDate(startDate);
    setTempEndDate(endDate);
    setShowDatePickerDialog(true);
  };

  const handleApplyCustomDate = (e: FormEvent) => {
    e.preventDefault();
    setStartDate(tempStartDate);
    setEndDate(tempEndDate);
    setMode("custom");
    setShowDatePickerDialog(false);
    void loadReports(tempStartDate, tempEndDate);
  };

  const [isFilterHovered, setIsFilterHovered] = useState(false);

  const handleCancelCustomDate = () => {
    setShowDatePickerDialog(false);
  };

  const selectToday = () => {
    setMode("today");
    setStartDate(todayStartStr);
    setEndDate(todayEndStr);
    void loadReports(todayStartStr, todayEndStr);
  };

  return (
    <div className="modal-backdrop">
      <div className={`modal-card wide reports-modal ${isFullscreen ? "fullscreen-modal" : ""}`}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
            <img src="/logo.jpg" alt="CAVE Logo" className="modal-header-logo" />
            <h3>📊 Salon İşlem & Oturum Raporları</h3>
            <button
              type="button"
              className="secondary compact-btn"
              onClick={() => setIsFullscreen(!isFullscreen)}
              data-site-tooltip={isFullscreen ? "Normal Boyuta Getir" : "Tam Ekran Yap"}
            >
              {isFullscreen ? "🗗 Normal Boyut" : "⛶ Tam Ekran"}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
            <div
              className={`header-filter-pill-container ${isFilterHovered ? "expanded" : "collapsed"}`}
              onMouseEnter={() => setIsFilterHovered(true)}
              onMouseLeave={() => setIsFilterHovered(false)}
              style={{ marginRight: "1rem" }}
            >
              <button
                type="button"
                className={`header-filter-btn ${mode === "today" ? "active-pill" : "inactive-pill"}`}
                onClick={mode === "today" ? undefined : selectToday}
                data-site-tooltip={mode === "today" ? "Bugünün İşlemleri (Aktif)" : "Bugünün İşlemlerini Göster"}
              >
                📅 Bugünün İşlemleri {!isFilterHovered && mode === "today" ? " ▾" : ""}
              </button>

              <button
                type="button"
                className={`header-filter-btn ${mode === "custom" ? "active-pill" : "inactive-pill"}`}
                onClick={openCustomDateDialog}
                data-site-tooltip={mode === "custom" ? "Özel Tarih Aralığı (Aktif)" : "Özel Tarih & Saat Aralığı Seç"}
              >
                📆 Özel Tarih & Saat Aralığı {!isFilterHovered && mode === "custom" ? " ▾" : ""}
              </button>
            </div>
            <ReliableButton type="button" className="icon-btn reports-close-btn" onActivate={onClose} aria-label="Raporları kapat">✕</ReliableButton>
          </div>
        </div>


        {reportData && (
          <section className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", margin: "0 0 1rem 0" }}>
            <Stat label={initial?.productName ? "İlgili Hesapların Tahsilatı" : reportFiltersActive ? "Filtrelenen Tahsilat" : mode === "today" ? "Bugün Toplam Ciro" : "Seçilen Dönem Ciro"} value={money(filteredStats.totalDailyRevenue)} accent="blue" />
            <Stat label="Nakit Tahsilat" value={money(filteredStats.cashRevenue)} accent="green" />
            <Stat label="Kredi Kartı / POS" value={money(filteredStats.cardRevenue)} accent="amber" />
            <Stat label="Tamamlanan Masa" value={String(filteredStats.closedTodayCount)} />
          </section>
        )}

        {reportData && reportToolbar}

        {loading ? (
          <div className="loading" style={{ padding: "2rem" }}>Veriler yükleniyor…</div>
        ) : error ? (
          <p className="error notice">{error}</p>
        ) : (
          <div className="reports-table-container">
            {reportData && (
              <table className="reports-table">
                <thead>
                  <tr>{reportHeaders}</tr>
                </thead>
                <tbody>
                  {filteredSessions.length > 0 ? (
                    filteredSessions.map((s) => {
                      const start = new Date(s.startedAt);
                      const end = s.endedAt ? new Date(s.endedAt) : new Date();
                      const durationMins = reportDuration(s, lastUpdatedAt?.getTime() ?? Date.now());
                      const hours = Math.floor(durationMins / 60);
                      const mins = durationMins % 60;
                      const durationStr = hours > 0 ? `${hours}sa ${mins}dk` : `${mins}dk`;

                      const ordersTotal = s.ordersTotal ?? 0;
                      const partialMethods = (s.ledgerPayments ?? s.partialPayments ?? []).reduce((totals, payment) => {
                        if (payment.paymentMethod === "nakit") totals.nakit += payment.amount;
                        if (payment.paymentMethod === "kredi_karti") totals.kredi_karti += payment.amount;
                        return totals;
                      }, { nakit: 0, kredi_karti: 0 });
                      const mixedPartialMethods = partialMethods.nakit > 0 && partialMethods.kredi_karti > 0;
                      const waivedAmount = (s.ledgerPayments ?? []).filter(payment => payment.paymentMethod === "ucretsiz").reduce((sum, payment) => sum + payment.amount, 0);

                      return (
                        <Fragment key={s.id}>
                        <tr className={!s.endedAt ? "row-active-session" : ""}>
                          <td>
                            <strong>{s.deviceId == null ? s.deviceName : deviceLabels.get(String(s.deviceId)) ?? s.deviceName}</strong>
                            {s.categoryName !== null && (
                              <small className="subtle-tag">{s.categoryName ?? "Genel"}</small>
                            )}
                          </td>
                          <td>
                            <div>{start.toLocaleDateString("tr-TR")}</div>
                            <strong>{start.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</strong>
                          </td>
                          <td>
                            {s.endedAt ? (
                              <>
                                <div>{end.toLocaleDateString("tr-TR")}</div>
                                <strong>{end.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</strong>
                              </>
                            ) : (
                              <span className="status-badge status-mesgul">🟢 Canlı Açık</span>
                            )}
                          </td>
                          <td>
                            {s.categoryName !== null ? (
                              <strong>{durationStr}</strong>
                            ) : (
                              <span className="subtle-dash">-</span>
                            )}
                          </td>
                          <td>
                            {s.categoryName !== null ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                                <span>K: <strong>{s.controllerCount ?? 1}</strong></span>
                                {s.targetMinutes ? (
                                  <span style={{ color: "var(--accent-blue)", fontSize: "0.85rem" }}>
                                    ⏱️ {s.targetMinutes} Dk
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--accent-green)", fontSize: "0.85rem" }}>
                                    ♾️ Süresiz
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="subtle-dash">-</span>
                            )}
                          </td>
                          <td>
                            {s.categoryName !== null ? (
                              <>
                                <strong>{money(ordersTotal)}</strong>
                              </>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                                {s.orderItems && s.orderItems.map(oi => (
                                  <span key={oi.id} style={{ fontSize: "0.85rem" }}>
                                    {oi.quantity}x {oi.productName}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td>
                            <div className="report-payment-with-history">
                            <div>
                            {(s.partialPaidAmount ?? 0) > 0 || mixedPartialMethods || waivedAmount > 0 || s.closureMethod === "ucretsiz" || s.ledgerPayments?.some(payment => payment.kind === "orders") ? (
                              <div className={`report-payment-pairs ${mixedPartialMethods || waivedAmount > 0 ? "mixed" : ""}`}>
                                {(["nakit", "kredi_karti"] as const).filter(method => partialMethods[method] > 0).map(method => (
                                  <div className="report-payment-pair" key={method}>
                                    <strong className="report-amount">{money(partialMethods[method])}</strong>
                                    <span className={`method-badge ${method === "nakit" ? "cash" : "card"}`}>
                                      {method === "nakit" ? "Nakit" : "Kredi Kartı"}
                                    </span>
                                  </div>
                                ))}
                                {waivedAmount > 0 && <div className="report-payment-pair"><strong className="report-amount report-amount-free">{money(waivedAmount)}</strong><span className="method-badge unpaid">Ücretsiz</span></div>}
                              </div>
                            ) : s.checkoutPaymentMethod && s.checkoutAmount && s.checkoutAmount > 0 ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85em" }}>
                                  <strong className={`report-amount ${s.paymentMethod === "ucretsiz" ? "report-amount-free" : ""}`}>
                                    {s.paymentMethod === "ucretsiz" ? "Ücretsiz" : money(s.prepaidAmount ?? 0)}
                                  </strong>
                                  <span className={`method-badge ${s.paymentMethod === "kredi_karti" ? "card" : "cash"}`}>
                                    {s.paymentMethod === "kredi_karti" ? "Kredi Kartı" : "Nakit"}
                                  </span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85em" }}>
                                  <strong className={`report-amount`}>
                                    {money(s.checkoutAmount)}
                                  </strong>
                                  <span className={`method-badge ${s.checkoutPaymentMethod === "kredi_karti" ? "card" : "cash"}`}>
                                    {s.checkoutPaymentMethod === "kredi_karti" ? "Kredi Kartı" : "Nakit"}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <>
                                <strong className={`report-amount ${s.paymentMethod === "ucretsiz" ? "report-amount-free" : ""}`}>
                                  {s.paymentMethod === "ucretsiz" ? "Ücretsiz" : money(s.totalAmount ?? 0)}
                                </strong>
                                {s.paymentMethod !== "ucretsiz" && (
                                  <span className={`method-badge ${!s.endedAt ? "unpaid" : s.paymentMethod === "kredi_karti" ? "card" : "cash"}`}>
                                    {!s.endedAt ? "Açık Masa" : s.paymentMethod === "kredi_karti" ? "Kredi Kartı" : "Nakit"}
                                  </span>
                                )}
                              </>
                            )}
                            </div>
                            {s.id > 0 && <button type="button" className="secondary compact-btn report-history-toggle" aria-expanded={expandedHistorySessionId === s.id} onClick={() => setExpandedHistorySessionId(previous => previous === s.id ? null : s.id)}>Hareketler {expandedHistorySessionId === s.id ? "▴" : "▾"}</button>}
                            </div>
                          </td>
                        </tr>
                        {expandedHistorySessionId === s.id && <tr><td colSpan={7}><SessionHistoryDetails sessionId={s.id} token={token} /></td></tr>}
                        </Fragment>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", height: "300px", verticalAlign: "middle", color: "var(--text-muted)", borderBottom: "none" }}>
                        {reportFiltersActive ? "Seçili filtrelere uygun kayıt bulunamadı. Filtreleri değiştirebilir veya temizleyebilirsiniz." : "Seçilen tarih aralığında kayıt bulunamadı."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
        <footer className="reports-refresh-footer">
          <span aria-live="polite">
            Son güncelleme: {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString("tr-TR") : "—"}
          </span>
          <button
            type="button"
            className="secondary compact-btn"
            disabled={loading}
            onClick={() => void loadReports(mode === "today" ? todayStartStr : startDate, mode === "today" ? todayEndStr : endDate)}
            data-site-tooltip="Seçili tarih aralığındaki raporu yenile"
          >
            {loading ? "Yenileniyor…" : "↻ Yenile"}
          </button>
        </footer>
      </div>

      {showDatePickerDialog && <ReportDateRangeDialog start={tempStartDate} end={tempEndDate} onStartChange={setTempStartDate} onEndChange={setTempEndDate} onApply={handleApplyCustomDate} onClose={handleCancelCustomDate} />}
    </div>
  );
}




function AddDeviceModal({
  categories,
  onClose,
  onAdd,
}: {
  categories: Category[];
  onClose: () => void;
  onAdd: (name: string, categoryId: number | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(categories[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onAdd(name.trim(), categoryId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h3>➕ Yeni Masa Ekle</h3>
          <button type="button" className="icon-btn" aria-label="Yeni masa penceresini kapat" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit}>
          <label>
            Masa Adı
            <input
              autoFocus
              type="text"
              placeholder="Örn: Masa 5 veya VIP-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Cihaz Çeşidi / Kategori
            <SiteSelect
              value={categoryId ?? ""}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Seçimsiz (Genel - 100 TL/saat)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({money(c.baseRate)}/saat)
                </option>
              ))}
            </SiteSelect>
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button disabled={busy}>{busy ? "Ekleniyor…" : "Masa Oluştur"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditDeviceModal({
  device,
  categories,
  onClose,
  onSave,
}: {
  device: Device;
  categories: Category[];
  onClose: () => void;
  onSave: (name: string, categoryId: number | null) => Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  const [categoryId, setCategoryId] = useState<number | null>(device.categoryId);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave(name.trim(), categoryId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h3>✏️ Masa Düzenle</h3>
        <form onSubmit={submit}>
          <label>
            Masa Adı
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Cihaz Çeşidi / Kategori
            <SiteSelect
              value={categoryId ?? ""}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Seçimsiz (Genel - 100 TL/saat)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({money(c.baseRate)}/saat)
                </option>
              ))}
            </SiteSelect>
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button disabled={busy}>{busy ? "Kaydediliyor…" : "Güncelle"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StartSessionModal({
  device,
  categories,
  roundingStep,
  onClose,
  onStart,
}: {
  device: Device;
  categories: Category[];
  roundingStep: number;
  onClose: () => void;
  onStart: (controllerCount: number, targetMinutes: number | null, isPaid: boolean, paymentMethod?: "nakit" | "kredi_karti" | null, startedAt?: string) => Promise<void>;
}) {
  const [isTimed, setIsTimed] = useState(false);
  const [timedMode, setTimedMode] = useState<"minutes" | "price">("minutes");

  const [activeMinutePreset, setActiveMinutePreset] = useState<number | null>(null);
  const [targetMinutesInput, setTargetMinutesInput] = useState<string>("");
  const [activePricePresetMinutes, setActivePricePresetMinutes] = useState<number | null>(null);
  const [targetPriceInput, setTargetPriceInput] = useState<string>("");
  const [controllerCount, setControllerCount] = useState<number>(2);

  // Payment status for timed sessions
  const [isPaid, setIsPaid] = useState<boolean>(true);
  const [paymentMethod, setPaymentMethod] = useState<"nakit" | "kredi_karti">("nakit");
  const [busy, setBusy] = useState(false);

  // Custom start time (for backdated sessions)
  const now = new Date();
  const [startHour, setStartHour] = useState<string>(String(now.getHours()).padStart(2, "0"));
  const [startMinute, setStartMinute] = useState<string>(String(now.getMinutes()).padStart(2, "0"));

  const customStartDate = (() => {
    const d = new Date();
    const h = Math.min(23, Math.max(0, parseInt(startHour, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt(startMinute, 10) || 0));
    d.setHours(h, m, 0, 0);
    // If the resulting time is in the future, subtract one day
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d;
  })();
  const elapsedMs = Date.now() - customStartDate.getTime();
  const elapsedMinutes = Math.round(elapsedMs / 60_000);
  const isBackdated = elapsedMinutes > 1;

  const cat = categories.find((c) => c.id === device.categoryId);
  const { hourlyRate: calculatedHourlyRate, first30Rate: calculatedFirst30Rate } = rateForControllers(tariffRates(cat), controllerCount);

  let finalTargetMinutes: number | null = null;
  let estimatedTotal = 0;

  if (isTimed) {
    if (timedMode === "minutes") {
      const mins = activeMinutePreset !== null ? activeMinutePreset : (Number(targetMinutesInput) || 0);
      finalTargetMinutes = mins;
    } else {
      finalTargetMinutes = activePricePresetMinutes !== null
        ? activePricePresetMinutes
        : calculateMinutesFromPrice(Number(targetPriceInput) || 0, calculatedHourlyRate, calculatedFirst30Rate, roundingStep);
    }
    if (finalTargetMinutes > 0) estimatedTotal = calculatePriceForMinutes(finalTargetMinutes, calculatedHourlyRate, calculatedFirst30Rate, roundingStep);
  }

  const isSubmitDisabled = busy || (isTimed && (!finalTargetMinutes || !Number.isInteger(finalTargetMinutes) || finalTargetMinutes < 1 || finalTargetMinutes > 1440));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled) return;
    setBusy(true);
    try {
      await onStart(
        controllerCount,
        isTimed ? Math.max(1, finalTargetMinutes ?? 0) : null,
        isTimed ? isPaid : false,
        isTimed && isPaid ? paymentMethod : null,
        isBackdated ? customStartDate.toISOString() : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop start-session-backdrop">
      <div className="modal-card wide start-session-modal">
        <div className="modal-header">
          <h3>▶️ Masa Aç — {device.name}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p className="modal-sub start-tariff-summary">
          Çeşit: <strong>{device.categoryName ?? "Genel"}</strong> (Açılış: {money(calculatedFirst30Rate)} · Saatlik: {money(calculatedHourlyRate)})
        </p>

        <form className="start-session-form" onSubmit={submit}>
          {/* --- Start Time Section --- */}
          <div className="form-group start-time-section">
            <label className="section-label">1. Açılış Saati</label>
            <div className="start-time-row" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <div className="start-clock" style={{
                display: "flex", alignItems: "center", gap: "0.3rem",
                background: "var(--bg-2, rgba(255,255,255,0.05))",
                border: "1px solid var(--border, rgba(255,255,255,0.12))",
                borderRadius: "10px", padding: "0.35rem 0.55rem"
              }}>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  value={startHour}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setStartHour(v);
                  }}
                  onBlur={(e) => setStartHour(String(Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0))).padStart(2, "0"))}
                  style={{
                    width: "2.3rem", textAlign: "center", fontSize: "1.15rem", fontWeight: 700,
                    background: "transparent", border: "none", color: "inherit", outline: "none", margin: 0, padding: 0
                  }}
                />
                <span style={{ fontSize: "1.15rem", fontWeight: 700, opacity: 0.6 }}>:</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={2}
                  value={startMinute}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setStartMinute(v);
                  }}
                  onBlur={(e) => setStartMinute(String(Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0))).padStart(2, "0"))}
                  style={{
                    width: "2.3rem", textAlign: "center", fontSize: "1.15rem", fontWeight: 700,
                    background: "transparent", border: "none", color: "inherit", outline: "none", margin: 0, padding: 0
                  }}
                />
              </div>
              <button
                type="button"
                style={{
                  fontSize: "0.75rem", padding: "0.35rem 0.75rem",
                  background: "var(--bg-2, rgba(255,255,255,0.08))",
                  border: "1px solid var(--border, rgba(255,255,255,0.12))",
                  borderRadius: "8px", cursor: "pointer", color: "inherit", opacity: 0.75
                }}
                onClick={() => {
                  const n = new Date();
                  setStartHour(String(n.getHours()).padStart(2, "0"));
                  setStartMinute(String(n.getMinutes()).padStart(2, "0"));
                }}
              >
                🕒 Şimdi
              </button>
              {isBackdated ? (
                <span style={{
                  fontSize: "0.8rem", padding: "0.3rem 0.65rem",
                  background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.4)",
                  borderRadius: "8px", color: "#f59e0b", fontWeight: 600
                }}>
                  ⚠️ {elapsedMinutes} dk önce açıldı sayılacak
                </span>
              ) : (
                <span style={{ fontSize: "0.8rem", opacity: 0.5 }}>(Şu an)
                </span>
              )}
            </div>
          </div>

          <div className="form-group">
            <label className="section-label">2. Oturum Türü</label>
            <div className="type-selector">
              <button
                type="button"
                className={`type-option ${!isTimed ? "active" : ""}`}
                onClick={() => setIsTimed(false)}
              >
                ♾️ Süresiz Oturum
              </button>
              <button
                type="button"
                className={`type-option ${isTimed ? "active" : ""}`}
                onClick={() => setIsTimed(true)}
              >
                ⏱️ Süreli Oturum
              </button>
            </div>
          </div>

          {isTimed && (
            <div className="form-group timed-section">
              <label className="section-label">3. Süre Seçimi</label>
              <div className="time-tabs start-time-mode-tabs">
                <button
                  type="button"
                  className={`time-tab ${timedMode === "minutes" ? "active" : ""}`}
                  onClick={() => setTimedMode("minutes")}
                >
                  ⏱️ Dakika
                </button>
                <button
                  type="button"
                  className={`time-tab ${timedMode === "price" ? "active" : ""}`}
                  onClick={() => setTimedMode("price")}
                >
                  💵 Bütçe (TL)
                </button>
              </div>

              {timedMode === "minutes" ? (
                <div className="minute-presets start-presets">
                  {[30, 60, 90, 120].map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      className={`preset-btn ${activeMinutePreset === mins ? "active" : ""}`}
                      onClick={() => {
                        setActiveMinutePreset(mins);
                        setTargetMinutesInput("");
                      }}
                    >
                      {mins} Dk
                    </button>
                  ))}
                  <div className="start-custom-input">
                    <input
                      type="text"
                      placeholder="Özel (Dk)"
                      value={targetMinutesInput}
                      onChange={(e) => {
                        let val = e.target.value.replace(/[^0-9.]/g, "");
                        const parts = val.split(".");
                        if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                        setTargetMinutesInput(val);
                        if (val) setActiveMinutePreset(null);
                      }}
                      style={{ width: "100%", margin: 0 }}
                    />
                  </div>
                </div>
              ) : (
                <div className="minute-presets start-presets">
                  {[30, 60, 90, 120].map((mins) => {
                    const p = calculatePriceForMinutes(mins, calculatedHourlyRate, calculatedFirst30Rate, roundingStep);
                    return (
                      <button
                        key={mins}
                        type="button"
                        className={`preset-btn ${activePricePresetMinutes === mins ? "active" : ""}`}
                        onClick={() => {
                          setActivePricePresetMinutes(mins);
                          setTargetPriceInput("");
                        }}
                      >
                        {money(p)}
                      </button>
                    );
                  })}
                  <div className="start-custom-input">
                    <input
                      type="text"
                      placeholder="Özel (TL)"
                      value={targetPriceInput}
                      onChange={(e) => {
                        let val = e.target.value.replace(/[^0-9.]/g, "");
                        const parts = val.split(".");
                        if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                        setTargetPriceInput(val);
                        if (val) setActivePricePresetMinutes(null);
                      }}
                      style={{ width: "100%", margin: 0 }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="form-group">
            <label className="section-label">{isTimed ? "4. Kol Sayısı" : "3. Kol Sayısı"}</label>
            <div className="time-tabs start-controller-tabs">
              <button
                type="button"
                className={`time-tab ${controllerCount <= 2 ? "active" : ""}`}
                onClick={() => setControllerCount(2)}
              >
                🎮 1-2 Kol
              </button>
              <button
                type="button"
                className={`time-tab ${controllerCount === 3 ? "active" : ""}`}
                onClick={() => setControllerCount(3)}
              >
                🎮 3 Kol
              </button>
              <button
                type="button"
                className={`time-tab ${controllerCount === 4 ? "active" : ""}`}
                onClick={() => setControllerCount(4)}
              >
                🎮 4 Kol
              </button>
            </div>
          </div>

          {isTimed && (
            <div className="form-group">
              <label className="section-label">5. Ödeme Durumu</label>
              <div className="time-tabs start-payment-tabs">
                <button
                  type="button"
                  className={`time-tab ${!isPaid ? "active" : ""}`}
                  onClick={() => setIsPaid(false)}
                  style={!isPaid ? { backgroundColor: "var(--color-danger-alpha)", borderColor: "var(--color-danger)", color: "var(--color-danger)" } : {}}
                >
                  Sonra Ödenecek
                </button>
                <button
                  type="button"
                  className={`time-tab ${isPaid ? "active" : ""}`}
                  onClick={() => setIsPaid(true)}
                  style={isPaid ? { backgroundColor: "var(--color-success-alpha)", borderColor: "var(--color-success)", color: "var(--color-success)" } : {}}
                >
                  Peşin Ödendi
                </button>
              </div>

              {isPaid && (
                <div className="time-tabs start-method-tabs">
                  <button
                    type="button"
                    className={`time-tab ${paymentMethod === "nakit" ? "active" : ""}`}
                    onClick={() => setPaymentMethod("nakit")}
                  >
                    💵 Nakit
                  </button>
                  <button
                    type="button"
                    className={`time-tab ${paymentMethod === "kredi_karti" ? "active" : ""}`}
                    onClick={() => setPaymentMethod("kredi_karti")}
                  >
                    💳 Kredi Kartı
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="modal-actions start-session-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button className="start-session-submit" disabled={isSubmitDisabled}>
              {busy ? "Açılıyor…" : isTimed ? (finalTargetMinutes && Number.isInteger(finalTargetMinutes) && finalTargetMinutes <= 1440 ? `🚀 Masayı Aç (${finalTargetMinutes} Dk - ${money(estimatedTotal)})` : (timedMode === "minutes" ? "Lütfen Dakika Belirleyiniz" : "Lütfen Fiyat Belirleyiniz")) : "🚀 Masayı Aç"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type SplitMethod = "nakit" | "kredi_karti";
type SplitShare = { amount: string; paymentMethod: SplitMethod };
type SplitPayment = { amount: number; paymentMethod: SplitMethod };

function usePaymentSplit(amount: number, defaultMethod: SplitMethod) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<SplitShare[]>([]);
  useEffect(() => { setShares([]); }, [amount]);
  const choose = (count: 2 | 3 | 4) => {
    const cents = Math.round(amount * 100);
    const unit = cents % 100 === 0 && amount >= count ? 100 : 1;
    const blocks = Math.floor(cents / unit);
    const base = Math.floor(blocks / count);
    const remainder = blocks % count;
    let allocated = 0;
    setShares(Array.from({ length: count }, (_, index) => {
      const shareCents = index === count - 1 ? cents - allocated : (base + (index < remainder ? 1 : 0)) * unit;
      allocated += shareCents;
      return { amount: String(shareCents / 100), paymentMethod: defaultMethod };
    }));
  };
  const changeAmount = (index: number, amountText: string) => setShares(previous => {
    const next = previous.map(share => ({ ...share }));
    next[index].amount = amountText;
    const entered = next.slice(0, -1).reduce((sum, share) => sum + (Number(share.amount) || 0), 0);
    next[next.length - 1].amount = String(Math.max(0, Math.round((amount - entered) * 100) / 100));
    return next;
  });
  const changeMethod = (index: number, paymentMethod: SplitMethod) => setShares(previous => previous.map((share, current) => current === index ? { ...share, paymentMethod } : share));
  const payments = shares.length >= 2 && shares.every(share => {
    const value = Number(share.amount);
    return Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
  }) && Math.round(shares.reduce((sum, share) => sum + Number(share.amount), 0) * 100) === Math.round(amount * 100)
    ? shares.map(share => ({ amount: Number(share.amount), paymentMethod: share.paymentMethod })) : null;
  return { open, shares, payments, choose, changeAmount, changeMethod, toggle: () => { setOpen(previous => !previous); setShares([]); } };
}

function PaymentSplitFields({ amount, split, busy }: { amount: number; split: ReturnType<typeof usePaymentSplit>; busy: boolean }) {
  if (!split.open) return null;
  return <div className="payment-split">
    <div className="payment-split-content">
      <div className="payment-split-counts" aria-label="Pay sayısı">
        {([2, 3, 4] as const).map(count => <button key={count} type="button" className={split.shares.length === count ? "active" : ""} aria-pressed={split.shares.length === count} disabled={busy || amount < count / 100} onClick={() => split.choose(count)}>{count}'ye böl</button>)}
      </div>
      {split.shares.map((share, index) => <div className="payment-split-row" key={index}>
        <span className="payment-split-row-label">{index + 1}. Pay</span>
        {index === split.shares.length - 1 ? <strong className="payment-split-remainder">{money(Number(share.amount))}</strong> : <label className="payment-split-amount"><span className="sr-only">{index + 1}. pay tutarı</span><input type="number" inputMode="decimal" min="0.01" step="0.01" value={share.amount} disabled={busy} onChange={event => split.changeAmount(index, event.target.value)} aria-label={`${index + 1}. pay tutarı`} /></label>}
        <div className="payment-split-methods" aria-label={`${index + 1}. pay ödeme yöntemi`}>
          <button type="button" className={share.paymentMethod === "nakit" ? "active" : ""} aria-pressed={share.paymentMethod === "nakit"} disabled={busy} onClick={() => split.changeMethod(index, "nakit")}>Nakit</button>
          <button type="button" className={share.paymentMethod === "kredi_karti" ? "active" : ""} aria-pressed={share.paymentMethod === "kredi_karti"} disabled={busy} onClick={() => split.changeMethod(index, "kredi_karti")}>Kredi Kartı</button>
        </div>
      </div>)}
      {split.shares.length > 0 && <small className={split.payments ? "payment-split-valid" : "payment-split-error"}>{split.payments ? `Toplam ${money(amount)} · Paylar hazır` : "Paylar pozitif olmalı ve toplamı tahsil edilecek tutara eşit olmalı."}</small>}
    </div>
  </div>;
}

function PaymentSplitToggle({ split, busy }: { split: ReturnType<typeof usePaymentSplit>; busy: boolean }) {
  return <button type="button" className={`payment-split-toggle ${split.open ? "active" : ""}`} aria-expanded={split.open} disabled={busy} onClick={split.toggle}>÷ Ödemeyi böl <span aria-hidden="true">{split.open ? "▾" : "▴"}</span></button>;
}

function MarkPaidModal({ device, onClose, onConfirm }: { device: Device; onClose: () => void; onConfirm: (method: SplitMethod, includeOrders: boolean, expectedAmount: number, payments?: SplitPayment[]) => Promise<boolean> }) {
  const [method, setMethod] = useState<"nakit" | "kredi_karti">("nakit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [includeOrders, setIncludeOrders] = useState(false);
  const session = device.activeSession;
  const ordersRemaining = Math.max(0, (session?.gameAmount ?? 0) + (session?.ordersTotal ?? 0) - (session?.collectedAmount ?? 0) - (session?.gameRemaining ?? 0));
  const amount = Math.round(((session?.gameRemaining ?? 0) + (includeOrders ? ordersRemaining : 0)) * 100) / 100;
  const split = usePaymentSplit(amount, method);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || amount <= 0 || (split.open && !split.payments)) return;
    setBusy(true);
    setError("");
    try { await onConfirm(split.payments?.[0].paymentMethod ?? method, includeOrders, amount, split.payments ?? undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Ödeme kaydedilemedi."); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><div className="modal-card wide payment-modal">
    <div className="modal-header"><h3>Ödeme Al — {device.name}</h3><button type="button" className="icon-btn" disabled={busy} onClick={onClose}>✕</button></div>
    <form onSubmit={submit}>
      <div className="checkout-summary-box">
        {session && <div className="checkout-row">
          <span>⏰ Masa Açılış Saati:</span>
          <strong>{new Date(session.startedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong>
        </div>}
        <div className="checkout-row highlight-row">
          <span>🎮 Oyun Süresi / Kol Sayısı:</span>
          <strong>{session?.targetMinutes} Dakika · {session?.controllerCount} Kol</strong>
        </div>
        <div className="checkout-divider" />
        <div className="checkout-row"><span>🎮 Masa Oturum Ücreti:</span><strong>{money(session?.gameAmount ?? 0)}</strong></div>
        {includeOrders && ordersRemaining > 0 && <div className="checkout-row"><span>🍟 Dahil Edilen Adisyon:</span><strong>{money(ordersRemaining)}</strong></div>}
        {(session?.collectedAmount ?? 0) > 0 && <div className="checkout-row"><span>Önceden Alınan Ödemeler:</span><strong>{money(session?.collectedAmount ?? 0)}</strong></div>}
        <div className="checkout-grand-total">
          <span>{includeOrders ? "TAHSİL EDİLECEK TOPLAM TUTAR" : "TAHSİL EDİLECEK OYUN ÜCRETİ"}</span>
          <strong className="grand-total-amount">{money(amount)}</strong>
        </div>
      </div>
      <div className="prepaid-alert-banner" style={{ marginBottom: "1rem" }}>
        <div className="prepaid-alert-icon">ℹ️</div>
        <div className="prepaid-alert-content">
          <strong>Masa açık kalır, süre işlemeye devam eder.</strong>
          {ordersRemaining > 0 && <>
            <span style={{ color: includeOrders ? "#34d399" : "#ef4444" }}>{includeOrders ? "Adisyon ödemeye dahil edildi." : "Adisyon bu ödemeye dahil değildir."} Adisyon tutarı: <strong style={{ color: "inherit" }}>{money(ordersRemaining)}</strong>.</span>
            <label className={`include-orders-switch ${busy ? "is-disabled" : ""}`}>
              <span>Adisyonu ödemeye dahil et</span>
              <input type="checkbox" role="switch" checked={includeOrders} disabled={busy} onChange={event => setIncludeOrders(event.target.checked)} />
              <span className="include-orders-switch-track" aria-hidden="true" />
            </label>
          </>}
        </div>
      </div>
      {!split.open && <div className="form-group" style={{ marginTop: "1rem" }}>
        <label className="section-label">Ödeme Yöntemi</label>
        <div className="type-selector">
          <button type="button" className={`type-option ${method === "nakit" ? "active" : ""}`} aria-pressed={method === "nakit"} disabled={busy} onClick={() => setMethod("nakit")}>💵 Nakit Ödeme</button>
          <button type="button" className={`type-option ${method === "kredi_karti" ? "active" : ""}`} aria-pressed={method === "kredi_karti"} disabled={busy} onClick={() => setMethod("kredi_karti")}>💳 Kredi Kartı / POS</button>
        </div>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      <PaymentSplitFields amount={amount} split={split} busy={busy} />
      <div className="modal-actions payment-modal-actions">
        {amount > 0 && <PaymentSplitToggle split={split} busy={busy} />}
        <div className="payment-modal-actions-right">
          <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>⬅️ Geri (İptal)</button>
          <button type="submit" className="primary-glow" disabled={busy || amount <= 0 || (split.open && !split.payments)}>{busy ? "Kaydediliyor…" : "💵 Ödemeyi Al"}</button>
        </div>
      </div>
    </form>
  </div></div>;
}

function CheckoutModal({
  device,
  partial = false,
  roundingStep,
  onClose,
  onConfirmCheckout,
  onFreezeCheckout,
}: {
  device: Device;
  partial?: boolean;
  roundingStep: number;
  onClose: () => void;
  onConfirmCheckout: (paymentMethod: "nakit" | "kredi_karti" | "ucretsiz", endedAt?: string, amount?: number, payments?: SplitPayment[]) => Promise<void>;
  onFreezeCheckout?: () => Promise<string | undefined>;
}) {
  const session = device.activeSession;
  if (!session) return null;

  const [nowMs, setNowMs] = useState(Date.now());
  const [holdError, setHoldError] = useState("");
  useEffect(() => {
    if (partial) {
      const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    let cancelled = false;
    if (!onFreezeCheckout) return;
    onFreezeCheckout().then(endedAt => {
      if (cancelled || !endedAt) return;
      const held = Date.parse(endedAt);
      if (!Number.isNaN(held)) setNowMs(held);
    }).catch(error => {
      if (!cancelled) setHoldError(error instanceof Error ? error.message : "Kapanış zamanı kilitlenemedi.");
    });
    return () => { cancelled = true; };
  }, [partial, session.id]);
  const startMs = new Date(session.startedAt).getTime();

  let calcTime = nowMs;
  if (session.targetMinutes) {
    const targetMs = session.targetMinutes * 60 * 1000;
    const endTime = startMs + targetMs;
    if (nowMs > endTime) {
      calcTime = endTime;
    }
  }

  const totalElapsedMinutes = Math.max(1, Math.round((calcTime - startMs) / 60_000));

  const hoursPlayed = Math.floor(totalElapsedMinutes / 60);
  const minsPlayed = totalElapsedMinutes % 60;

  const timeCost = session.packageAmount ?? calculateAmount(
    session.startedAt,
    session.hourlyRate,
    session.first30Rate,
    calcTime,
    session.accruedAmount ?? 0,
    session.segmentStartedAt,
    session.targetMinutes,
    session.roundingStep ?? roundingStep
  );

  const ordersTotal = session.ordersTotal ?? 0;
  const orderItems = session.orderItems ?? [];
  const fullTotal = Math.round((timeCost + ordersTotal) * 100) / 100;

  // Pre-select payment method if specified during start
  const initialPaymentMethod = session.paymentMethod ?? "nakit";
  const [paymentMethod, setPaymentMethod] = useState<"nakit" | "kredi_karti" | "ucretsiz">(initialPaymentMethod);
  const [showOrderDetails, setShowOrderDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentError, setPaymentError] = useState("");

  const prepaidAmount = session.prepaidAmount ?? 0;
  const collected = session.collectedAmount ?? prepaidAmount + (session.partialPaidAmount ?? 0);
  const amountToCollect = Math.round(Math.max(0, fullTotal - collected) * 100) / 100;
  const split = usePaymentSplit(amountToCollect, paymentMethod === "kredi_karti" ? "kredi_karti" : "nakit");
  const titleText = amountToCollect === 0 ? "✅ TUTAR TAHSİL EDİLDİ" : "TAHSİL EDİLECEK TOPLAM TUTAR";
  const unpaidGame = Math.min(amountToCollect, Math.max(0, timeCost - (session.gamePaymentCredit ?? collected)));
  const unpaidOrders = Math.round((amountToCollect - unpaidGame) * 100) / 100;
  const unpaidReasons = unpaidGame > 0.001 ? [...(session.paymentDifferenceReasons ?? [])] : [];
  // An ordinary partial payment leaves part of the original game fee unpaid; it is not an added-time charge.
  const hasUnclassifiedGameBalance = unpaidGame > 0.001 && unpaidReasons.length === 0;
  if (unpaidOrders > 0.001 && !hasUnclassifiedGameBalance) unpaidReasons.push("Adisyon");
  const reasonOrder: Record<string, number> = { "Ek Süre": 0, "Süre": 0, "Oyun Ücreti": 0, "Adisyon": 1, "Kol Artışı": 2 };
  const reasonLabels = unpaidReasons
    .sort((a, b) => (reasonOrder[a] ?? 3) - (reasonOrder[b] ?? 3))
    .map(reason => reason.toLocaleUpperCase("tr-TR"));
  const differenceReason = reasonLabels.length > 1
    ? `${reasonLabels.slice(0, -1).join(", ")} VE ${reasonLabels[reasonLabels.length - 1]}`
    : reasonLabels[0] ?? "";
  const refundAmount = Math.round(Math.max(0, collected - fullTotal) * 100) / 100;
  const enteredAmount = Number(paymentAmount);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (partial && (!Number.isFinite(enteredAmount) || enteredAmount <= 0 || enteredAmount > amountToCollect)) {
      setPaymentError("Sıfırdan büyük ve kalan tutarı aşmayan bir ödeme girin.");
      return;
    }
    if (!partial && split.open && !split.payments) {
      setPaymentError("Ödeme paylarının toplamını kontrol edin.");
      return;
    }
    setPaymentError("");
    setBusy(true);
    try {
      await onConfirmCheckout(split.payments?.[0].paymentMethod ?? paymentMethod, undefined, partial ? enteredAmount : undefined, !partial ? split.payments ?? undefined : undefined);
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : "Ödeme alınamadı.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop checkout-payment-backdrop">
      <div className={`modal-card wide payment-modal checkout-payment-modal${collected > 0 ? " has-previous-payment" : ""}`}>
        <div className="modal-header">
          <h3>{partial ? "Kısmi ödeme al" : "🏁 Hesabı Kes"} — {device.name}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div className="checkout-session-meta">
            <div><span>Açılış</span><strong>{new Date(startMs).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong></div>
            <div><span>{partial ? "Ödeme" : "Kapanış"}</span><strong>{new Date(nowMs).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong></div>
            <div><span>Oynanan süre</span><strong>{hoursPlayed > 0 ? `${hoursPlayed} sa ${minsPlayed} dk` : `${totalElapsedMinutes} dk`}</strong></div>
            {session.targetMinutes && nowMs > calcTime && <div><span>Süre bitişi</span><strong>{new Date(calcTime).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong></div>}
          </div>
          <div className="checkout-summary-box">
            <div className="checkout-row">
              <span>🎮 Oyun ücreti</span>
              <strong>{money(timeCost)}</strong>
            </div>

            {ordersTotal > 0 && (
              <div className="checkout-orders-container">
                <div
                  className="checkout-row order-accordion-header"
                  onClick={() => setShowOrderDetails(!showOrderDetails)}
                >
                  <span>🍟 Adisyon · Detaylar</span>
                  <strong>{money(ordersTotal)} {showOrderDetails ? "▲" : "▾"}</strong>
                </div>

                {showOrderDetails && (
                  <div className="checkout-order-items-list">
                    {orderItems.map((item) => (
                      <div key={item.id} className="checkout-order-item">
                        <span>• {item.productName} ({item.quantity} adet)</span>
                        <strong>{money(item.totalPrice)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(partial || (session.partialPaidAmount ?? 0) > 0) && <>
              <div className="checkout-row"><span>Güncel hesap</span><strong>{money(fullTotal)}</strong></div>
              <div className="checkout-row"><span>Önceden ödenen</span><strong>{money(prepaidAmount + (session.partialPaidAmount ?? 0))}</strong></div>
            </>}
            {!partial && refundAmount > 0 && <div className="checkout-row" role="status"><span>Kapanışta kasadan düşülecek iade</span><strong>{money(refundAmount)}</strong></div>}
            <div className="checkout-grand-total">
              <span>{partial || (session.partialPaidAmount ?? 0) > 0 ? "KALAN TUTAR" : titleText}</span>
              <strong className="grand-total-amount">{money(amountToCollect)}</strong>
            </div>
          </div>

          {collected > 0 && (
            <div className="prepaid-alert-banner">
              <div className="prepaid-alert-icon" style={ordersTotal > 0 ? { color: "#eab308" } : undefined}>
                {ordersTotal > 0 ? "ℹ️" : "✅"}
              </div>
              <div className="prepaid-alert-content">
                <strong>{amountToCollect === 0 ? "Ücret Tahsil Edildi" : "Kısmi Tahsilat"}</strong>
                {amountToCollect > 0 && differenceReason && <span className="checkout-payment-reason">{differenceReason}</span>}
              </div>
            </div>
          )}

          {partial && <div className="form-group">
            <label className="section-label" htmlFor="partial-payment-amount">Alınacak tutar (₺)</label>
            <input id="partial-payment-amount" type="number" min="0.01" max={amountToCollect} step="0.01" required autoFocus value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} />
            <p>Masa açık kalır, süre işlemeye devam eder.</p>
          </div>}
          {(holdError || paymentError) && <p className="error" role="alert">{holdError || paymentError}</p>}
          {amountToCollect > 0 && (partial || !split.open) && (
            <div className="form-group">
              <label className="section-label">Ödeme Yöntemi</label>
              <div className="type-selector">
                <button
                  type="button"
                  className={`type-option ${paymentMethod === "nakit" ? "active" : ""}`}
                  onClick={() => setPaymentMethod("nakit")}
                >
                  💵 Nakit Ödeme
                </button>
                <button
                  type="button"
                  className={`type-option ${paymentMethod === "kredi_karti" ? "active" : ""}`}
                  onClick={() => setPaymentMethod("kredi_karti")}
                >
                  💳 Kredi Kartı / POS
                </button>
              </div>
            </div>
          )}


          {!partial && <PaymentSplitFields amount={amountToCollect} split={split} busy={busy} />}
          <div className={`modal-actions payment-modal-actions checkout-actions${!partial && amountToCollect > 0 ? " has-split-toggle" : ""}`}>
            {!partial && amountToCollect > 0 && <PaymentSplitToggle split={split} busy={busy} />}
            <button type="button" className="secondary-btn checkout-back" onClick={onClose}>
              ⬅️ Geri (İptal)
            </button>
            <button disabled={busy || Boolean(holdError) || (partial && amountToCollect <= 0) || (!partial && split.open && !split.payments)} className="primary-glow checkout-save">
              {busy ? "Kaydediliyor…" : partial ? "Ödemeyi al, masayı açık tut" : "💾 Kaydet & Hesabı Kapat"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AdjustControllersModal({
  device,
  onClose,
  onSave,
}: {
  device: Device;
  onClose: () => void;
  onSave: (count: number) => Promise<void>;
}) {
  const currentCount = device.activeSession?.controllerCount ?? 2;
  const [controllerCount, setControllerCount] = useState(currentCount);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(controllerCount);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h3>🎮 Kol Sayısı Değiştir — {device.name}</h3>
        <p className="modal-sub">
          Değiştirildiği andan itibaren kalan süre yeni kol sayısından hesaplanacaktır. Önceden oynanan süre dondurulur.
        </p>
        <form onSubmit={submit}>
          <label>Yeni Kol Sayısını Seçin:</label>
          <div className="controller-selector">
            <button
              type="button"
              className={`controller-option ${controllerCount <= 2 ? "active" : ""}`}
              onClick={() => setControllerCount(2)}
            >
              <div className="controller-title">🎮 1 veya 2 Kol</div>
            </button>
            <button
              type="button"
              className={`controller-option ${controllerCount === 3 ? "active" : ""}`}
              onClick={() => setControllerCount(3)}
            >
              <div className="controller-title">🎮 3 Kol</div>
            </button>
            <button
              type="button"
              className={`controller-option ${controllerCount === 4 ? "active" : ""}`}
              onClick={() => setControllerCount(4)}
            >
              <div className="controller-title">🎮 4 Kol</div>
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button disabled={busy}>{busy ? "Güncelleniyor…" : "Kol Sayısını Değiştir"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConvertToTimedModal({
  token,
  device,
  categories,
  roundingStep,
  onClose,
  onSave,
}: {
  token: string;
  device: Device;
  categories: Category[];
  roundingStep: number;
  onClose: () => void;
  onSave: (targetMinutes: number, isPaid: boolean, paymentMethod?: "nakit" | "kredi_karti" | null) => Promise<void>;
}) {
  const startMs = device.activeSession ? new Date(device.activeSession.startedAt).getTime() : Date.now();
  const elapsedMinutes = Math.floor((Date.now() - startMs) / 60_000);

  const calculatedHourlyRate = device.activeSession?.hourlyRate ?? 0;
  const calculatedFirst30Rate = device.activeSession?.first30Rate ?? calculatedHourlyRate / 2;

  const [timedMode, setTimedMode] = useState<"minutes" | "price">("minutes");
  const [activeMinutePreset, setActiveMinutePreset] = useState<number | null>(null);
  const [totalMinutesInput, setTotalMinutesInput] = useState<string>("");
  const [activePricePreset, setActivePricePreset] = useState<number | null>(null);
  const [totalPriceInput, setTotalPriceInput] = useState<string>("");
  const [isPaid, setIsPaid] = useState<boolean>(true);
  const [paymentMethod, setPaymentMethod] = useState<"nakit" | "kredi_karti">("nakit");
  const [busy, setBusy] = useState(false);

  const requestedValue = timedMode === "minutes" ? (activeMinutePreset ?? Number(totalMinutesInput)) : (activePricePreset ?? Number(totalPriceInput));
  const session = device.activeSession;
  const quoteKey = JSON.stringify([session?.id, session?.startedAt, session?.segmentStartedAt, session?.accruedAmount, session?.hourlyRate, session?.first30Rate, session?.targetMinutes, session?.packageAmount, roundingStep, timedMode, requestedValue]);
  const [quote, setQuote] = useState<{ key: string; targetMinutes: number; timeAmount: number } | null>(null);
  const [quoteError, setQuoteError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!session || !Number.isFinite(requestedValue) || requestedValue <= 0) return;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const body = timedMode === "minutes" ? { targetMinutes: requestedValue } : { targetPrice: requestedValue };
        const data = await request<{ targetMinutes: number; timeAmount: number }>(`/api/sessions/${session.id}/quote`, token, { method: "POST", body: JSON.stringify(body), signal: abort.signal });
        if (!abort.signal.aborted) { setQuote({ key: quoteKey, ...data }); setQuoteError(null); }
      } catch (error) {
        if (!abort.signal.aborted) setQuoteError({ key: quoteKey, message: error instanceof Error ? error.message : "?cret hesaplanamad?." });
      }
    }, 200);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [quoteKey, token]);
  const currentQuote = quote?.key === quoteKey ? quote : null;
  const errorText = quoteError?.key === quoteKey ? quoteError.message : "";
  const finalTotalMinutes = currentQuote?.targetMinutes ?? 0;
  const estimatedTotal = currentQuote?.timeAmount ?? 0;
  const isSubmitDisabled = busy || !currentQuote || Boolean(errorText);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled) return;
    setBusy(true);
    try {
      await onSave(Math.max(1, finalTotalMinutes ?? 0), isPaid, isPaid ? paymentMethod : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide payment-modal">
        <h3>⏱️ Süreliye Çevir — {device.name}</h3>
        <p className="modal-sub">
          Masanın ilk açılış saati baz alınır ({new Date(startMs).toLocaleTimeString("tr-TR")}, Geçen: {elapsedMinutes} Dk). Toplam oynanacak süreyi belirleyin.
        </p>

        {errorText && <p className="error notice" role="alert">{errorText}</p>}
        {!currentQuote && !errorText && requestedValue > 0 && <p className="subtle">?cret hesaplan?yor?</p>}
        <form onSubmit={submit}>
          <div className="form-group timed-section">
            <label className="section-label">1. Süre Belirleme Yöntemi</label>
            <div className="time-tabs" style={{ marginBottom: "0.8rem" }}>
              <button
                type="button"
                className={`time-tab ${timedMode === "minutes" ? "active" : ""}`}
                onClick={() => setTimedMode("minutes")}
              >
                ⏱️ Dakikaya Göre
              </button>
              <button
                type="button"
                className={`time-tab ${timedMode === "price" ? "active" : ""}`}
                onClick={() => setTimedMode("price")}
              >
                💵 Fiyata (TL) Göre
              </button>
            </div>

            {timedMode === "minutes" ? (
              <div className="minute-presets" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                {[5, 15, 30, 60, 90, 120, 180].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    className={`preset-btn ${activeMinutePreset === mins ? "active" : ""}`}
                    onClick={() => {
                      setActiveMinutePreset(mins);
                      setTotalMinutesInput("");
                    }}
                    style={{ flex: 1, minWidth: "60px", padding: "0.8rem 0.5rem" }}
                  >
                    {mins} Dk
                  </button>
                ))}
                <div style={{ flex: 1.5, minWidth: "120px" }}>
                  <input
                    type="text"
                    placeholder="Özel (Dk)"
                    value={totalMinutesInput}
                    onChange={(e) => {
                      let val = e.target.value.replace(/[^0-9.]/g, "");
                      const parts = val.split(".");
                      if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                      setTotalMinutesInput(val);
                      if (val) setActiveMinutePreset(null);
                    }}
                    style={{ width: "100%", margin: 0 }}
                  />
                </div>
              </div>
            ) : (
              <div className="minute-presets" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                {[calculatedFirst30Rate / 2, calculatedFirst30Rate, calculatedHourlyRate, calculatedHourlyRate * 1.5].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`preset-btn ${activePricePreset === p ? "active" : ""}`}
                    onClick={() => {
                      setActivePricePreset(p);
                      setTotalPriceInput("");
                    }}
                    style={{ flex: 1, minWidth: "70px", padding: "0.8rem 0.5rem" }}
                  >
                    {money(p)}
                  </button>
                ))}
                <div style={{ flex: 1.5, minWidth: "120px" }}>
                  <input
                    type="text"
                    placeholder="Özel (TL)"
                    value={totalPriceInput}
                    onChange={(e) => {
                      let val = e.target.value.replace(/[^0-9.]/g, "");
                      const parts = val.split(".");
                      if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                      setTotalPriceInput(val);
                      if (val) setActivePricePreset(null);
                    }}
                    style={{ width: "100%", margin: 0 }}
                  />
                </div>
              </div>
            )}

            <div className="rate-preview" style={{ marginTop: "0.8rem" }}>
              <div>
                <span>Hesaplanan Kalan Süre:</span>
                <strong>{Math.max(0, finalTotalMinutes - elapsedMinutes)} Dk Kalan (Toplam {finalTotalMinutes} Dk)</strong>
              </div>
              <div className="total-preview">
                <span>Sabit Oturum Fiyatı:</span>
                <strong className="highlight-total">{money(estimatedTotal)}</strong>
              </div>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label className="section-label">2. Ödeme Durumu</label>
            <div className="time-tabs">
              <button
                type="button"
                className={`time-tab ${isPaid ? "" : "active danger-type"}`}
                onClick={() => setIsPaid(false)}
                style={{ padding: "0.8rem", fontSize: "1rem", flex: 1 }}
              >
                ⏳ Sonra Ödenecek
              </button>
              <button
                type="button"
                className={`time-tab ${isPaid ? "active" : ""}`}
                onClick={() => setIsPaid(true)}
                style={{ padding: "0.8rem", fontSize: "1rem", flex: 1 }}
              >
                ✅ Peşin Ödendi
              </button>
            </div>

            {isPaid && (
              <div className="payment-method-subselector" style={{ marginTop: "0.8rem" }}>
                <label className="sub-label">Ödeme Yöntemi:</label>
                <div className="time-tabs">
                  <button
                    type="button"
                    className={`time-tab ${paymentMethod === "nakit" ? "active" : ""}`}
                    onClick={() => setPaymentMethod("nakit")}
                  >
                    💵 Nakit
                  </button>
                  <button
                    type="button"
                    className={`time-tab ${paymentMethod === "kredi_karti" ? "active" : ""}`}
                    onClick={() => setPaymentMethod("kredi_karti")}
                  >
                    💳 Kredi Kartı / POS
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="modal-actions" style={{ marginTop: "2rem" }}>
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button disabled={isSubmitDisabled} style={{ flex: 1, padding: "1rem", fontSize: "1.1rem" }}>
              {busy ? "Çevriliyor…" : (finalTotalMinutes && Number.isInteger(finalTotalMinutes) && finalTotalMinutes <= 1440 ? `⏱️ Süreliye Çevir (${finalTotalMinutes} Dk - ${money(estimatedTotal)})` : (timedMode === "minutes" ? "Lütfen Dakika Belirleyiniz" : "Lütfen Fiyat Belirleyiniz"))}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AdjustTimeModal({
  device,
  onClose,
  onSave,
}: {
  device: Device;
  onClose: () => void;
  onSave: (targetMinutes: number | null) => Promise<void>;
}) {
  const currentTarget = device.activeSession?.targetMinutes ?? 60;
  const startMs = device.activeSession ? new Date(device.activeSession.startedAt).getTime() : Date.now();
  const elapsedMinutes = Math.floor((Date.now() - startMs) / 60_000);

  const [activeTab, setActiveTab] = useState<"add" | "sub">("add");
  const [addMinutesInput, setAddMinutesInput] = useState<string>("15");
  const [subMinutesInput, setSubMinutesInput] = useState<string>("15");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (activeTab === "add") {
        const addMins = Number(addMinutesInput) || 0;
        const newTotal = currentTarget + addMins;
        await onSave(newTotal);
      } else {
        const subMins = Number(subMinutesInput) || 0;
        const newTotal = Math.max(1, currentTarget - subMins);
        await onSave(newTotal);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide">
        <h3>⏱️ Süre Ekle / Düş — {device.name}</h3>
        <p className="modal-sub">
          Mevcut Hedef: <strong>{currentTarget} Dk</strong> (Geçen Süre: {elapsedMinutes} Dk, Kalan: {Math.max(0, currentTarget - elapsedMinutes)} Dk)
        </p>

        <div className="time-tabs">
          <button
            type="button"
            className={`time-tab ${activeTab === "add" ? "active" : ""}`}
            onClick={() => setActiveTab("add")}
          >
            ➕ Süre Ekle
          </button>
          <button
            type="button"
            className={`time-tab ${activeTab === "sub" ? "active" : ""}`}
            onClick={() => setActiveTab("sub")}
          >
            ➖ Süre Düş
          </button>
        </div>

        <form onSubmit={submit}>
          {activeTab === "add" ? (
            <div className="form-group timed-section">
              <label className="section-label">Mevcut Kalan Süreye İlave Et (Dakika)</label>
              <div className="minute-presets">
                {[15, 30, 45, 60, 90].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    className={`preset-btn ${Number(addMinutesInput) === mins ? "active" : ""}`}
                    onClick={() => setAddMinutesInput(String(mins))}
                  >
                    +{mins} Dk Ekle
                  </button>
                ))}
              </div>
              <div className="custom-minute-input">
                <label>Özel Eklenecek Süre (Dakika):</label>
                <input
                  type="number"
                  placeholder="Eklenecek dakika girin"
                  value={addMinutesInput}
                  onChange={(e) => setAddMinutesInput(e.target.value)}
                />
              </div>
              <div className="rate-preview" style={{ marginTop: "0.8rem" }}>
                <span>Güncellenecek Toplam Masa Süresi:</span>
                <strong>{currentTarget + (Number(addMinutesInput) || 0)} Dk</strong>
              </div>
            </div>
          ) : (
            <div className="form-group timed-section">
              <label className="section-label">Mevcut Kalan Süreden Düş (Dakika)</label>
              <div className="minute-presets">
                {[15, 30, 45, 60].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    className={`preset-btn ${Number(subMinutesInput) === mins ? "active" : ""}`}
                    onClick={() => setSubMinutesInput(String(mins))}
                  >
                    -{mins} Dk Düş
                  </button>
                ))}
              </div>
              <div className="custom-minute-input">
                <label>Özel Düşülecek Süre (Dakika):</label>
                <input
                  type="number"
                  placeholder="Düşülecek dakika girin"
                  value={subMinutesInput}
                  onChange={(e) => setSubMinutesInput(e.target.value)}
                />
              </div>
              <div className="rate-preview" style={{ marginTop: "0.8rem" }}>
                <span>Güncellenecek Toplam Masa Süresi:</span>
                <strong>{Math.max(1, currentTarget - (Number(subMinutesInput) || 0))} Dk</strong>
              </div>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              İptal
            </button>
            <button disabled={busy}>{busy ? "Kaydediliyor…" : "Süreyi Güncelle"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function OrderModal({
  token,
  device,
  products,
  onClose,
  onRefresh,
}: {
  token: string;
  device: Device;
  products: Product[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const sessionId = device.activeSession?.id;
  const initialItems = device.activeSession?.orderItems ?? [];
  const [localItems, setLocalItems] = useState<OrderItem[]>(initialItems);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (device.activeSession?.orderItems) {
      setLocalItems(device.activeSession.orderItems);
    }
  }, [device.activeSession?.orderItems]);

  const ordersTotal = localItems.reduce((sum, item) => sum + item.totalPrice, 0);

  const addProductOrder = async (name: string, price: number) => {
    if (!sessionId) return;
    setBusy(true);
    setError("");
    try {
      const updatedItems = await request<OrderItem[]>(`/api/sessions/${sessionId}/orders`, token, {
        method: "POST",
        body: JSON.stringify({ productName: name, unitPrice: price, quantity: 1 }),
      });
      setLocalItems(updatedItems);
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Adisyon eklenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const deleteOrderItem = async (orderId: number) => {
    setBusy(true);
    setError("");
    setLocalItems((prev) => prev.filter((item) => item.id !== orderId));
    try {
      await request(`/api/orders/${orderId}`, token, { method: "DELETE" });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Adisyon silinemedi.");
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide">
        <div className="modal-header">
          <h3>🍟 Adisyon & Kantin Yönetimi — {device.name}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <p className="error notice">{error}</p>}

        <div className="order-modal-grid">
          <div className="order-catalog-section">
            <h4>Hızlı Ürün Kataloğu</h4>
            <p className="subtle" style={{ margin: "0 0 0.8rem" }}>
              Masaya sipariş eklemek için ürüne tıklayın (Yeni ürün eklemek/silmek için Genel Ayarlar sekmesini kullanın).
            </p>
            <div className="product-presets">
              {products.map((p) => (
                <button
                  key={p.id}
                  disabled={busy}
                  className="product-btn"
                  onClick={() => addProductOrder(p.name, p.price)}
                >
                  <span>{p.name}</span>
                  <strong>{money(p.price)}</strong>
                </button>
              ))}
            </div>
          </div>

          <div className="order-list-section">
            <div className="order-list-header">
              <h4>Masa Adisyonu ({localItems.length})</h4>
              <strong className="orders-total-badge">Toplam: {money(ordersTotal)}</strong>
            </div>

            {localItems.length ? (
              <div className="orders-table">
                {localItems.map((item) => (
                  <div key={item.id} className="order-row">
                    <div className="order-info">
                      <strong>{item.productName}</strong>
                      <span>{item.quantity} adet × {money(item.unitPrice)}</span>
                    </div>
                    <div className="order-actions">
                      <strong className="order-price">{money(item.totalPrice)}</strong>
                      <button
                        className="danger-ghost icon-btn"
                        data-site-tooltip="Kalemi Sil"
                        disabled={busy}
                        onClick={() => deleteOrderItem(item.id)}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-orders">
                <p>Henüz adisyon eklenmedi.</p>
                <small>Soldaki kataloğu kullanarak hızlıca ürün ekleyebilirsiniz.</small>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>
            Tamam
          </button>
        </div>
      </div>
    </div>
  );
}

function DirectSaleModal({
  token,
  products,
  onClose,
  onSuccess,
}: {
  token: string;
  products: Product[];
  onClose: () => void;
  onSuccess: (amount: number, method: string) => void;
}) {
  const [localItems, setLocalItems] = useState<Array<{ id: number; productName: string; unitPrice: number; quantity: number; totalPrice: number }>>([]);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [selectedPayment, setSelectedPayment] = useState<"nakit" | "kredi_karti">("nakit");

  const ordersTotal = localItems.reduce((sum, item) => sum + item.totalPrice, 0);

  const addProductOrder = (name: string, price: number) => {
    setLocalItems(prev => {
      const existing = prev.find(i => i.productName === name);
      if (existing) {
        return prev.map(i => i.productName === name ? { ...i, quantity: i.quantity + 1, totalPrice: (i.quantity + 1) * i.unitPrice } : i);
      }
      return [...prev, { id: Date.now() + Math.random(), productName: name, unitPrice: price, quantity: 1, totalPrice: price }];
    });
  };

  const deleteOrderItem = (orderId: number) => {
    setLocalItems((prev) => prev.filter((item) => item.id !== orderId));
  };

  const submitDirectSale = async () => {
    if (localItems.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<{ totalAmount: number; paymentMethod: string }>("/api/direct-sales", token, {
        method: "POST",
        body: JSON.stringify({ paymentMethod: selectedPayment, items: localItems }),
      });
      onSuccess(res.totalAmount, res.paymentMethod);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Satış yapılamadı.");
      setBusy(false);
    }
  };

  if (isCheckingOut) {
    return (
      <div className="modal-backdrop">
        <div className="modal-card">
          <div className="modal-header">
            <h3>💳 Direkt Adisyon Satışı Ödeme</h3>
            <button type="button" className="icon-btn" onClick={() => setIsCheckingOut(false)} disabled={busy}>✕</button>
          </div>
          {error && <p className="error notice">{error}</p>}
          <div className="modal-body" style={{ textAlign: "center", margin: "2rem 0" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: "0.5rem" }}>Toplam Tutar</div>
            <strong style={{ fontSize: "2.5rem", color: "var(--accent-amber)" }}>{money(ordersTotal)}</strong>

            <div className="form-group" style={{ marginTop: "2rem", textAlign: "left" }}>
              <label className="section-label">Ödeme Yöntemi</label>
              <div className="type-selector">
                <button
                  type="button"
                  className={`type-option ${selectedPayment === "nakit" ? "active" : ""}`}
                  onClick={() => setSelectedPayment("nakit")}
                >
                  💵 Nakit Ödeme
                </button>
                <button
                  type="button"
                  className={`type-option ${selectedPayment === "kredi_karti" ? "active" : ""}`}
                  onClick={() => setSelectedPayment("kredi_karti")}
                >
                  💳 Kredi Kartı / POS
                </button>
              </div>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-btn" onClick={() => setIsCheckingOut(false)} disabled={busy}>
              ⬅️ Geri (İptal)
            </button>
            <button type="button" className="primary-glow" onClick={submitDirectSale} disabled={busy}>
              {busy ? "Kapatılıyor…" : "💾 Kaydet & Hesabı Kapat"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide">
        <div className="modal-header">
          <h3>🛒 Direkt Adisyon Satışı</h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {error && <p className="error notice">{error}</p>}

        <div className="order-modal-grid">
          <div className="order-catalog-section">
            <h4>Hızlı Ürün Kataloğu</h4>
            <div className="product-presets">
              {products.map((p) => (
                <button key={p.id} disabled={busy} className="product-btn" onClick={() => addProductOrder(p.name, p.price)}>
                  <span>{p.name}</span>
                  <strong>{money(p.price)}</strong>
                </button>
              ))}
            </div>
          </div>

          <div className="order-list-section">
            <div className="order-list-header">
              <h4>Sepet ({localItems.length})</h4>
              <strong className="orders-total-badge">Toplam: {money(ordersTotal)}</strong>
            </div>

            {localItems.length ? (
              <div className="orders-table">
                {localItems.map((item) => (
                  <div key={item.id} className="order-row">
                    <div className="order-info">
                      <strong>{item.productName}</strong>
                      <span>{item.quantity} adet × {money(item.unitPrice)}</span>
                    </div>
                    <div className="order-actions">
                      <strong className="order-price">{money(item.totalPrice)}</strong>
                      <button className="danger-ghost icon-btn" data-site-tooltip="Kalemi Sil" disabled={busy} onClick={() => deleteOrderItem(item.id)}>🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-orders">
                <p>Sepet boş.</p>
                <small>Soldaki kataloğu kullanarak ürünü sepete ekleyebilirsiniz.</small>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions" style={{ justifyContent: "space-between" }}>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>
            İptal
          </button>
          <button
            type="button"
            className="primary-glow"
            onClick={() => setIsCheckingOut(true)}
            disabled={localItems.length === 0 || busy}
          >
            Ödeme Al ({money(ordersTotal)})
          </button>
        </div>
      </div>
    </div>
  );
}

type TariffInputsValue = { baseRate: string; first30Rate: string; rate3: string; first30Rate3: string; rate4: string; first30Rate4: string };
function TariffInputs({ values, onChange }: { values: TariffInputsValue; onChange: (key: keyof TariffInputsValue, value: string) => void }) {
  const groups = [
    { label: "1–2 kol", hourly: "baseRate", opening: "first30Rate" },
    { label: "3 kol", hourly: "rate3", opening: "first30Rate3" },
    { label: "4 kol", hourly: "rate4", opening: "first30Rate4" },
  ] as const;
  return <div className="tariff-input-grid">
    <span>Kol sayısı</span><span>İlk 30 dakika (₺)</span><span>Saatlik ücret (₺)</span>
    {groups.map(group => <Fragment key={group.label}>
      <strong>{group.label}</strong>
      <input type="number" required min="0.01" max="100000" step="0.01" aria-label={`${group.label} ilk 30 dakika ücreti`} value={values[group.opening]} onChange={e => onChange(group.opening, e.target.value)} />
      <input type="number" required min="0.01" max="100000" step="0.01" aria-label={`${group.label} saatlik ücret`} value={values[group.hourly]} onChange={e => onChange(group.hourly, e.target.value)} />
    </Fragment>)}
  </div>;
}

function GeneralSettingsModal({
  token,
  categories,
  products,
  onClose,
  onRefresh,
}: {
  token: string;
  categories: Category[];
  products: Product[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"categories" | "products" | "logs" | "audio">("categories");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [roundingStepInput, setRoundingStepInput] = useState("1");

  const [warningMinutesInput, setWarningMinutesInput] = useState("5");
  const [savedWarningMinutes, setSavedWarningMinutes] = useState(5);

  // Category State
  const [catName, setCatName] = useState("");
  const [baseRateInput, setBaseRateInput] = useState<string>("150");
  const [first30RateInput, setFirst30RateInput] = useState<string>("90");
  const [extraRates, setExtraRates] = useState({ rate3: "225", first30Rate3: "135", rate4: "300", first30Rate4: "180" });
  const [editingCatId, setEditingCatId] = useState<number | null>(null);

  const [editCatName, setEditCatName] = useState("");
  const [editBaseRateInput, setEditBaseRateInput] = useState<string>("150");
  const [editFirst30RateInput, setEditFirst30RateInput] = useState<string>("90");
  const [editExtraRates, setEditExtraRates] = useState({ rate3: "225", first30Rate3: "135", rate4: "300", first30Rate4: "180" });

  // Product State
  const [prodName, setProdName] = useState("");
  const [prodPriceInput, setProdPriceInput] = useState<string>("25");
  const [prodCategory, setProdCategory] = useState("İçecek");
  const [editingProdId, setEditingProdId] = useState<number | null>(null);

  const [editProdName, setEditProdName] = useState("");
  const [editProdPriceInput, setEditProdPriceInput] = useState<string>("25");
  const [editProdCategory, setEditProdCategory] = useState("İçecek");

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request<{ roundingStep: number }>("/api/settings/rounding-step", token)
      .then((data) => setRoundingStepInput(String(data.roundingStep)))
      .catch(() => setError("Yuvarlama ayarı yüklenemedi."));
    request<{ warningMinutes: number }>("/api/settings/warning-minutes", token)
      .then((data) => {
        setWarningMinutesInput(String(data.warningMinutes));
        setSavedWarningMinutes(data.warningMinutes);
      })
      .catch(() => setError("Sesli uyarı ayarı yüklenemedi."));
  }, [token]);

  const saveWarningMinutes = async (e: FormEvent) => {
    e.preventDefault();
    const minutes = Number(warningMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setError("Uyarı süresi 1 ile 1440 dakika arasında tam sayı olmalı.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/settings/warning-minutes", token, { method: "PUT", body: JSON.stringify({ warningMinutes: minutes }) });
      setSavedWarningMinutes(minutes);
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sesli uyarı ayarı kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  };

  const saveRoundingStep = async (e: FormEvent) => {
    e.preventDefault();
    const step = Number(roundingStepInput);
    if (!Number.isFinite(step) || step <= 0 || step > 1000 || Math.abs(step * 100 - Math.round(step * 100)) > 1e-8) {
      setError("Yuvarlama tutarı 0 ile 1000 TL arasında ve en fazla iki ondalıklı olmalı.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/settings/rounding-step", token, { method: "PUT", body: JSON.stringify({ roundingStep: step }) });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Yuvarlama ayarı kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (activeTab === "logs") {
      setBusy(true);
      request<ActivityLog[]>("/api/logs", token)
        .then((data) => setLogs(data))
        .catch(() => setError("Loglar yüklenemedi."))
        .finally(() => setBusy(false));
    }
  }, [activeTab, token]);

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!catName.trim()) return;
    if (!(Number(first30RateInput) > 0) || !(Number(baseRateInput) > 0)) {
      setError("Saatlik ücret ve ilk 30 dakika ücreti sıfırdan büyük olmalıdır.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/categories", token, {
        method: "POST",
        body: JSON.stringify({ name: catName.trim(), baseRate: Number(baseRateInput) || 0, first30Rate: Number(first30RateInput) || 0, ...Object.fromEntries(Object.entries(extraRates).map(([key, value]) => [key, Number(value)])) }),
      });
      setCatName("");
      setBaseRateInput("150");
      setFirst30RateInput("90");
      setExtraRates({ rate3: "225", first30Rate3: "135", rate4: "300", first30Rate4: "180" });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Çeşit eklenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const startEditingCat = (c: Category) => {
    setEditingCatId(c.id);
    setEditCatName(c.name);
    setEditBaseRateInput(String(c.baseRate));
    setEditFirst30RateInput(String(c.first30Rate ?? c.baseRate / 2));
    const rates = tariffRates(c);
    setEditExtraRates({ rate3: String(rates['3'].hourlyRate), first30Rate3: String(rates['3'].first30Rate), rate4: String(rates['4'].hourlyRate), first30Rate4: String(rates['4'].first30Rate) });
  };

  const saveEditingCat = async (id: number) => {
    if (!editCatName.trim()) return;
    if (!(Number(editFirst30RateInput) > 0) || !(Number(editBaseRateInput) > 0)) {
      setError("Saatlik ücret ve ilk 30 dakika ücreti sıfırdan büyük olmalıdır.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request(`/api/categories/${id}`, token, {
        method: "PUT",
        body: JSON.stringify({ name: editCatName.trim(), baseRate: Number(editBaseRateInput) || 0, first30Rate: Number(editFirst30RateInput) || 0, ...Object.fromEntries(Object.entries(editExtraRates).map(([key, value]) => [key, Number(value)])) }),
      });
      setEditingCatId(null);
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Çeşit güncellenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const deleteCategory = async (id: number) => {
    if (!await confirmAction("Bu çeşidi silmek istediğinize emin misiniz?", { title: "Çeşit Silme Onayı", confirmLabel: "Evet, Çeşidi Sil", danger: true })) return;
    try {
      await request(`/api/categories/${id}`, token, { method: "DELETE" });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Çeşit silinemedi.");
    }
  };

  const addProduct = async (e: FormEvent) => {
    e.preventDefault();
    const price = Number(prodPriceInput) || 0;
    if (!prodName.trim() || price <= 0) return;
    setBusy(true);
    setError("");
    try {
      await request("/api/products", token, {
        method: "POST",
        body: JSON.stringify({ name: prodName.trim(), price, category: prodCategory }),
      });
      setProdName("");
      setProdPriceInput("25");
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ürün eklenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const startEditingProd = (p: Product) => {
    setEditingProdId(p.id);
    setEditProdName(p.name);
    setEditProdPriceInput(String(p.price));
    setEditProdCategory(p.category ?? "İçecek");
  };

  const saveEditingProd = async (id: number) => {
    const price = Number(editProdPriceInput) || 0;
    if (!editProdName.trim() || price <= 0) return;
    setBusy(true);
    setError("");
    try {
      await request(`/api/products/${id}`, token, {
        method: "PUT",
        body: JSON.stringify({ name: editProdName.trim(), price, category: editProdCategory }),
      });
      setEditingProdId(null);
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ürün güncellenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const deleteProduct = async (id: number) => {
    if (!await confirmAction("Bu ürünü katalogdan silmek istediğinize emin misiniz?", { title: "Ürün Silme Onayı", confirmLabel: "Evet, Ürünü Sil", danger: true })) return;
    try {
      await request(`/api/products/${id}`, token, { method: "DELETE" });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ürün silinemedi.");
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide">
        <div className="modal-header">
          <h3>⚙️ Genel Ayarlar</h3>
          <ReliableButton type="button" className="icon-btn" onActivate={onClose} aria-label="Ayarları kapat">
            ✕
          </ReliableButton>
        </div>

        {error && <p className="error notice">{error}</p>}

        <div className="time-tabs">
          <button
            type="button"
            className={`time-tab ${activeTab === "categories" ? "active" : ""}`}
            onClick={() => setActiveTab("categories")}
          >
            🎮 Masa Çeşit & Tarife Ayarları
          </button>
          <button
            type="button"
            className={`time-tab ${activeTab === "products" ? "active" : ""}`}
            onClick={() => setActiveTab("products")}
          >
            🍟 Kantin / Ürün Kataloğu Ayarları
          </button>
          <button
            type="button"
            className={`time-tab ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
          >
            📝 Sistem Logları
          </button>
          <button
            type="button"
            className={`time-tab ${activeTab === "audio" ? "active" : ""}`}
            onClick={() => setActiveTab("audio")}
          >
            🔊 Sesli Uyarı & Anons
          </button>
        </div>

        {activeTab === "categories" ? (
          <>
            <section className="category-form-section">
              <h4>Yuvarlama</h4>
              <form onSubmit={saveRoundingStep} className="category-inline-form-labeled">
                <label className="input-field-group">
                  <span>Yuvarlama (₺)</span>
                  <input type="number" min="0.01" max="1000" step="0.01" value={roundingStepInput} onChange={(e) => setRoundingStepInput(e.target.value)} />
                </label>
                <button disabled={busy} className="add-cat-btn">Kaydet</button>
              </form>
            </section>
            <section className="category-form-section">
              <h4>➕ Yeni Çeşit / Kategori Ekle</h4>
              <form onSubmit={addCategory} className="category-inline-form-labeled controller-tariff-form">
                <label className="input-field-group">
                  <span>Çeşit Adı</span>
                  <input
                    placeholder="Çeşit Adı (Örn: PS5)"
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                  />
                </label>
                <TariffInputs values={{ baseRate: baseRateInput, first30Rate: first30RateInput, ...extraRates }} onChange={(key, value) => {
                  if (key === 'baseRate') setBaseRateInput(value);
                  else if (key === 'first30Rate') setFirst30RateInput(value);
                  else setExtraRates(previous => ({ ...previous, [key]: value }));
                }} />
                <button disabled={busy} className="add-cat-btn">Çeşit Ekle</button>
              </form>
            </section>

            <section className="category-list-section">
              <h4>Mevcut Çeşitler ({categories.length}) — Düzenlemek İçin ✏️ Tıklayın</h4>
              {categories.length ? (
                <div className="category-table">
                  {categories.map((c) => (
                    <div key={c.id} className="category-row">
                      {editingCatId === c.id ? (
                        <div className="category-edit-form-labeled controller-tariff-form">
                          <label className="input-field-group">
                            <span>Çeşit Adı</span>
                            <input
                              value={editCatName}
                              onChange={(e) => setEditCatName(e.target.value)}
                              placeholder="Çeşit Adı (Örn: PS5)"
                            />
                          </label>
                          <TariffInputs values={{ baseRate: editBaseRateInput, first30Rate: editFirst30RateInput, ...editExtraRates }} onChange={(key, value) => {
                            if (key === 'baseRate') setEditBaseRateInput(value);
                            else if (key === 'first30Rate') setEditFirst30RateInput(value);
                            else setEditExtraRates(previous => ({ ...previous, [key]: value }));
                          }} />
                          <div className="edit-btn-group">
                            <button disabled={busy} onClick={() => saveEditingCat(c.id)}>
                              Kaydet
                            </button>
                            <button className="secondary-btn" onClick={() => setEditingCatId(null)}>
                              İptal
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="cat-info">
                            <strong>{c.name}</strong>
                            <span>
                              1–2 kol: İlk 30 dk {money(c.first30Rate ?? c.baseRate / 2)} · Saatlik {money(c.baseRate)}<br />
                              3 kol: İlk 30 dk {money(tariffRates(c)['3'].first30Rate)} · Saatlik {money(tariffRates(c)['3'].hourlyRate)}<br />
                              4 kol: İlk 30 dk {money(tariffRates(c)['4'].first30Rate)} · Saatlik {money(tariffRates(c)['4'].hourlyRate)}
                            </span>
                          </div>
                          <div className="cat-actions">
                            <button className="icon-btn" data-site-tooltip="Düzenle" onClick={() => startEditingCat(c)}>
                              ✏️
                            </button>
                            <button className="danger-ghost icon-btn" data-site-tooltip="Sil" onClick={() => deleteCategory(c.id)}>
                              🗑️
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="subtle">Henüz özel çeşit eklenmemiş.</p>
              )}
            </section>
          </>
        ) : activeTab === "products" ? (
          <>
            <section className="category-form-section">
              <h4>➕ Hızlı Ürün Kataloğuna Ürün Ekle</h4>
              <form onSubmit={addProduct} className="category-inline-form-labeled">
                <label className="input-field-group">
                  <span>Ürün Adı</span>
                  <input
                    placeholder="Ürün Adı (Örn: Cips, Tost, Kola)"
                    value={prodName}
                    onChange={(e) => setProdName(e.target.value)}
                  />
                </label>
                <label className="input-field-group">
                  <span>Fiyat (₺)</span>
                  <input
                    type="number"
                    placeholder="Fiyat (₺)"
                    value={prodPriceInput}
                    onChange={(e) => setProdPriceInput(e.target.value)}
                  />
                </label>
                <label className="input-field-group">
                  <span>Kategori</span>
                  <SiteSelect value={prodCategory} onChange={(e) => setProdCategory(e.target.value)}>
                    <option value="İçecek">İçecek</option>
                    <option value="Yiyecek">Yiyecek</option>
                    <option value="Atıştırmalık">Atıştırmalık</option>
                    <option value="Diğer">Diğer</option>
                  </SiteSelect>
                </label>
                <button disabled={busy} className="add-cat-btn">Ürün Ekle</button>
              </form>
            </section>

            <section className="category-list-section">
              <h4>Kantin Ürün Kataloğu ({products.length}) — Düzenlemek İçin ✏️ Tıklayın</h4>
              {products.length ? (
                <div className="category-table">
                  {products.map((p) => (
                    <div key={p.id} className="category-row">
                      {editingProdId === p.id ? (
                        <div className="category-edit-form-labeled">
                          <label className="input-field-group">
                            <span>Ürün Adı</span>
                            <input
                              value={editProdName}
                              onChange={(e) => setEditProdName(e.target.value)}
                              placeholder="Ürün Adı"
                            />
                          </label>
                          <label className="input-field-group">
                            <span>Fiyat (₺)</span>
                            <input
                              type="number"
                              value={editProdPriceInput}
                              onChange={(e) => setEditProdPriceInput(e.target.value)}
                              placeholder="Fiyat"
                            />
                          </label>
                          <label className="input-field-group">
                            <span>Kategori</span>
                            <SiteSelect
                              value={editProdCategory}
                              onChange={(e) => setEditProdCategory(e.target.value)}
                            >
                              <option value="İçecek">İçecek</option>
                              <option value="Yiyecek">Yiyecek</option>
                              <option value="Atıştırmalık">Atıştırmalık</option>
                              <option value="Diğer">Diğer</option>
                            </SiteSelect>
                          </label>
                          <div className="edit-btn-group">
                            <button disabled={busy} onClick={() => saveEditingProd(p.id)}>
                              Kaydet
                            </button>
                            <button className="secondary-btn" onClick={() => setEditingProdId(null)}>
                              İptal
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="cat-info">
                            <strong>{p.name}</strong>
                            <span>Fiyat: {money(p.price)} · Kategori: {p.category ?? "Genel"}</span>
                          </div>
                          <div className="cat-actions">
                            <button className="icon-btn" data-site-tooltip="Düzenle" onClick={() => startEditingProd(p)}>
                              ✏️
                            </button>
                            <button className="danger-ghost icon-btn" data-site-tooltip="Sil" onClick={() => deleteProduct(p.id)}>
                              🗑️
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="subtle">Henüz ürün kataloğu eklenmemiş.</p>
              )}
            </section>
          </>
        ) : activeTab === "logs" ? (
          <section className="logs-section">
            <div className="logs-container">
              {logs.length === 0 && !busy ? (
                <div className="empty-grid">
                  <p>Henüz sistem kaydı bulunmuyor.</p>
                </div>
              ) : (
                <div className="logs-list">
                  {logs.map((log) => {
                    const dateObj = new Date(log.createdAt);
                    const isToday = dateObj.toLocaleDateString() === new Date().toLocaleDateString();
                    const dateStr = isToday ? "Bugün" : dateObj.toLocaleDateString("tr-TR");
                    const timeStr = dateObj.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

                    let icon = "📝";
                    if (log.type === "MASA") icon = "🎮";
                    if (log.type === "ADİSYON") icon = "🍟";
                    if (log.type === "HESAP") icon = "💵";
                    if (log.type === "SİSTEM") icon = "💻";
                    if (log.type === "AYARLAR") icon = "⚙️";

                    return (
                      <div key={log.id} className="log-item">
                        <div className="log-icon">{icon}</div>
                        <div className="log-content">
                          <p className="log-message">{log.message}</p>
                          <small className="log-time">
                            <span className="log-type">{log.type}</span> • {dateStr} {timeStr}
                          </small>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        ) : activeTab === "audio" ? (
          <section className="settings-section" style={{ marginTop: "1rem" }}>
            <h4 style={{ marginBottom: "0.5rem" }}>🔊 Sesli Uyarı & Anons</h4>
            <p style={{ color: "#94a3b8", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
              Süreli masalar için kaç dakika kala anons yapılacağını belirleyin. Süre dolduğunda ayrıca anons yapılır.
            </p>

            <form onSubmit={saveWarningMinutes} className="form-group" style={{ marginBottom: "1.5rem", maxWidth: "450px" }}>
              <label className="section-label" htmlFor="warning-minutes">Kaç dakika kala uyarı yapılsın?</label>
              <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                <input id="warning-minutes" type="number" min="1" max="1440" step="1" required value={warningMinutesInput} onChange={(e) => setWarningMinutesInput(e.target.value)} />
                <button type="submit" className="btn btn-primary" disabled={busy}>Kaydet</button>
              </div>
            </form>

            <div style={{ display: "flex", gap: "0.8rem", marginTop: "1.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "0.7rem 1.2rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
                onClick={() => {
                  notifyMinutesLeft("Masa 1", savedWarningMinutes);
                }}
              >
                🔊 "Masa 1, son {savedWarningMinutes} dakika" Test Et
              </button>

              <button
                type="button"
                className="btn secondary-btn"
                style={{ padding: "0.7rem 1.2rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
                onClick={() => {
                  notifyTimeExpired("Masa 1");
                }}
              >
                🔊 "Masa 1, süresi doldu" Test Et
              </button>
            </div>
          </section>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
}