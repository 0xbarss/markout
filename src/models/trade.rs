use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TradeSide {
    /// Long
    #[serde(alias = "long")]
    Buy,
    /// Short
    #[serde(alias = "short")]
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    TakeProfit,
    TrailingStop,
    InitialStop,
    Signal,
    Manual,
}

/// One step of the trailing stop-loss path.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StopPoint {
    #[serde(deserialize_with = "crate::models::de_time")]
    pub time: i64,
    pub price: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trade {
    pub id: u64,
    pub symbol: String,
    pub direction: TradeSide,
    pub size: f64,

    #[serde(deserialize_with = "crate::models::de_time")]
    pub entry_time: i64,
    pub entry_price: f64,

    #[serde(default, deserialize_with = "crate::models::de_opt_time")]
    pub exit_time: Option<i64>,
    pub exit_price: Option<f64>,
    pub exit_reason: Option<ExitReason>,

    pub initial_sl: f64,
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub sl_history: Vec<StopPoint>,

    pub pnl: f64,
    pub r_multiple: f64,
    #[serde(default)]
    pub fee: f64,
    #[serde(default)]
    pub mae_pct: Option<f64>,
    #[serde(default)]
    pub mfe_pct: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TradeUpdateKind {
    Entry,
    PartialExit,
    Exit,
}

/// Trade lifecycle event (entry fill, partial take-profit, exit close).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TradeUpdate {
    pub kind: TradeUpdateKind,
    pub trade: Trade,
}

/// Account equity and balance snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AccountSnapshot {
    #[serde(deserialize_with = "crate::models::de_time")]
    pub time: i64,
    pub balance: f64,
    pub equity: f64,
}
