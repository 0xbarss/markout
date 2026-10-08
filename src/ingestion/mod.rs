//! Data ingestion: OHLCV bar loaders, trade database reader and generic trade logs.
//!
//! All loaders normalize timestamps to Unix SECONDS, validate every record,
//! and return data sorted ascending (bars by time, trades by entry time).

use std::path::Path;

use crate::models::{Bar, Signal, StopPoint, Trade};

pub mod json;
pub mod ohlcv;
pub mod parquet;
pub mod signal;
pub mod sqlite;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("cannot read {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("parquet error: {0}")]
    Parquet(#[from] ::parquet::errors::ParquetError),
    #[error("arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("table `{0}` not found")]
    MissingTable(String),
    #[error("missing column `{column}` in table `{table}`")]
    MissingColumn {
        table: &'static str,
        column: &'static str,
    },
    #[error("invalid bar at row {row}: {reason}")]
    InvalidBar { row: usize, reason: String },
    #[error("duplicate bar timestamp {0}")]
    DuplicateBar(i64),
    #[error("invalid trade {id}: {reason}")]
    InvalidTrade { id: String, reason: String },
    #[error("invalid signal {id}: {reason}")]
    InvalidSignal { id: String, reason: String },
}

pub type Result<T> = std::result::Result<T, IngestError>;

pub(crate) fn io_err(path: &Path, source: std::io::Error) -> IngestError {
    IngestError::Io {
        path: path.display().to_string(),
        source,
    }
}

pub(crate) fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Timestamps at or above this magnitude are assumed to be milliseconds/microseconds/nanoseconds.
const MILLIS_THRESHOLD: i64 = 100_000_000_000;
const MICROS_THRESHOLD: i64 = 100_000_000_000_000;
const NANOS_THRESHOLD: i64 = 100_000_000_000_000_000;

/// Convert a possibly millisecond, microsecond, or nanosecond Unix timestamp to seconds.
pub fn normalize_time(t: i64) -> i64 {
    if t.abs() >= NANOS_THRESHOLD {
        t / 1_000_000_000
    } else if t.abs() >= MICROS_THRESHOLD {
        t / 1_000_000
    } else if t.abs() >= MILLIS_THRESHOLD {
        t / 1000
    } else {
        t
    }
}

pub fn is_parquet_format(path: &Path) -> bool {
    extension(path) == "parquet"
}

pub(crate) fn parse_enum<T: serde::de::DeserializeOwned>(
    s: &str,
) -> std::result::Result<T, String> {
    serde_json::from_value(serde_json::Value::String(s.trim().to_ascii_lowercase()))
        .map_err(|e| e.to_string())
}

pub fn validate_bar(b: &Bar) -> std::result::Result<(), String> {
    if ![b.open, b.high, b.low, b.close, b.volume]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err("non-finite value".into());
    }
    if b.time <= 0 {
        return Err("timestamp must be positive".into());
    }
    if b.volume < 0.0 {
        return Err("negative volume".into());
    }
    if b.low > b.high {
        return Err("low is above high".into());
    }
    if b.high < b.open.max(b.close) || b.low > b.open.min(b.close) {
        return Err("open/close outside the high-low range".into());
    }
    Ok(())
}

/// Sort ascending by time and reject duplicate timestamps.
pub fn normalize_bars(mut bars: Vec<Bar>) -> Result<Vec<Bar>> {
    bars.sort_by_key(|b| b.time);
    if let Some(w) = bars.windows(2).find(|w| w[0].time == w[1].time) {
        return Err(IngestError::DuplicateBar(w[0].time));
    }
    Ok(bars)
}

fn normalize_trade(t: &mut Trade) {
    t.entry_time = normalize_time(t.entry_time);
    t.exit_time = t.exit_time.map(normalize_time);
    for p in &mut t.sl_history {
        p.time = normalize_time(p.time);
    }
    t.sl_history.sort_by_key(|p: &StopPoint| p.time);
}

