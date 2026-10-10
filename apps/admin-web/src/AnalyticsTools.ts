import type { Session } from "./App";
import { reportDeviceLabels } from "./ReportTableTools";

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export type AnalyticsBucket = { key: string; label: string; tahsilat: number; doluMasa: number };

function localKey(date: Date, granularity: "hour" | "day" | "month") {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return granularity === "month" ? day.slice(0, 7) : granularity === "day" ? day : `${day} ${String(date.getHours()).padStart(2, "0")}:00`;
}

function floorDate(date: Date, granularity: "hour" | "day" | "month") {
  const result = new Date(date);
  result.setMinutes(0, 0, 0);
  if (granularity !== "hour") result.setHours(0);
  if (granularity === "month") result.setDate(1);
  return result;
}

function nextDate(date: Date, granularity: "hour" | "day" | "month") {
  const result = new Date(date);
  if (granularity === "hour") result.setHours(result.getHours() + 1);
  else if (granularity === "day") result.setDate(result.getDate() + 1);
  else result.setMonth(result.getMonth() + 1);
  return result;
}

export function analyticsOverview(sessions: Session[], start: string, end: string, currentTime = Date.now()) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime() + 60_000;
  const validRange = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const payments = sessions.flatMap(s => (s.periodPayments ?? []).filter(payment => payment.paymentMethod !== "ucretsiz"));
  const tahsilat = roundMoney(payments.reduce((sum, payment) => sum + payment.amount, 0));
  const closed = sessions.filter(s => s.deviceId != null && s.endedAt && s.closedInPeriod !== false);
  const paidClosed = closed.filter(s => s.paymentMethod !== "ucretsiz");
  const averageBill = paidClosed.length ? roundMoney(paidClosed.reduce((sum, s) => sum + (s.totalAmount ?? 0), 0) / paidClosed.length) : 0;
  const playMinutes = validRange ? Math.round(sessions.reduce((sum, s) => {
    if (s.deviceId == null) return sum;
    const sessionStart = Date.parse(s.startedAt);
    const sessionEnd = s.endedAt ? Date.parse(s.endedAt) : currentTime;
    return sum + Math.max(0, Math.min(sessionEnd, endMs, currentTime) - Math.max(sessionStart, startMs)) / 60_000;
  }, 0)) : 0;
  return { tahsilat, closedCount: closed.length, averageBill, playMinutes };
}

export function analyticsTables(sessions: Session[]) {
  const labels = reportDeviceLabels(sessions);
  const totals = new Map<string, number>();
  for (const s of sessions) {
    if (s.deviceId == null || !s.closedInPeriod || s.closureMethod === "ucretsiz" || s.paymentMethod === "ucretsiz") continue;
    const id = String(s.deviceId);
    totals.set(id, (totals.get(id) ?? 0) + Math.max(0, (s.totalAmount ?? 0) - (s.ordersTotal ?? 0)));
  }
  return [...totals].filter(([, amount]) => amount > 0).map(([deviceId, amount]) => ({ deviceId, name: labels.get(deviceId) ?? `Masa #${deviceId}`, ciro: roundMoney(amount) })).sort((a, b) => b.ciro - a.ciro);
}

export function analyticsProducts(sessions: Session[], start: string, end: string) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end) + 60_000;
  const totals = new Map<string, { name: string; quantity: number; amount: number }>();
  for (const s of sessions) {
    for (const item of s.orderItems ?? []) {
      const createdAt = Date.parse(item.createdAt ?? s.startedAt);
      if (createdAt < startMs || createdAt >= endMs) continue;
      const current = totals.get(item.productName) ?? { name: item.productName, quantity: 0, amount: 0 };
      current.quantity += item.quantity;
      current.amount += item.totalPrice;
      totals.set(item.productName, current);
    }
  }
  return [...totals.values()].map(item => ({ ...item, amount: roundMoney(item.amount) })).sort((a, b) => b.quantity - a.quantity);
}

export function analyticsTimeline(sessions: Session[], start: string, end: string, currentTime = Date.now()) {
  const startMs = Date.parse(start);
  const endMs = Math.min(Date.parse(end) + 60_000, currentTime + 1);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { granularity: "hour" as const, points: [] as AnalyticsBucket[] };
  const days = (endMs - startMs) / 86_400_000;
  const granularity = days <= 1 ? "hour" as const : days <= 90 ? "day" as const : "month" as const;
  const points: AnalyticsBucket[] = [];
  const starts: number[] = [];
  const byKey = new Map<string, AnalyticsBucket>();
  for (let date = floorDate(new Date(startMs), granularity); date.getTime() < endMs && points.length < 500; date = nextDate(date, granularity)) {
    const key = localKey(date, granularity);
    const label = granularity === "hour" ? date.toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : granularity === "day" ? date.toLocaleDateString("tr-TR", { day: "numeric", month: "short" }) : date.toLocaleDateString("tr-TR", { month: "short", year: "numeric" });
    const point = { key, label, tahsilat: 0, doluMasa: 0 };
    points.push(point);
    starts.push(date.getTime());
    byKey.set(key, point);
  }
  for (const s of sessions) {
    for (const payment of s.periodPayments ?? []) {
      if (payment.paymentMethod === "ucretsiz") continue;
      const time = Date.parse(payment.createdAt);
      if (time < startMs || time >= endMs) continue;
      const point = byKey.get(localKey(new Date(time), granularity));
      if (point) point.tahsilat += payment.amount;
    }
    if (s.deviceId == null) continue;
    const sessionStart = Date.parse(s.startedAt);
    const sessionEnd = s.endedAt ? Date.parse(s.endedAt) : currentTime;
    if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd)) continue;
    for (let index = 0; index < points.length; index++) {
      const bucketStart = Math.max(starts[index], startMs);
      const bucketEnd = Math.min(index + 1 < points.length ? starts[index + 1] : nextDate(new Date(starts[index]), granularity).getTime(), endMs, currentTime);
      const overlap = Math.max(0, Math.min(sessionEnd, bucketEnd) - Math.max(sessionStart, bucketStart));
      if (bucketEnd > bucketStart) points[index].doluMasa += overlap / (bucketEnd - bucketStart);
    }
  }
  for (const point of points) {
    point.tahsilat = roundMoney(point.tahsilat);
    point.doluMasa = Math.round(point.doluMasa * 100) / 100;
  }
  return { granularity, points };
}
