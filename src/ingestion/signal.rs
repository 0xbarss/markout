//! Ingestion for strategy signals (.jsonl, .ndjson, .json, .csv, .sqlite).
//! Supports fields matching ts_core::Signal:
//! - direction: Buy, Sell, Hold
//! - entry_price: float
//! - stop_loss: float
//! - take_profit: float
//!
//! Includes timestamp/time, and optional symbol/strategy/comment.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

use rusqlite::Connection;
use serde::Deserialize;

use super::{extension, io_err, normalize_time, IngestError, Result};
use crate::models::{Direction, Signal};

pub fn load(path: &Path) -> Result<Vec<Signal>> {
    let ext = extension(path);
    match ext.as_str() {
        "jsonl" | "ndjson" => {
            let f = File::open(path).map_err(|e| io_err(path, e))?;
            parse_jsonl(BufReader::new(f))
        }
        "json" => {
            let f = File::open(path).map_err(|e| io_err(path, e))?;
            parse_json_array(BufReader::new(f))
        }
        "csv" => {
            let f = File::open(path).map_err(|e| io_err(path, e))?;
            parse_csv(BufReader::new(f))
        }
        "sqlite" | "sqlite3" | "db" => load_sqlite(path),
        _ => Err(IngestError::Io {
            path: path.display().to_string(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsupported signals file extension `.{ext}`"),
            ),
        }),
    }
}

pub fn finish_signals(mut signals: Vec<Signal>) -> Result<Vec<Signal>> {
    for (i, s) in signals.iter_mut().enumerate() {
        s.time = normalize_time(s.time);
        if s.id.is_empty() {
            s.id = format!("sig_{}", i + 1);
        }
    }
    signals.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id.cmp(&b.id)));
    Ok(signals)
}

pub fn parse_jsonl<R: BufRead>(reader: R) -> Result<Vec<Signal>> {
    let mut out = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| io_err(Path::new("<stream>"), e))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let sig: SignalRaw =
            serde_json::from_str(trimmed).map_err(|e| IngestError::InvalidTrade {
                id: format!("signal line {}", i + 1),
                reason: e.to_string(),
            })?;
        out.push(sig.into_signal(i + 1));
    }
    finish_signals(out)
}

pub fn parse_json_array<R: Read>(reader: R) -> Result<Vec<Signal>> {
    let raw: Vec<SignalRaw> = serde_json::from_reader(reader)?;
    let signals = raw
        .into_iter()
        .enumerate()
        .map(|(i, r)| r.into_signal(i + 1))
        .collect();
    finish_signals(signals)
}

#[derive(Deserialize)]
struct SignalRaw {
    #[serde(default)]
    id: Option<String>,
    #[serde(alias = "timestamp")]
    time: i64,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(alias = "action", alias = "side", alias = "signal")]
    direction: Direction,
    #[serde(alias = "price")]
    entry_price: f64,
    #[serde(default, alias = "sl", alias = "initial_sl")]
    stop_loss: f64,
    #[serde(default, alias = "tp")]
    take_profit: f64,
    #[serde(default, alias = "name")]
    strategy: Option<String>,
    #[serde(default, alias = "note")]
    comment: Option<String>,
}

impl SignalRaw {
    fn into_signal(self, idx: usize) -> Signal {
        Signal {
            id: self.id.unwrap_or_else(|| format!("sig_{idx}")),
            time: self.time,
            symbol: self.symbol,
            direction: self.direction,
            entry_price: self.entry_price,
            stop_loss: self.stop_loss,
            take_profit: self.take_profit,
            strategy: self.strategy,
            comment: self.comment,
        }
    }
}

pub fn parse_csv<R: Read>(reader: R) -> Result<Vec<Signal>> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(reader);

    let mut out = Vec::new();
    for (i, rec) in rdr.deserialize().enumerate() {
        let raw: SignalRaw = rec?;
        out.push(raw.into_signal(i + 1));
    }
    finish_signals(out)
}

pub fn load_sqlite(path: &Path) -> Result<Vec<Signal>> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let table = ["signals", "strategy_signals", "strategy"]
        .iter()
        .copied()
        .find(|t| table_exists(&conn, t))
        .ok_or_else(|| IngestError::MissingTable("signals".into()))?;

    let mut stmt = conn.prepare(&format!(
        "SELECT id, COALESCE(time, timestamp, 0), symbol, COALESCE(direction, action, signal, 'buy'), COALESCE(entry_price, price, 0.0), COALESCE(stop_loss, sl, 0.0), COALESCE(take_profit, tp, 0.0), COALESCE(strategy, name, ''), comment FROM {table}"
    ))?;

    let rows = stmt.query_map([], |row| {
        let id_raw: Option<String> = row.get(0).ok();
        let time: i64 = row.get(1)?;
        let symbol: Option<String> = row.get(2).ok();
        let dir_str: String = row.get(3)?;
        let entry_price: f64 = row.get(4)?;
        let stop_loss: f64 = row.get(5)?;
        let take_profit: f64 = row.get(6)?;
        let strategy: Option<String> = row.get(7).ok();
        let comment: Option<String> = row.get(8).ok();

        let direction: Direction =
            serde_json::from_value(serde_json::Value::String(dir_str)).unwrap_or(Direction::Buy);

        Ok(Signal {
            id: id_raw.unwrap_or_default(),
            time,
            symbol,
            direction,
            entry_price,
            stop_loss,
            take_profit,
            strategy,
            comment,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    finish_signals(out)
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_jsonl_signals_matching_ts_core() {
        let data = r#"
{"time": 1700000000, "direction": "buy", "entry_price": 42000.0, "stop_loss": 41500.0, "take_profit": 43500.0, "strategy": "Cayenne"}
{"time": 1700003600, "direction": "sell", "entry_price": 43500.0, "stop_loss": 44000.0, "take_profit": 42500.0, "strategy": "Eclipse"}
"#;
        let sigs = parse_jsonl(data.as_bytes()).unwrap();
        assert_eq!(sigs.len(), 2);
        assert_eq!(sigs[0].direction, Direction::Buy);
        assert_eq!(sigs[0].entry_price, 42000.0);
        assert_eq!(sigs[0].stop_loss, 41500.0);
        assert_eq!(sigs[0].take_profit, 43500.0);
        assert_eq!(sigs[0].strategy.as_deref(), Some("Cayenne"));
        assert!(sigs[0].is_valid());

        assert_eq!(sigs[1].direction, Direction::Sell);
        assert_eq!(sigs[1].entry_price, 43500.0);
        assert_eq!(sigs[1].stop_loss, 44000.0);
        assert_eq!(sigs[1].take_profit, 42500.0);
        assert_eq!(sigs[1].strategy.as_deref(), Some("Eclipse"));
        assert!(sigs[1].is_valid());
    }

    #[test]
    fn parse_csv_signals_matching_ts_core() {
        let csv_data = "time,direction,entry_price,stop_loss,take_profit,strategy\n1700000000,buy,40000.0,39000.0,42000.0,Mustang\n";
        let sigs = parse_csv(csv_data.as_bytes()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].direction, Direction::Buy);
        assert_eq!(sigs[0].entry_price, 40000.0);
        assert_eq!(sigs[0].stop_loss, 39000.0);
        assert_eq!(sigs[0].take_profit, 42000.0);
        assert_eq!(sigs[0].strategy.as_deref(), Some("Mustang"));
        assert!(sigs[0].is_valid());
    }
}
