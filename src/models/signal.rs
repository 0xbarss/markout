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
        self.validate().is_ok()
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.entry_price.is_finite() {
            return Err("entry price must be finite");
        }
        if self.entry_price <= 0.0 {
            return Err("entry price must be positive");
        }
        if !self.stop_loss.is_finite() {
            return Err("stop loss must be finite");
        }
        if self.stop_loss < 0.0 {
            return Err("stop loss must be non-negative");
        }
        if !self.take_profit.is_finite() {
            return Err("take profit must be finite");
        }
        if self.take_profit < 0.0 {
            return Err("take profit must be non-negative");
        }

        let no_sl = self.stop_loss == 0.0;
        let no_tp = self.take_profit == 0.0;

        match self.direction {
            Direction::Buy => {
                if !no_sl && self.stop_loss >= self.entry_price {
                    return Err("buy stop loss must be below entry price");
                }
                if !no_tp && self.take_profit <= self.entry_price {
                    return Err("buy take profit must be above entry price");
                }
            }
            Direction::Sell => {
                if !no_sl && self.stop_loss <= self.entry_price {
                    return Err("sell stop loss must be above entry price");
                }
                if !no_tp && self.take_profit >= self.entry_price {
                    return Err("sell take profit must be below entry price");
                }
            }
            Direction::Hold => {}
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_signal(direction: Direction, entry: f64, sl: f64, tp: f64) -> Signal {
        Signal {
            id: "sig_test".into(),
            time: 1700000000,
            symbol: Some("BTCUSDT".into()),
            direction,
            entry_price: entry,
            stop_loss: sl,
            take_profit: tp,
            strategy: None,
            comment: None,
        }
    }

    #[test]
    fn valid_signals() {
        assert!(test_signal(Direction::Buy, 100.0, 95.0, 110.0).is_valid());
        assert!(test_signal(Direction::Sell, 100.0, 105.0, 90.0).is_valid());
        assert!(test_signal(Direction::Hold, 100.0, 0.0, 0.0).is_valid());
        assert!(test_signal(Direction::Hold, 100.0, 120.0, 80.0).is_valid());
        assert!(test_signal(Direction::Buy, 100.0, 95.0, 0.0).is_valid());
        assert!(test_signal(Direction::Buy, 100.0, 0.0, 110.0).is_valid());
        assert!(test_signal(Direction::Sell, 100.0, 105.0, 0.0).is_valid());
        assert!(test_signal(Direction::Sell, 100.0, 0.0, 90.0).is_valid());
    }

    #[test]
    fn invalid_geometry_buy() {
        let sig_sl_high = test_signal(Direction::Buy, 100.0, 105.0, 110.0);
        assert_eq!(
            sig_sl_high.validate(),
            Err("buy stop loss must be below entry price")
        );
        assert!(!sig_sl_high.is_valid());

        let sig_sl_equal = test_signal(Direction::Buy, 100.0, 100.0, 110.0);
        assert_eq!(
            sig_sl_equal.validate(),
            Err("buy stop loss must be below entry price")
        );

        let sig_tp_low = test_signal(Direction::Buy, 100.0, 95.0, 90.0);
        assert_eq!(
            sig_tp_low.validate(),
            Err("buy take profit must be above entry price")
        );
        assert!(!sig_tp_low.is_valid());

        let sig_tp_equal = test_signal(Direction::Buy, 100.0, 95.0, 100.0);
        assert_eq!(
            sig_tp_equal.validate(),
            Err("buy take profit must be above entry price")
        );
    }

    #[test]
    fn invalid_geometry_sell() {
        let sig_sl_low = test_signal(Direction::Sell, 100.0, 95.0, 90.0);
        assert_eq!(
            sig_sl_low.validate(),
            Err("sell stop loss must be above entry price")
        );
        assert!(!sig_sl_low.is_valid());

        let sig_sl_equal = test_signal(Direction::Sell, 100.0, 100.0, 90.0);
        assert_eq!(
            sig_sl_equal.validate(),
            Err("sell stop loss must be above entry price")
        );

        let sig_tp_high = test_signal(Direction::Sell, 100.0, 105.0, 110.0);
        assert_eq!(
            sig_tp_high.validate(),
            Err("sell take profit must be below entry price")
        );
        assert!(!sig_tp_high.is_valid());

        let sig_tp_equal = test_signal(Direction::Sell, 100.0, 105.0, 100.0);
        assert_eq!(
            sig_tp_equal.validate(),
            Err("sell take profit must be below entry price")
        );
    }

    #[test]
    fn invalid_prices() {
        let sig_zero_entry = test_signal(Direction::Buy, 0.0, 0.0, 0.0);
        assert_eq!(
            sig_zero_entry.validate(),
            Err("entry price must be positive")
        );

        let sig_neg_entry = test_signal(Direction::Buy, -10.0, 0.0, 0.0);
        assert_eq!(
            sig_neg_entry.validate(),
            Err("entry price must be positive")
        );

        let sig_nan_entry = test_signal(Direction::Buy, f64::NAN, 95.0, 110.0);
        assert_eq!(sig_nan_entry.validate(), Err("entry price must be finite"));

        let sig_inf_sl = test_signal(Direction::Buy, 100.0, f64::INFINITY, 110.0);
        assert_eq!(sig_inf_sl.validate(), Err("stop loss must be finite"));

        let sig_neg_sl = test_signal(Direction::Buy, 100.0, -5.0, 110.0);
        assert_eq!(sig_neg_sl.validate(), Err("stop loss must be non-negative"));

        let sig_nan_tp = test_signal(Direction::Buy, 100.0, 95.0, f64::NAN);
        assert_eq!(sig_nan_tp.validate(), Err("take profit must be finite"));

        let sig_neg_tp = test_signal(Direction::Buy, 100.0, 95.0, -10.0);
        assert_eq!(
            sig_neg_tp.validate(),
            Err("take profit must be non-negative")
        );
    }
}