pub fn validate_trade(t: &Trade) -> std::result::Result<(), String> {
    let finite = [
        t.size,
        t.entry_price,
        t.initial_sl,
        t.pnl,
        t.r_multiple,
        t.fee,
    ]
    .iter()
    .all(|v| v.is_finite());
    if !finite {
        return Err("non-finite value".into());
    }
    if t.size <= 0.0 {
        return Err("size must be positive".into());
    }
    if t.entry_price <= 0.0 {
        return Err("entry price must be positive".into());
    }
    if let Some(exit) = t.exit_time {
        if exit < t.entry_time {
            return Err("exit time precedes entry time".into());
        }
    }
    if t.sl_history.iter().any(|p| !p.price.is_finite()) {
        return Err("non-finite stop price".into());
    }
    Ok(())
}

/// Normalize, validate and sort trades by (entry_time, id).
pub fn finish_trades(mut trades: Vec<Trade>) -> Result<Vec<Trade>> {
    for t in &mut trades {
        normalize_trade(t);
        if let Err(reason) = validate_trade(t) {
            return Err(IngestError::InvalidTrade {
                id: t.id.to_string(),
                reason,
            });
        }
    }
    trades.sort_by_key(|t| (t.entry_time, t.id));
    Ok(trades)
}

/// Everything loaded for an offline session.
#[derive(Debug, Default, Clone)]
pub struct Dataset {
    pub bars: Vec<Bar>,
    pub trades: Vec<Trade>,
    pub signals: Vec<Signal>,
}

impl Dataset {
    /// Load trades from `trades` path, bars from `bars` path, and signals from `strategy` path.
    pub fn load(
        trades: Option<&Path>,
        bars: Option<&Path>,
        strategy: Option<&Path>,
    ) -> Result<Self> {
        let mut ds = Dataset::default();
        if let Some(p) = trades {
            ds.trades = load_trades(p)?;
        }
        if let Some(p) = strategy {
            ds.signals = signal::load(p)?;
        }
        match (bars, trades) {
            (Some(p), _) => ds.bars = ohlcv::load(p)?,
            (None, Some(p)) if !json::is_text_format(p) && !is_parquet_format(p) => {
                ds.bars = sqlite::load_bars_if_present(p)?
            }
            _ => {}
        }
        if bars.is_none() && trades.is_none() && strategy.is_none() {
            tracing::info!("no input files given; loading bundled demo data");
            ds.bars = ohlcv::parse_csv(include_str!("../../examples/bars.csv").as_bytes())?;
            ds.trades = json::parse_jsonl(include_str!("../../examples/trades.jsonl").as_bytes())?;
        }
        Ok(ds)
    }
}

pub fn load_trades(path: &Path) -> Result<Vec<Trade>> {
    if is_parquet_format(path) {
        parquet::load_trades(path)
    } else if json::is_text_format(path) {
        json::load_trades(path)
    } else {
        sqlite::load_trades(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn dataset_load_defaults_to_bundled_demo_when_no_inputs() {
        let ds = Dataset::load(None, None, None).expect("bundled data must load cleanly");
        assert!(!ds.bars.is_empty());
        assert!(!ds.trades.is_empty());
        assert!(ds.signals.is_empty());
    }

    #[test]
    fn dataset_load_with_strategy_only_leaves_bars_and_trades_empty() {
        let mut tmp = tempfile::Builder::new()
            .suffix(".jsonl")
            .tempfile()
            .unwrap();
        writeln!(
            tmp,
            r#"{{"id":"sig-001","time":1700000000,"direction":"buy","entry_price":100.0}}"#
        )
        .unwrap();

        let ds = Dataset::load(None, None, Some(tmp.path())).expect("signals must load");
        assert_eq!(ds.signals.len(), 1);
        assert!(ds.bars.is_empty());
        assert!(ds.trades.is_empty());
    }
}
