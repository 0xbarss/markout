import { $, h } from "../dom";
import { fmtDuration, fmtPrice, fmtSigned, signClass } from "../format";
import type { Signal, Trade } from "../types";

export interface ColumnDef {
  label: string;
  align: "left" | "right" | "center";
}

const TRADE_COLUMNS: ColumnDef[] = [
  { label: "ID", align: "left" },
  { label: "Symbol", align: "left" },
  { label: "Side", align: "left" },
  { label: "Entry", align: "right" },
  { label: "Exit", align: "right" },
  { label: "Size", align: "right" },
  { label: "PnL ($)", align: "right" },
  { label: "R", align: "right" },
  { label: "MAE", align: "right" },
  { label: "MFE", align: "right" },
  { label: "Duration", align: "right" },
  { label: "Exit Reason", align: "center" },
];

const SIGNAL_COLUMNS: ColumnDef[] = [
  { label: "ID", align: "left" },
  { label: "Time", align: "left" },
  { label: "Strategy", align: "left" },
  { label: "Symbol", align: "left" },
  { label: "Side", align: "left" },
  { label: "Entry Price", align: "right" },
  { label: "Stop Loss", align: "right" },
  { label: "Take Profit", align: "right" },
  { label: "R:R", align: "right" },
  { label: "Comment", align: "left" },
];

type Tab = "positions" | "closed" | "signals";

const reasonLabel = (r: Trade["exit_reason"]) => (r ? r.replace(/_/g, " ") : "—");

function row(t: Trade): HTMLTableRowElement {
  const tr = h("tr");
  const closed = t.exit_time !== null;

  // ID
  const idCell = h("td", "col-left", `#${t.id}`);
  // Symbol
  const symCell = h("td", "col-left", t.symbol);
  // Side
  const side = h("td", `col-left ${t.direction === "buy" ? "up" : "down"}`, t.direction === "buy" ? "Long" : "Short");
  // Entry
  const entryCell = h("td", "col-right", fmtPrice(t.entry_price));
  // Exit
  const exitCell = h("td", "col-right", t.exit_price !== null ? fmtPrice(t.exit_price) : "—");
  // Size
  const sizeCell = h("td", "col-right", String(t.size));
  // PnL
  const pnlCell = h("td", `col-right ${signClass(t.pnl)}`, closed ? fmtSigned(t.pnl, 2, "$") : "—");

  // R with micro bar
  const rCell = h("td", "col-right");
  if (closed) {
    const wrap = h("div", "r-cell");
    const bar = h("span", "r-micro-bar");
    const fill = h("span", `r-micro-fill ${signClass(t.r_multiple)}`);
    const w = Math.min(100, Math.max(12, Math.round(Math.abs(t.r_multiple) * 35)));
    fill.style.width = `${w}%`;
    bar.append(fill);
    wrap.append(bar, document.createTextNode(`${fmtSigned(t.r_multiple, 2)} R`));
    rCell.append(wrap);
  } else {
    rCell.textContent = "—";
  }

  // MAE
  const maeVal = t.mae_pct !== null && !isNaN(t.mae_pct) ? `${fmtSigned(t.mae_pct, 2)}%` : "—";
  const maeCell = h("td", `col-right ${t.mae_pct !== null && t.mae_pct !== 0 ? "down" : ""}`, maeVal);

  // MFE
  const mfeVal = t.mfe_pct !== null && !isNaN(t.mfe_pct) ? `${fmtSigned(t.mfe_pct, 2)}%` : "—";
  const mfeCell = h("td", `col-right ${t.mfe_pct !== null && t.mfe_pct > 0 ? "up" : ""}`, mfeVal);

  // Duration
  const durCell = h("td", "col-right", closed ? fmtDuration((t.exit_time as number) - t.entry_time) : "open");

  // Exit Reason
  const reasonCell = h("td", "col-center", reasonLabel(t.exit_reason));

  tr.append(idCell, symCell, side, entryCell, exitCell, sizeCell, pnlCell, rCell, maeCell, mfeCell, durCell, reasonCell);
  return tr;
}

