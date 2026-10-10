export const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function segmentPrice(from, to, hourly, first30) {
  const opening = Math.max(0, Math.min(to, 30) - Math.min(from, 30));
  const next = Math.max(0, Math.min(to, 60) - Math.max(from, 30));
  const later = Math.max(0, to - Math.max(from, 60));
  return opening * first30 / 30 + next * (hourly - first30) / 30 + later * hourly / 60;
}

export function roundGameAmount(raw, minutes, hourly, first30, step = 1, mode = 'settlement', initial = true, timed = false) {
  raw = cents(raw);
  // Opening fee and the first full-hour tariff are exact commercial prices.
  if (initial && ((!timed && minutes <= 30) || Math.abs(minutes - 30) < 1e-8)) return cents(first30);
  if (initial && minutes >= 60 && Math.abs(minutes / 60 - Math.round(minutes / 60)) < 1e-8) return cents(hourly * Math.round(minutes / 60));
  const rounded = mode === 'live' && !timed
    ? Math.floor((raw + 1e-9) / step) * step
    : Math.ceil((raw - 1e-9) / step) * step;
  // Never jump past an exact tariff, or drop below it just after reaching it.
  if (initial && timed && minutes < 30) return cents(Math.min(first30, Math.max(0, rounded)));
  if (initial && minutes > 30 && minutes < 60) return cents(Math.max(first30, Math.min(hourly, rounded)));
  if (initial && minutes > 60) return cents(Math.max(Math.floor(minutes / 60) * hourly, Math.min(Math.ceil(minutes / 60) * hourly, rounded)));
  return cents(Math.max(0, rounded));
}

export function calculateAmount(startedAt, hourlyRate, first30Rate, endedAt = Date.now(), accruedAmount = 0, segmentStartedAt = null, targetMinutes = null, step = 1, mode = 'settlement') {
  const start = new Date(startedAt).getTime();
  const segment = segmentStartedAt ? new Date(segmentStartedAt).getTime() : start;
  const elapsed = Math.max(0, (new Date(endedAt).getTime() - start) / 60000);
  const first30 = first30Rate != null && first30Rate > 0 ? first30Rate : hourlyRate / 2;
  const initial = (Number(accruedAmount) || 0) === 0 && segment === start;
  const from = Math.max(0, (segment - start) / 60000);
  const minutes = targetMinutes || elapsed;
  const to = Math.max(from, targetMinutes || Math.max(30, minutes));
  const raw = (Number(accruedAmount) || 0) + segmentPrice(from, to, hourlyRate, first30);
  return roundGameAmount(raw, minutes, hourlyRate, first30, step, mode, initial, Boolean(targetMinutes));
}

export function calculatePriceForMinutes(minutes, hourlyRate, first30Rate, step = 1) {
  return calculateAmount(0, hourlyRate, first30Rate, 0, 0, null, minutes, step);
}

export function tariffRates(category, fallback = 100) {
  const hourly = category?.baseRate ?? fallback;
  const first30 = category?.first30Rate ?? hourly / 2;
  return {
    '2': { hourlyRate: hourly, first30Rate: first30 },
    '3': { hourlyRate: category?.rate3 ?? cents(hourly * 1.5), first30Rate: category?.first30Rate3 ?? cents(first30 * 1.5) },
    '4': { hourlyRate: category?.rate4 ?? cents(hourly * 2), first30Rate: category?.first30Rate4 ?? cents(first30 * 2) },
  };
}
export function rateForControllers(rates, count) { return rates[count <= 2 ? '2' : count === 3 ? '3' : '4']; }
