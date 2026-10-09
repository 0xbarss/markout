import { $, h } from "../dom.ts";
import { fmt, fmtSigned, signClass } from "../format.ts";
import type { Stats, Trade } from "../types.ts";

export function renderStats(s: Stats, trades: Trade[] = []): void {
  // 1. Hero PnL
  const hero = document.getElementById("hero-pnl");
  if (hero) {
    hero.textContent = fmtSigned(s.net_pnl, 2, "$");
    hero.className = `panel-hero-value ${signClass(s.net_pnl)}`;
  }

  // 2. Closed trades calculation for sparkline, R-dist, exit reasons, and MAE/MFE
  const closed = trades.filter((t) => t.exit_time !== null);
  closed.sort((a, b) => ((a.exit_time ?? 0) - (b.exit_time ?? 0)) || a.id - b.id);

  // Sparkline
  const sparklinePath = document.getElementById("sparkline-path");
  const sparklineDd = document.getElementById("sparkline-drawdown");
  if (sparklinePath && closed.length > 0) {
    let cum = 0;
    const pts = [0];
    let min = 0;
    let max = 0;
    for (const t of closed) {
      cum += t.pnl;
      pts.push(cum);
      if (cum < min) min = cum;
      if (cum > max) max = cum;
    }
    const range = max - min || 1;
    const w = 190;
    const h = 40;
    const pad = 4;
    const path = pts.map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");

    sparklinePath.setAttribute("d", path);
    sparklinePath.setAttribute("stroke", cum >= 0 ? "var(--up)" : "var(--down)");
    if (sparklineDd && s.max_drawdown > 0) {
      sparklineDd.textContent = `Max DD: -$${fmt(s.max_drawdown)}`;
      sparklineDd.className = "sparkline-val down";
    }
  }

  // R-Multiple Distribution Histogram
  const rDistEl = document.getElementById("r-dist-bars");
  if (rDistEl) {
    rDistEl.replaceChildren();

    const rTitle = document.getElementById("r-dist-title");
    if (rTitle) {
      rTitle.textContent = closed.length ? `R-Distribution (${closed.length})` : "R-Distribution";
    }

    const buckets = [
      { label: "<-2", min: -Infinity, max: -2, count: 0, pos: false },
      { label: "-1", min: -2, max: -0.5, count: 0, pos: false },
      { label: "0", min: -0.5, max: 0.5, count: 0, pos: false },
      { label: "+1", min: 0.5, max: 2, count: 0, pos: true },
      { label: "+2", min: 2, max: 3, count: 0, pos: true },
      { label: ">+3", min: 3, max: Infinity, count: 0, pos: true },
    ];

    for (const t of closed) {
      const r = t.r_multiple;
      for (const b of buckets) {
        if (r >= b.min && r < b.max) {
          b.count++;
          break;
        }
      }
    }

    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    for (const b of buckets) {
      const col = h("div", "r-bar-col");
      const share = closed.length > 0 ? ((b.count / closed.length) * 100).toFixed(1) : "0";
      col.title = `${b.label}R: ${b.count} trades (${share}%)`;

      const countBadge = h("span", b.count > 0 ? "r-bar-count active" : "r-bar-count", String(b.count));
      const track = h("div", "r-bar-track");
      const fill = h("div", `r-bar-fill ${b.pos ? "pos" : "neg"}`);

      if (b.count > 0) {
        const pct = Math.round((b.count / maxCount) * 100);
        fill.style.height = `${Math.max(12, pct)}%`;
      } else {
        fill.style.height = "0%";
      }

      track.append(fill);
      const lbl = h("span", "r-bar-lbl", b.label);
      col.append(countBadge, track, lbl);
      rDistEl.append(col);
    }
  }

  // Exit Reason Breakdown
  const exitPillsEl = document.getElementById("exit-pills");
  if (exitPillsEl) {
    exitPillsEl.replaceChildren();
    const counts: Record<string, number> = { TP: 0, TS: 0, SL: 0, Sig: 0, Man: 0 };
    for (const t of closed) {
      if (t.exit_reason === "take_profit") counts.TP++;
      else if (t.exit_reason === "trailing_stop") counts.TS++;
      else if (t.exit_reason === "initial_stop") counts.SL++;
      else if (t.exit_reason === "signal") counts.Sig++;
      else if (t.exit_reason === "manual") counts.Man++;
    }
    for (const [tag, count] of Object.entries(counts)) {
      if (count > 0 || closed.length === 0) {
        const pill = h("div", "exit-pill");
        pill.append(document.createTextNode(tag), h("span", "", String(count)));
        exitPillsEl.append(pill);
      }
    }
  }

  // Calculate Average MAE / MFE
  let avgMaeStr = "—";
  let avgMfeStr = "—";
  const maeTrades = closed.filter((t) => t.mae_pct !== null && !isNaN(t.mae_pct));
  if (maeTrades.length > 0) {
    const avgMae = maeTrades.reduce((acc, t) => acc + (t.mae_pct as number), 0) / maeTrades.length;
    avgMaeStr = `${fmtSigned(avgMae, 2)}%`;
  }
  const mfeTrades = closed.filter((t) => t.mfe_pct !== null && !isNaN(t.mfe_pct));
  if (mfeTrades.length > 0) {
    const avgMfe = mfeTrades.reduce((acc, t) => acc + (t.mfe_pct as number), 0) / mfeTrades.length;
    avgMfeStr = `${fmtSigned(avgMfe, 2)}%`;
  }

  // Profit Factor
  const pfStr = s.profit_factor !== null
    ? fmt(s.profit_factor, 2)
    : (s.closed_trades > 0 && s.wins > 0 ? "∞" : "—");

  // Rows for DL list
  const rows: [string, string, string][] = [
    ["Win Rate", s.closed_trades ? `${fmt(s.win_rate * 100, 1)}%` : "—", ""],
    ["Profit Factor", pfStr, ""],
    ["Avg R", s.closed_trades ? fmtSigned(s.avg_r, 2) : "—", signClass(s.avg_r)],
    ["Max DD", s.max_drawdown ? `$${fmt(s.max_drawdown)}` : "—", s.max_drawdown ? "down" : ""],
    ["Avg MAE", avgMaeStr, avgMaeStr !== "—" ? "down" : ""],
    ["Avg MFE", avgMfeStr, avgMfeStr !== "—" ? "up" : ""],
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

  // Mobile Summary Strip
  const mobWr = document.getElementById("mob-wr");
  const mobR = document.getElementById("mob-r");
  const mobPnl = document.getElementById("mob-pnl");
  if (mobWr) mobWr.textContent = s.closed_trades ? `WR: ${fmt(s.win_rate * 100, 1)}%` : "WR: —";
  if (mobR) mobR.textContent = s.closed_trades ? `R: ${fmtSigned(s.avg_r, 2)}` : "R: —";
  if (mobPnl) {
    mobPnl.textContent = `PnL: ${fmtSigned(s.net_pnl, 2, "$")}`;
    mobPnl.className = signClass(s.net_pnl);
  }
}