function signalRow(s: Signal): HTMLTableRowElement {
  const tr = h("tr");
  const isBuy = s.direction === "buy";
  const isSell = s.direction === "sell";
  const side = h("td", `col-left ${isBuy ? "up" : isSell ? "down" : "muted"}`, isBuy ? "Buy" : isSell ? "Sell" : "Hold");

  let rr = "—";
  if (s.entry_price > 0 && s.stop_loss > 0 && s.take_profit > 0) {
    const risk = Math.abs(s.entry_price - s.stop_loss);
    const reward = Math.abs(s.take_profit - s.entry_price);
    if (risk > 0) rr = `${(reward / risk).toFixed(2)} R`;
  }

  const timeStr = new Date(s.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  tr.append(
    h("td", "col-left", s.id),
    h("td", "col-left", timeStr),
    h("td", "col-left", s.strategy ?? "—"),
    h("td", "col-left", s.symbol ?? "—"),
    side,
    h("td", "col-right", fmtPrice(s.entry_price)),
    h("td", "col-right", s.stop_loss > 0 ? fmtPrice(s.stop_loss) : "—"),
    h("td", "col-right", s.take_profit > 0 ? fmtPrice(s.take_profit) : "—"),
    h("td", "col-right", rr),
    h("td", "col-left", s.comment ?? "—"),
  );
  return tr;
}

export interface LedgerHandle {
  update(trades: Trade[], signals?: Signal[]): void;
}

export function mountLedger(
  trades: Trade[],
  onSelect: (t: Trade | null) => void,
  signals: Signal[] = [],
  onSelectSignal?: (s: Signal | null) => void,
): LedgerHandle {
  let currentTrades = trades;
  let currentSignals = signals;
  let open = currentTrades.filter((t) => t.exit_time === null);
  let closed = currentTrades.filter((t) => t.exit_time !== null).sort((a, b) => (b.exit_time as number) - (a.exit_time as number));
  const tabs = $("tabs"), table = $("ledger");
  let active: Tab = "closed";
  let selectedTradeId: number | null = null;
  let selectedSignalId: string | null = null;

  const render = () => {
    tabs.setAttribute("role", "tablist");
    tabs.replaceChildren();
    const tabList: [Tab, string, number][] = [
      ["positions", "Positions", open.length],
      ["closed", "Closed Trades", closed.length],
    ];
    if (currentSignals.length > 0) {
      tabList.push(["signals", "Signals ⚡", currentSignals.length]);
    }

    for (const [id, label, n] of tabList) {
      const b = h("button", id === active ? "active" : "", `${label} (${n})`);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", id === active ? "true" : "false");
      b.addEventListener("click", () => { active = id; render(); });
      tabs.append(b);
    }

    const head = h("thead"), hr = h("tr");
    const cols = active === "signals" ? SIGNAL_COLUMNS : TRADE_COLUMNS;
    for (const col of cols) {
      hr.append(h("th", `col-${col.align}`, col.label));
    }
    head.append(hr);

    const body = h("tbody");
    if (active === "signals") {
      if (currentSignals.length === 0) {
        const td = h("td", "none", "No strategy signals");
        td.colSpan = cols.length;
        const tr = h("tr");
        tr.append(td);
        body.append(tr);
      } else {
        for (const s of currentSignals) {
          const tr = signalRow(s);
          tr.setAttribute("tabindex", "0");
          tr.setAttribute("role", "row");
          if (s.id === selectedSignalId) {
            tr.classList.add("selected");
            tr.setAttribute("aria-selected", "true");
          } else {
            tr.setAttribute("aria-selected", "false");
          }
          const activate = () => {
            if (selectedSignalId === s.id) {
              selectedSignalId = null;
              onSelectSignal?.(null);
            } else {
              selectedSignalId = s.id;
              onSelectSignal?.(s);
            }
            render();
          };
          tr.addEventListener("click", activate);
          tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activate();
            }
          });
          body.append(tr);
        }
      }
    } else {
      const list = active === "positions" ? open : closed;
      if (list.length === 0) {
        const td = h("td", "none", active === "positions" ? "No open positions" : "No closed trades");
        td.colSpan = cols.length;
        const tr = h("tr");
        tr.append(td);
        body.append(tr);
      } else {
        for (const t of list) {
          const tr = row(t);
          tr.setAttribute("tabindex", "0");
          tr.setAttribute("role", "row");
          if (t.id === selectedTradeId) {
            tr.classList.add("selected");
            tr.setAttribute("aria-selected", "true");
          } else {
            tr.setAttribute("aria-selected", "false");
          }
          const activate = () => {
            if (selectedTradeId === t.id) {
              selectedTradeId = null;
              onSelect(null);
            } else {
              selectedTradeId = t.id;
              onSelect(t);
            }
            render();
          };
          tr.addEventListener("click", activate);
          tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activate();
            }
          });
          body.append(tr);
        }
      }
    }
    table.replaceChildren(head, body);
  };
  render();

  return {
    update(nextTrades: Trade[], nextSignals?: Signal[]): void {
      currentTrades = nextTrades;
      if (nextSignals !== undefined) currentSignals = nextSignals;
      open = currentTrades.filter((t) => t.exit_time === null);
      closed = currentTrades.filter((t) => t.exit_time !== null).sort((a, b) => (b.exit_time as number) - (a.exit_time as number));
      render();
    },
  };
}
