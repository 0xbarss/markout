import { $, h } from "../dom";
import { fmt, fmtSigned, signClass } from "../format";
import type { Stats } from "../types";

export function renderStats(s: Stats): void {
  const rows: [string, string, string][] = [
    ["Net PnL", fmtSigned(s.net_pnl, 2, "$"), signClass(s.net_pnl)],
    ["Win Rate", s.closed_trades ? `${fmt(s.win_rate * 100, 1)}%` : "—", ""],
    ["Avg R", s.closed_trades ? fmtSigned(s.avg_r, 2) : "—", signClass(s.avg_r)],
    ["Max DD", s.max_drawdown ? `$${fmt(s.max_drawdown)}` : "—", s.max_drawdown ? "down" : ""],
    ["Fees", `$${fmt(s.total_fees)}`, ""],
    ["Trades", `${s.closed_trades} closed / ${s.open_trades} open`, ""],
  ];
  const dl = $("stats");
  dl.replaceChildren();
  for (const [label, value, cls] of rows) {
    const row = h("div", "row");
    row.append(h("dt", "", label), h("dd", cls, value));
    dl.append(row);
  }
}
