use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    #[serde(alias = "buy", alias = "long", alias = "enter_long")]
    Buy,
    #[serde(alias = "sell", alias = "short", alias = "enter_short")]
    Sell,
    #[serde(alias = "hold", alias = "neutral", alias = "none")]
    Hold,
}

impl std::fmt::Display for Direction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Direction::Buy => write!(f, "buy"),
            Direction::Sell => write!(f, "sell"),
            Direction::Hold => write!(f, "hold"),
        }
    }
}

/// Strategy signal matching ts_core::Signal specifications:
/// - `direction`: Buy, Sell, Hold
/// - `entry_price`: execution / signal price
/// - `stop_loss`: stop-loss level
/// - `take_profit`: take-profit level
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Signal {
    #[serde(default)]
    pub id: String,
    #[serde(alias = "timestamp")]
    pub time: i64,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(alias = "action", alias = "side", alias = "signal")]
    pub direction: Direction,
    #[serde(alias = "price")]
    pub entry_price: f64,
    #[serde(default, alias = "sl", alias = "initial_sl")]
    pub stop_loss: f64,
    #[serde(default, alias = "tp")]
    pub take_profit: f64,
    #[serde(default, alias = "name")]
    pub strategy: Option<String>,
    #[serde(default, alias = "note")]
    pub comment: Option<String>,
}

impl Signal {
    pub fn is_valid(&self) -> bool {
        let no_tp = self.take_profit == 0.0;
        match self.direction {
            Direction::Buy => {
                self.entry_price > self.stop_loss && (no_tp || self.take_profit > self.entry_price)
            }
            Direction::Sell => {
                self.entry_price < self.stop_loss && (no_tp || self.take_profit < self.entry_price)
            }
            Direction::Hold => false,
        }
    }
}
