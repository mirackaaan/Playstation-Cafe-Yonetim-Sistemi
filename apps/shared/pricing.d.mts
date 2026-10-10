export type Rate = { hourlyRate: number; first30Rate: number };
export type Rates = Record<string, Rate>;
export function cents(value: number): number;
export function segmentPrice(from: number, to: number, hourly: number, first30: number): number;
export function roundGameAmount(raw: number, minutes: number, hourly: number, first30: number, step?: number, mode?: string, initial?: boolean, timed?: boolean): number;
export function calculateAmount(startedAt: string | number, hourlyRate: number, first30Rate?: number | null, endedAt?: Date | number, accruedAmount?: number, segmentStartedAt?: string | null, targetMinutes?: number | null, step?: number, mode?: string): number;
export function calculatePriceForMinutes(minutes: number, hourlyRate: number, first30Rate: number, step?: number): number;
export function tariffRates(category?: {baseRate: number; first30Rate?: number | null; rate3?: number | null; first30Rate3?: number | null; rate4?: number | null; first30Rate4?: number | null}, fallback?: number): Rates;
export function rateForControllers(rates: Rates, count: number): Rate;
