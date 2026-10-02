import { $, h } from "../dom";
import { fmtPrice, fmtSigned, signClass } from "../format";
import { isResamplable, TIMEFRAMES } from "../resample";
import type { AccountSnapshot, Bar, Stats, Tick } from "../types.ts";

export function renderSymbol(symbol: string): void {
  $("symbol").textContent = symbol;
}

/** Timeframe pills; those not cleanly aggregatable from the data's native interval are disabled. */
export function renderTimeframes(base: number, active: number, onSelect: (sec: number) => void): void {
  const el = $("tf-pills");
  el.replaceChildren();
  for (const tf of TIMEFRAMES) {
    const b = h("button", tf.sec === active ? "active" : "", tf.label);
    const valid = isResamplable(base, tf.sec);
    b.disabled = !valid;
    if (valid) {
      b.addEventListener("click", () => onSelect(tf.sec));
    }
    el.append(b);
  }
}


export function renderTicker(bars: Bar[]): void {
  const last = bars[bars.length - 1];
  if (!last) return;
  const prev = bars[bars.length - 2];
  $("last-price").textContent = fmtPrice(last.close);
  if (prev && prev.close !== 0) {
    const pct = ((last.close - prev.close) / prev.close) * 100;
    const chg = $("last-change");
    chg.textContent = `${fmtSigned(pct)}%`;
    chg.className = `chg ${signClass(pct)}`;
  }
}

export function renderTick(tick: Tick, prevClose?: number): void {
  $("last-price").textContent = fmtPrice(tick.price);
  if (prevClose && prevClose !== 0) {
    const pct = ((tick.price - prevClose) / prevClose) * 100;
    const chg = $("last-change");
    chg.textContent = `${fmtSigned(pct)}%`;
    chg.className = `chg ${signClass(pct)}`;
  }
}

export function renderHeaderStats(stats: Stats): void {
  const pnl = $("pnl");
  pnl.textContent = fmtSigned(stats.net_pnl, 2, "$");
  pnl.className = signClass(stats.net_pnl);
}

export function renderAccount(account: AccountSnapshot): void {
  $("equity").textContent = fmtPrice(account.equity);
}

export function mountTradeOverlaySelector(
  onSelect: (mode: "focus" | "all" | "off") => void,
): void {
  const container = document.getElementById("trade-mode-pills");
  if (!container) return;
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn.dataset.mode || "focus") as "focus" | "all" | "off";
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      onSelect(mode);
    });
  });
}

