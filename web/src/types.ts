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
