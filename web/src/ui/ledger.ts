import { $, h } from "../dom";
import { fmtDuration, fmtPrice, fmtSigned, signClass } from "../format";
import type { Signal, Trade } from "../types";

const TRADE_COLUMNS = ["ID", "Symbol", "Side", "Entry", "Exit", "Size", "PnL ($)", "R", "Duration", "Exit Reason"];
const SIGNAL_COLUMNS = ["ID", "Time", "Strategy", "Symbol", "Side", "Entry Price", "Stop Loss", "Take Profit", "R:R", "Comment"];
type Tab = "positions" | "closed" | "signals";

const reasonLabel = (r: Trade["exit_reason"]) => (r ? r.replace(/_/g, " ") : "—");

function row(t: Trade): HTMLTableRowElement {
  const tr = h("tr");
  const side = h("td", t.direction === "buy" ? "up" : "down", t.direction === "buy" ? "Long" : "Short");
  const closed = t.exit_time !== null;
  const cells: (HTMLElement | string)[] = [
    `#${t.id}`, t.symbol, side,
    fmtPrice(t.entry_price),
    t.exit_price !== null ? fmtPrice(t.exit_price) : "—",
    String(t.size),
    h("td", signClass(t.pnl), closed ? fmtSigned(t.pnl, 2, "$") : "—"),
    h("td", signClass(t.r_multiple), closed ? `${fmtSigned(t.r_multiple, 2)} R` : "—"),
    closed ? fmtDuration((t.exit_time as number) - t.entry_time) : "open",
    reasonLabel(t.exit_reason),
  ];
  for (const c of cells) tr.append(typeof c === "string" ? h("td", "", c) : c);
  return tr;
}

function signalRow(s: Signal): HTMLTableRowElement {
  const tr = h("tr");
  const isBuy = s.direction === "buy";
  const isSell = s.direction === "sell";
  const side = h("td", isBuy ? "up" : isSell ? "down" : "muted", isBuy ? "Buy" : isSell ? "Sell" : "Hold");

  let rr = "—";
  if (s.entry_price > 0 && s.stop_loss > 0 && s.take_profit > 0) {
    const risk = Math.abs(s.entry_price - s.stop_loss);
    const reward = Math.abs(s.take_profit - s.entry_price);
    if (risk > 0) rr = `${(reward / risk).toFixed(2)} R`;
  }

  const timeStr = new Date(s.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const cells: (HTMLElement | string)[] = [
    s.id,
    timeStr,
    s.strategy ?? "—",
    s.symbol ?? "—",
    side,
    fmtPrice(s.entry_price),
    s.stop_loss > 0 ? fmtPrice(s.stop_loss) : "—",
    s.take_profit > 0 ? fmtPrice(s.take_profit) : "—",
    rr,
    s.comment ?? "—",
  ];
  for (const c of cells) tr.append(typeof c === "string" ? h("td", "", c) : c);
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
      b.addEventListener("click", () => { active = id; render(); });
      tabs.append(b);
    }

    const head = h("thead"), hr = h("tr");
    const cols = active === "signals" ? SIGNAL_COLUMNS : TRADE_COLUMNS;
    for (const c of cols) hr.append(h("th", "", c));
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
          if (s.id === selectedSignalId) tr.classList.add("selected");
          tr.addEventListener("click", () => {
            if (selectedSignalId === s.id) {
              selectedSignalId = null;
              onSelectSignal?.(null);
            } else {
              selectedSignalId = s.id;
              onSelectSignal?.(s);
            }
            render();
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
          if (t.id === selectedTradeId) tr.classList.add("selected");
          tr.addEventListener("click", () => {
            if (selectedTradeId === t.id) {
              selectedTradeId = null;
              onSelect(null);
            } else {
              selectedTradeId = t.id;
              onSelect(t);
            }
            render();
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

