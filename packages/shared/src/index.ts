export type DeviceStatus = "bos" | "mesgul";

export interface Category {
  id: number;
  name: string;
  baseRate: number;
  extraControllerRate: number;
  first30Rate?: number | null; // İlk 30 dakika özel ücreti
}

export interface Product {
  id: number;
  name: string;
  price: number;
  category?: string;
}

export interface OrderItem {
  id: number;
  sessionId: number;
  productName: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number;
  createdAt: string;
}

export interface Session {
  id: number;
  deviceId: number;
  startedAt: string;
  segmentStartedAt?: string | null;
  accruedAmount?: number;
  endedAt: string | null;
  hourlyRate: number;
  first30Rate?: number | null;
  controllerCount: number;
  targetMinutes: number | null;
  isPaid?: boolean;
  paymentMethod?: "nakit" | "kredi_karti" | null;
  ordersTotal?: number;
  orderItems?: OrderItem[];
  totalAmount: number | null;
}




export interface Device {
  id: number;
  name: string;
  status: DeviceStatus;
  categoryId: number | null;
  categoryName?: string;
  activeSession: Session | null;
}

export interface OccupancySummary {
  totalDevices: number;
  availableDevices: number;
  occupiedDevices: number;
  openSessions: number;
  liveAmount: number;
  dailyRevenue: number;
  updatedAt: string;
}

/** Para değerini kuruş hassasiyetinde yuvarlar. */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Taban saatlik ücret ve kol sayısına göre toplam saatlik ücreti hesaplar.
 * 1-2 Kol: %100 (Taban ücret)
 * 3 Kol: %150 (1.5 katı)
 * 4 Kol: %200 (2 katı)
 */
export function calculateSessionHourlyRate(
  baseRate: number,
  controllerCount: number = 1,
): number {
  if (controllerCount <= 2) return baseRate;
  if (controllerCount === 3) return roundCurrency(baseRate * 1.5);
  if (controllerCount === 4) return roundCurrency(baseRate * 2);
  return roundCurrency(baseRate * (1 + (controllerCount - 2) * 0.5));
}


/** Fiyat/Bütçe (TL) girildiğinde kaç dakikalık oyun süresine denk geldiğini hesaplar. */
export function calculateMinutesFromPrice(
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
    if (calculateTimedPrice(middle, hourlyRate, base30, roundingStep) <= targetPrice) low = middle;
    else high = middle - 1;
  }
  return low;
}

function segmentPrice(fromMinutes: number, toMinutes: number, hourlyRate: number, first30Rate: number): number {
  const first30Minutes = Math.max(0, Math.min(toMinutes, 30) - Math.min(fromMinutes, 30));
  const next30Minutes = Math.max(0, Math.min(toMinutes, 60) - Math.max(fromMinutes, 30));
  const laterMinutes = Math.max(0, toMinutes - Math.max(fromMinutes, 60));
  return (first30Minutes / 30) * first30Rate
    + (next30Minutes / 30) * (hourlyRate - first30Rate)
    + (laterMinutes / 60) * hourlyRate;
}

function calculateTimedPrice(minutes: number, hourlyRate: number, first30Rate: number, roundingStep: number): number {
  const amount = segmentPrice(0, minutes, hourlyRate, first30Rate);
  if (minutes > 30) {
    if (minutes === 60) return hourlyRate;
    const anchor = minutes < 60 ? first30Rate : hourlyRate;
    const increase = Math.ceil((amount - anchor - 1e-9) / roundingStep) * roundingStep;
    return roundCurrency(minutes < 60 ? Math.min(hourlyRate, anchor + increase) : anchor + increase);
  }
  return roundCurrency(amount);
}

/** Açık veya kapanmış bir oturumun ücretini hesaplar.
 * Süreli oturumlarda (targetMinutes belirlenmişse) belirlenen süre dolana kadar sabit paket ücreti alınır.
 * Süre dolduğunda kullanım ücreti sabit kalır; ödeme daha sonra alınabilir.
 */
export function calculateSessionTotal(
  startedAt: string | number | Date,
  hourlyRate: number,
  first30Rate?: number | null,
  now: string | number | Date = new Date(),
  accruedAmount: number = 0,
  segmentStartedAt?: string | number | Date | null,
  targetMinutes?: number | null,
  roundingStep: number = 1
): number {
  const sessionStart = new Date(startedAt).getTime();
  const segStart = segmentStartedAt ? new Date(segmentStartedAt).getTime() : sessionStart;
  const end = new Date(now).getTime();

  const totalElapsedMinutes = Math.max(0, (end - sessionStart) / 60_000);
  const first30Price = first30Rate != null && first30Rate > 0 ? first30Rate : hourlyRate / 2;
  const initialSegment = (Number(accruedAmount) || 0) === 0 && segStart === sessionStart;
  const fromMinutes = Math.max(0, (segStart - sessionStart) / 60_000);
  const billedMinutes = targetMinutes && targetMinutes > 0 ? targetMinutes : totalElapsedMinutes;
  const toMinutes = Math.max(fromMinutes, targetMinutes ? billedMinutes : Math.max(30, billedMinutes));
  const rawTotal = initialSegment && !targetMinutes && toMinutes <= 30
    ? first30Price
    : (Number(accruedAmount) || 0) + segmentPrice(fromMinutes, toMinutes, hourlyRate, first30Price);
  if (billedMinutes > 30) {
    if (initialSegment && Math.abs(billedMinutes - 60) < 1e-8) return roundCurrency(hourlyRate);
    if (initialSegment) {
      const anchor = billedMinutes < 60 ? first30Price : hourlyRate;
      const increase = Math.ceil((rawTotal - anchor - 1e-9) / roundingStep) * roundingStep;
      return roundCurrency(billedMinutes < 60 ? Math.min(hourlyRate, anchor + increase) : anchor + increase);
    }
    return roundCurrency(Math.ceil((rawTotal - 1e-9) / roundingStep) * roundingStep);
  }
  return roundCurrency(rawTotal);
}




/** Kaydedilmiş başlangıç zamanı sayesinde yeniden açılışta kalan süreyi hesaplar. */
export function elapsedMilliseconds(startedAt: string | Date, now: string | Date = new Date()): number {
  return Math.max(0, new Date(now).getTime() - new Date(startedAt).getTime());
}

/** Süreli oturumlar için kalan milisaniyeyi hesaplar (Negatif ise süre aşılmıştır). */
export function remainingMilliseconds(
  startedAt: string | Date,
  targetMinutes: number,
  now: string | Date = new Date(),
): number {
  const endTime = new Date(startedAt).getTime() + targetMinutes * 60 * 1000;
  return endTime - new Date(now).getTime();
}

export function formatElapsed(milliseconds: number): string {
  const isNegative = milliseconds < 0;
  const absMs = Math.abs(milliseconds);
  const seconds = Math.floor(absMs / 1000);
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = (seconds % 60).toString().padStart(2, "0");
  return `${isNegative ? "-" : ""}${hours}:${minutes}:${remainingSeconds}`;
}
