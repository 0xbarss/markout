use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::models::{AccountSnapshot, Bar, Tick, TradeUpdate};

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
}
