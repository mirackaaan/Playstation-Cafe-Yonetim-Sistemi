import { describe, expect, it } from "vitest";
import {
  calculateMinutesFromPrice,
  calculateSessionHourlyRate,
  calculateSessionTotal,
  elapsedMilliseconds,
  formatElapsed,
  remainingMilliseconds,
} from "./index";

describe("oturum ücretlendirme ve süre hesaplama", () => {
  it("90 dakikalık oturumu saatlik ücrete göre hesaplar", () => {
    expect(calculateSessionTotal("2026-08-03T10:00:00.000Z", 120, null, "2026-08-03T11:30:00.000Z")).toBe(180);
  });

  it("ilk 30 dakika özel ücret tanımlanmışsa (Örn: İlk 30 dk 90 TL, Saatlik 150 TL) hesaplamayı doğru yapar", () => {
    const start = "2026-08-03T10:00:00.000Z";
    // Süresiz hesapta ilk 30 dakika sabit açılış ücretidir.
    expect(calculateSessionTotal(start, 150, 90, "2026-08-03T10:15:00.000Z")).toBe(90);
    // 30 dk (<=30 dk) -> 90 TL
    expect(calculateSessionTotal(start, 150, 90, "2026-08-03T10:30:00.000Z")).toBe(90);
    // 60. dakikada ilk 30 dakika ücreti saatlik ücrete tamamlanır.
    expect(calculateSessionTotal(start, 150, 90, "2026-08-03T11:00:00.000Z")).toBe(150);
  });

  it("süreli oturumda süre dolduktan sonra da paket ücreti sabit kalır", () => {
    const start = "2026-08-03T19:00:00.000Z";
    // 60 dk süreli oturum (200 TL/saat, ilk 30 dk 100 TL -> 60 dk paket fiyatı 200 TL)
    // Henüz 5. dakikadayken (süresi dolmamış) -> Beklenen Fiyat: 200 TL
    expect(calculateSessionTotal(start, 200, 100, "2026-08-03T19:05:00.000Z", 0, null, 60)).toBe(200);
    // 59. dakikadayken -> Beklenen Fiyat: 200 TL
    expect(calculateSessionTotal(start, 200, 100, "2026-08-03T19:59:00.000Z", 0, null, 60)).toBe(200);
    // 75. dakikada ödeme yapılsa da ücret süre bitimindeki tutardır.
    expect(calculateSessionTotal(start, 200, 100, "2026-08-03T20:15:00.000Z", 0, null, 60)).toBe(200);
  });


  it("fiyata göre süreli hesaplama dakikasını doğru hesaplar", () => {
    // 150 TL/saat (ilk 30 dk 75 TL)
    // 150 TL verilen bütçe -> 60 dk
    expect(calculateMinutesFromPrice(150, 150, 75)).toBe(60);
    // 300 TL verilen bütçe -> 120 dk
    expect(calculateMinutesFromPrice(300, 150, 75)).toBe(120);
    // 75 TL verilen bütçe -> 30 dk
    expect(calculateMinutesFromPrice(75, 150, 75)).toBe(30);
    expect(calculateMinutesFromPrice(25, 150, 75)).toBe(10);
    expect(calculateMinutesFromPrice(2.5, 150, 75)).toBe(1);
    expect(calculateMinutesFromPrice(300, 300, 100, 5)).toBe(60);
    expect(calculateMinutesFromPrice(350, 300, 100, 5)).toBe(70);
    expect(calculateMinutesFromPrice(105, 300, 100, 5)).toBe(30);
  });

  it("300 TL saatlik ve 100 TL ilk 30 dakika tarifesi tam saatte 300 TL olur", () => {
    const start = "2026-08-03T10:00:00.000Z";
    const at = (minutes: number, step = 5) => calculateSessionTotal(start, 300, 100, new Date(Date.parse(start) + minutes * 60_000), 0, null, null, step);
    expect(at(30)).toBe(100);
    expect(at(31)).toBe(110);
    expect(at(45)).toBe(200);
    expect(at(60)).toBe(300);
    expect(at(61)).toBe(305);
    expect(at(90)).toBe(450);
    expect(at(31, 7)).toBe(107);
    expect(at(59, 7)).toBe(296);
    expect(at(60, 7)).toBe(300);
    expect(at(61, 7)).toBe(307);
    expect(calculateMinutesFromPrice(307, 300, 100, 7)).toBe(61);
    expect(calculateSessionTotal(start, 300, 100, new Date(Date.parse(start) + 5 * 60_000), 0, null, 60, 5)).toBe(300);
  });



  it("süreli oturumlar için kalan süreyi doğru hesaplar", () => {
    const startedAt = "2026-08-03T10:00:00.000Z";
    const now = "2026-08-03T10:45:00.000Z";
    const targetMinutes = 60;
    // 60 dk - 45 dk = 15 dk kalan = 900,000 ms
    expect(remainingMilliseconds(startedAt, targetMinutes, now)).toBe(15 * 60 * 1000);
    expect(formatElapsed(remainingMilliseconds(startedAt, targetMinutes, now))).toBe("00:15:00");
  });

  it("süresiz masada ilk 30 dk içinde kol artırılırsa iki tarife kullanım süresine göre birleşir", () => {
    const startedAt = "2026-08-03T10:00:00.000Z";
    const segmentStartedAt = "2026-08-03T10:10:00.000Z"; // 10. dk'da 4 kola geçildi
    const now = "2026-08-03T10:30:00.000Z"; // 30. dk'da kapatıldı
    // İlk 10 dk: 60 TL açılış ücretinin 10/30 payı = 20 TL.
    const accrued = 20;
    // Kalan 20 dk: 120 TL açılış ücretinin 20/30 payı = 80 TL.
    expect(calculateSessionTotal(startedAt, 200, 120, now, accrued, segmentStartedAt, null)).toBe(100);
  });

  it("süresiz masada ilk 30 dk içinde kol düşürülürse (10 dk 4 kol + 20 dk 2 kol) adil hesaplar", () => {
    const startedAt = "2026-08-03T10:00:00.000Z";
    const segmentStartedAt = "2026-08-03T10:10:00.000Z"; // 10. dk'da 2 kola düşüldü
    const now = "2026-08-03T10:30:00.000Z"; // 30. dk'da kapatıldı
    // İlk 10 dk: 120 TL açılış ücretinin 10/30 payı = 40 TL.
    const accrued = 40;
    // Kalan 20 dk: 60 TL açılış ücretinin 20/30 payı = 40 TL.
    expect(calculateSessionTotal(startedAt, 100, 60, now, accrued, segmentStartedAt, null)).toBe(80);
  });

  it("ilk 30 dakika bitmeden kapatılsa da değişen kol tarifeleri hesaplanır", () => {
    const startedAt = "2026-08-03T10:00:00.000Z";
    const segmentStartedAt = "2026-08-03T10:05:00.000Z"; // 5. dk'da kol değişti
    const now = "2026-08-03T10:15:00.000Z"; // 15. dk'da kapatıldı (toplam 15 dk)
    // İlk 5 dk: 60 TL açılış ücretinin 5/30 payı = 10 TL.
    const accrued = 10;
    // Kalan 25 dk: 120 TL açılış ücretinin 25/30 payı = 100 TL.
    expect(calculateSessionTotal(startedAt, 200, 120, now, accrued, segmentStartedAt, null)).toBe(110);
  });

  it("süresiz ücret 30. dakikadan sonra katsayıya yukarı yuvarlanır", () => {
    const start = "2026-08-03T10:00:00.000Z";
    expect(calculateSessionTotal(start, 120, 60, "2026-08-03T10:30:00.000Z", 0, null, null, 5)).toBe(60);
    expect(calculateSessionTotal(start, 120, 60, "2026-08-03T10:31:00.000Z", 0, null, null, 5)).toBe(65);
    expect(calculateSessionTotal(start, 120, 60, "2026-08-03T10:36:00.000Z", 0, null, null, 5)).toBe(75);
    expect(calculateSessionTotal(start, 120, 60, "2026-08-03T10:15:00.000Z", 0, null, 15, 5)).toBe(30);
  });

  it("15 dakikalık süreli oturum 30 dakikalık tarifenin yarısını alır", () => {
    const start = "2026-08-03T10:00:00.000Z";
    expect(calculateSessionTotal(start, 150, 90, "2026-08-03T10:01:00.000Z", 0, null, 15)).toBe(45);
    expect(calculateSessionTotal(start, 150, 90, "2026-08-03T10:20:00.000Z", 0, null, 15)).toBe(45);
  });

  it("süreli masada (60 dk) kol artırılırsa kalan süre yeni tarifeden eklenir", () => {
    const startedAt = "2026-08-03T10:00:00.000Z";
    const segmentStartedAt = "2026-08-03T10:20:00.000Z"; // 20. dk'da 4 kola geçildi
    const now = "2026-08-03T11:00:00.000Z"; // 60. dk tam bittiğinde
    // 20 dk 2 kol (100 TL/saat) = 33.33 TL donduruldu
    const accrued = 33.33;
    // İlk 30 dakikanın kalan kısmı ve sonraki 30 dakika yeni tarifeden hesaplanır.
    expect(calculateSessionTotal(startedAt, 200, 50, now, accrued, segmentStartedAt, 60)).toBe(200);
  });
});
