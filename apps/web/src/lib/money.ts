/**
 * Money helpers for the browser. Every amount is an integer number of satang;
 * these functions only turn it into text or read text into satang. No division
 * that can leave a fraction, and no floating-point parsing.
 */

const bahtFormatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 });

/** 69800 -> "698.00", 1590000 -> "15,900.00". Uses integer division only. */
export function formatSatang(satang: number): string {
  if (!Number.isSafeInteger(satang)) throw new RangeError("satang must be a safe integer");
  const negative = satang < 0;
  const abs = Math.abs(satang);
  const baht = Math.trunc(abs / 100);
  const rest = abs % 100;
  const text = `${bahtFormatter.format(baht)}.${String(rest).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** "฿698.00" */
export function formatBaht(satang: number): string {
  return `฿${formatSatang(satang)}`;
}

const BAHT_INPUT = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/;

/**
 * Reads what an admin typed as baht ("120", "120.5", "1,200.50") into satang
 * by splitting the string, so "0.1" is exactly 10 satang. Returns null for
 * anything that is not a plain non-negative amount with at most 2 decimals.
 */
export function parseBahtToSatang(input: string): number | null {
  const cleaned = input.trim().replaceAll(",", "");
  const match = BAHT_INPUT.exec(cleaned);
  if (!match) return null;
  const baht = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const satang = baht * 100 + fraction;
  return Number.isSafeInteger(satang) ? satang : null;
}
