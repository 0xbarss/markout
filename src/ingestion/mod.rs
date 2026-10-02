//! Data ingestion: OHLCV bar loaders, trade database reader and generic trade logs.
//!
//! All loaders normalize timestamps to Unix SECONDS, validate every record,
//! and return data sorted ascending (bars by time, trades by entry time).

use std::path::Path;

use crate::models::{Bar, StopPoint, Trade};

pub mod json;
pub mod ohlcv;
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

/// Timestamps at or above this magnitude are assumed to be milliseconds.
const MILLIS_THRESHOLD: i64 = 100_000_000_000;

/// Convert a possibly-millisecond Unix timestamp to seconds.
pub fn normalize_time(t: i64) -> i64 {
    if t.abs() >= MILLIS_THRESHOLD {
        t / 1000
    } else {
        t
    }
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
}

impl Dataset {
    /// Load trades from `db` (SQLite, `.jsonl`/`.ndjson`, `.json` or `.csv`) and bars
    /// from `bars` (CSV file, directory of CSVs, or SQLite). With a SQLite `db` and no
    /// `bars` path, a `bars` table inside the database is used when present.
    pub fn load(db: Option<&Path>, bars: Option<&Path>) -> Result<Self> {
        let mut ds = Dataset::default();
        if let Some(p) = db {
            ds.trades = load_trades(p)?;
        }
        match (bars, db) {
            (Some(p), _) => ds.bars = ohlcv::load(p)?,
            (None, Some(p)) if !json::is_text_format(p) => {
                ds.bars = sqlite::load_bars_if_present(p)?
            }
            _ => {}
        }
        if ds.bars.is_empty() && bars.is_none() && db.is_none() {
            let default_bars = Path::new("examples/bars.csv");
            let default_trades = Path::new("examples/trades.jsonl");
            if default_bars.exists() {
                ds.bars = ohlcv::load(default_bars).unwrap_or_default();
            } else {
                ds.bars = ohlcv::parse_csv(include_str!("../../examples/bars.csv").as_bytes())
                    .unwrap_or_default();
            }
            if ds.trades.is_empty() {
                if default_trades.exists() {
                    ds.trades = load_trades(default_trades).unwrap_or_default();
                } else {
                    ds.trades =
                        json::parse_jsonl(include_str!("../../examples/trades.jsonl").as_bytes())
                            .unwrap_or_default();
                }
            }
        }
        Ok(ds)
    }
}

pub fn load_trades(path: &Path) -> Result<Vec<Trade>> {
    if json::is_text_format(path) {
        json::load_trades(path)
    } else {
        sqlite::load_trades(path)
    }
}
