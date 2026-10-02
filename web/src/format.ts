/** Decimal places that suit a price's magnitude (FX-sized prices get more). */
export function precisionFor(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 10) return 3;
  return 5;
}

export function fmt(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtPrice(n: number): string { return fmt(n, precisionFor(n)); }

export function fmtSigned(n: number, dp = 2, prefix = ""): string {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${prefix}${fmt(Math.abs(n), dp)}`;
}

export function signClass(n: number): string { return n > 0 ? "up" : n < 0 ? "down" : ""; }

export function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d}d`, h && `${h}h`, (mm || (!d && !h)) && `${mm}m`].filter(Boolean).join(" ");
}
