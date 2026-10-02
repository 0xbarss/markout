import { $, h } from "../dom";
import { fmtDuration, fmtPrice, fmtSigned, signClass } from "../format";
import type { Trade } from "../types";

const COLUMNS = ["ID", "Symbol", "Side", "Entry", "Exit", "Size", "PnL ($)", "R", "Duration", "Exit Reason"];
type Tab = "positions" | "closed";

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

export interface LedgerHandle {
  update(trades: Trade[]): void;
}

export function mountLedger(trades: Trade[], onSelect: (t: Trade) => void): LedgerHandle {
  let currentTrades = trades;
  let open = currentTrades.filter((t) => t.exit_time === null);
  let closed = currentTrades.filter((t) => t.exit_time !== null).sort((a, b) => (b.exit_time as number) - (a.exit_time as number));
  const tabs = $("tabs"), table = $("ledger");
  let active: Tab = "closed";
  let selected: number | null = null;

  const render = () => {
    tabs.replaceChildren();
    for (const [id, label, n] of [["positions", "Positions", open.length], ["closed", "Closed Trades", closed.length]] as [Tab, string, number][]) {
      const b = h("button", id === active ? "active" : "", `${label} (${n})`);
      b.addEventListener("click", () => { active = id; render(); });
      tabs.append(b);
    }
    const head = h("thead"), hr = h("tr");
    for (const c of COLUMNS) hr.append(h("th", "", c));
    head.append(hr);

    const body = h("tbody");
    const list = active === "positions" ? open : closed;
    if (list.length === 0) {
      const td = h("td", "none", active === "positions" ? "No open positions" : "No closed trades");
      td.colSpan = COLUMNS.length;
      const tr = h("tr");
      tr.append(td);
      body.append(tr);
    } else {
      for (const t of list) {
        const tr = row(t);
        if (t.id === selected) tr.classList.add("selected");
        tr.addEventListener("click", () => { selected = t.id; onSelect(t); render(); });
        body.append(tr);
      }
    }
    table.replaceChildren(head, body);
  };
  render();

  return {
    update(nextTrades: Trade[]): void {
      currentTrades = nextTrades;
      open = currentTrades.filter((t) => t.exit_time === null);
      closed = currentTrades.filter((t) => t.exit_time !== null).sort((a, b) => (b.exit_time as number) - (a.exit_time as number));
      render();
    },
  };
}

