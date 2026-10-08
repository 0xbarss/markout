use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::models::{AccountSnapshot, Bar, Signal, Tick, TradeUpdate};

/// The universal ingestion contract. Every producer maps its data to this type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum MarketEvent {
    /// Candle closed or updated (live formation or historical playback).
    Bar(Bar),
    /// Real-time tick quote.
    Tick(Tick),
    /// Trade lifecycle update.
    Trade(TradeUpdate),
    /// Strategy signal emitted.
    Signal(Signal),
    /// Dynamic risk bracket change (trailing stop moved, TP adjusted, ...).
    RiskBracket {
        trade_id: u64,
        stop_loss: Option<f64>,
        take_profit: Option<f64>,
        timestamp: i64,
    },
    /// Account equity and balance snapshot.
    Account(AccountSnapshot),
}

impl MarketEvent {
    pub fn is_valid(&self) -> bool {
        match self {
            MarketEvent::Bar(b) => crate::ingestion::validate_bar(b).is_ok(),
            MarketEvent::Tick(t) => {
                t.time > 0
                    && t.price.is_finite()
                    && t.price > 0.0
                    && t.bid.is_none_or(|p| p.is_finite() && p > 0.0)
                    && t.ask.is_none_or(|p| p.is_finite() && p > 0.0)
            }
            MarketEvent::Trade(u) => crate::ingestion::validate_trade(&u.trade).is_ok(),
            MarketEvent::Signal(s) => s.time > 0 && s.is_valid(),
            MarketEvent::RiskBracket {
                stop_loss,
                take_profit,
                timestamp,
                ..
            } => {
                *timestamp > 0
                    && stop_loss.is_none_or(|p| p.is_finite() && p > 0.0)
                    && take_profit.is_none_or(|p| p.is_finite() && p > 0.0)
            }
            MarketEvent::Account(acc) => {
                acc.time > 0 && acc.balance.is_finite() && acc.equity.is_finite()
            }
        }
    }
}

/// Thin wrapper over a Tokio broadcast channel. Cheap to clone.
#[derive(Debug, Clone)]
pub struct EventBus {
    tx: broadcast::Sender<MarketEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Wrap an existing sender (for embedding into a host application).
    pub fn from_sender(tx: broadcast::Sender<MarketEvent>) -> Self {
        Self { tx }
    }

    /// Publish an event. Returns the number of active subscribers (0 if none).
    pub fn publish(&self, event: MarketEvent) -> usize {
        self.tx.send(event).unwrap_or(0)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<MarketEvent> {
        self.tx.subscribe()
    }

    pub fn sender(&self) -> broadcast::Sender<MarketEvent> {
        self.tx.clone()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar() -> Bar {
        Bar {
            time: 1_700_000_000,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: 10.0,
        }
    }

    #[tokio::test]
    async fn publish_reaches_subscriber() {
        let bus = EventBus::new(8);
        let mut rx = bus.subscribe();
        assert_eq!(bus.publish(MarketEvent::Bar(bar())), 1);
        assert_eq!(rx.recv().await.unwrap(), MarketEvent::Bar(bar()));
    }

    #[test]
    fn publish_without_subscribers_is_ok() {
        assert_eq!(EventBus::new(8).publish(MarketEvent::Bar(bar())), 0);
    }

    #[test]
    fn json_roundtrip_is_tagged() {
        let ev = MarketEvent::RiskBracket {
            trade_id: 7,
            stop_loss: Some(99.5),
            take_profit: None,
            timestamp: 1,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"risk_bracket""#));
        assert_eq!(serde_json::from_str::<MarketEvent>(&json).unwrap(), ev);
    }

    #[test]
    fn market_event_validation() {
        let valid_bar = MarketEvent::Bar(bar());
        assert!(valid_bar.is_valid());

        let invalid_bar = MarketEvent::Bar(Bar {
            time: 1_700_000_000,
            open: 1.0,
            high: 0.5,
            low: 2.0,
            close: 1.5,
            volume: 10.0,
        });
        assert!(!invalid_bar.is_valid());

        let invalid_volume = MarketEvent::Bar(Bar {
            time: 1_700_000_000,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: -1.0,
        });
        assert!(!invalid_volume.is_valid());

        let valid_tick = MarketEvent::Tick(Tick {
            symbol: "BTCUSDT".into(),
            time: 1_700_000_000,
            price: 50000.0,
            bid: Some(49999.0),
            ask: Some(50001.0),
        });
        assert!(valid_tick.is_valid());

        let invalid_tick = MarketEvent::Tick(Tick {
            symbol: "BTCUSDT".into(),
            time: 0,
            price: -50.0,
            bid: None,
            ask: None,
        });
        assert!(!invalid_tick.is_valid());

        let valid_signal_buy = MarketEvent::Signal(Signal {
            id: "sig_buy".into(),
            time: 1_700_000_000,
            symbol: Some("BTCUSDT".into()),
            direction: crate::models::Direction::Buy,
            entry_price: 50000.0,
            stop_loss: 49000.0,
            take_profit: 52000.0,
            strategy: None,
            comment: None,
        });
        assert!(valid_signal_buy.is_valid());

        let valid_signal_hold = MarketEvent::Signal(Signal {
            id: "sig_hold".into(),
            time: 1_700_000_000,
            symbol: Some("BTCUSDT".into()),
            direction: crate::models::Direction::Hold,
            entry_price: 50000.0,
            stop_loss: 0.0,
            take_profit: 0.0,
            strategy: None,
            comment: None,
        });
        assert!(valid_signal_hold.is_valid());

        let invalid_signal_geom = MarketEvent::Signal(Signal {
            id: "sig_bad".into(),
            time: 1_700_000_000,
            symbol: Some("BTCUSDT".into()),
            direction: crate::models::Direction::Buy,
            entry_price: 50000.0,
            stop_loss: 51000.0,
            take_profit: 52000.0,
            strategy: None,
            comment: None,
        });
        assert!(!invalid_signal_geom.is_valid());
    }
}
