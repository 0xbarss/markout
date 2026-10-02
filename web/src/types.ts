// Mirrors the server's JSON models.
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

export type TradeSide = "buy" | "sell";
export type ExitReason = "take_profit" | "trailing_stop" | "initial_stop" | "signal" | "manual";

export interface StopPoint { time: number; price: number; }

export interface Trade {
  id: number; symbol: string; direction: TradeSide; size: number;
  entry_time: number; entry_price: number;
  exit_time: number | null; exit_price: number | null; exit_reason: ExitReason | null;
  initial_sl: number; take_profit: number | null; sl_history: StopPoint[];
  pnl: number; r_multiple: number; fee: number;
  mae_pct: number | null; mfe_pct: number | null;
}

export interface Stats {
  total_trades: number; open_trades: number; closed_trades: number;
  wins: number; losses: number; win_rate: number;
  net_pnl: number; total_fees: number; avg_r: number; max_drawdown: number;
}

export interface Tick {
  symbol: string;
  time: number;
  price: number;
  bid?: number | null;
  ask?: number | null;
}

export type TradeUpdateKind = "entry" | "partial_exit" | "exit";

export interface TradeUpdate {
  kind: TradeUpdateKind;
  trade: Trade;
}

export interface RiskBracketEvent {
  trade_id: number;
  stop_loss: number | null;
  take_profit: number | null;
  timestamp: number;
}

export interface AccountSnapshot {
  time: number;
  balance: number;
  equity: number;
}

export type Direction = "buy" | "sell" | "hold";

export interface Signal {
  id: string;
  time: number;
  symbol?: string;
  direction: Direction;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  strategy?: string;
  comment?: string;
}

export type MarketEvent =
  | { type: "bar"; data: Bar }
  | { type: "tick"; data: Tick }
  | { type: "trade"; data: TradeUpdate }
  | { type: "signal"; data: Signal }
  | { type: "risk_bracket"; data: RiskBracketEvent }
  | { type: "account"; data: AccountSnapshot };

