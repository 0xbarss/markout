//! Ingestion for strategy signals (.jsonl, .ndjson, .json, .csv, .sqlite).
//! Supports fields matching ts_core::Signal:
//! - direction: Buy, Sell, Hold
//! - entry_price: float
//! - stop_loss: float
//! - take_profit: float
//!
//! Includes timestamp/time, and optional symbol/strategy/comment.

use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

use rusqlite::Connection;
use serde::Deserialize;

use super::{extension, io_err, normalize_time, parse_enum, IngestError, Result};
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
    let mut seen = HashSet::new();
    for s in &signals {
        if !s.id.is_empty() && !seen.insert(s.id.clone()) {
            return Err(IngestError::InvalidSignal {
                id: s.id.clone(),
                reason: "duplicate signal id".into(),
            });
        }
    }
    for (i, s) in signals.iter_mut().enumerate() {
        s.time = normalize_time(s.time);
        if s.id.is_empty() {
            let mut n = i + 1;
            let mut candidate = format!("sig_{n}");
            while seen.contains(&candidate) {
                n += 1;
                candidate = format!("sig_{n}");
            }
            seen.insert(candidate.clone());
            s.id = candidate;
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
            serde_json::from_str(trimmed).map_err(|e| IngestError::InvalidSignal {
                id: format!("signal line {}", i + 1),
                reason: e.to_string(),
            })?;
        out.push(sig.into_signal());
    }
    finish_signals(out)
}

pub fn parse_json_array<R: Read>(reader: R) -> Result<Vec<Signal>> {
    let raw: Vec<SignalRaw> = serde_json::from_reader(reader)?;
    let signals = raw.into_iter().map(|r| r.into_signal()).collect();
    finish_signals(signals)
}

#[derive(Deserialize)]
struct SignalRaw {
    #[serde(default, deserialize_with = "crate::models::de_opt_id")]
    id: Option<String>,
    #[serde(alias = "timestamp", deserialize_with = "crate::models::de_time")]
    time: i64,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(alias = "action", alias = "side", alias = "signal")]
    direction: Direction,
    #[serde(alias = "price")]
    entry_price: f64,
    #[serde(default, alias = "sl", alias = "initial_sl")]
    stop_loss: Option<f64>,
    #[serde(default, alias = "tp")]
    take_profit: Option<f64>,
    #[serde(default, alias = "name")]
    strategy: Option<String>,
    #[serde(default, alias = "note")]
    comment: Option<String>,
}

impl SignalRaw {
    fn into_signal(self) -> Signal {
        Signal {
            id: self.id.unwrap_or_default(),
            time: self.time,
            symbol: self.symbol,
            direction: self.direction,
            entry_price: self.entry_price,
            stop_loss: self.stop_loss.unwrap_or(0.0),
            take_profit: self.take_profit.unwrap_or(0.0),
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
    for rec in rdr.deserialize() {
        let raw: SignalRaw = rec?;
        out.push(raw.into_signal());
    }
    finish_signals(out)
}

fn pick<'a>(cols: &HashSet<String>, names: &[&'a str]) -> Option<&'a str> {
    names.iter().copied().find(|n| cols.contains(*n))
}

const SIGNAL_TABLES: &[&str] = &["signals", "strategy_signals", "strategy"];

pub fn read_sqlite(conn: &Connection) -> Result<Vec<Signal>> {
    let table = SIGNAL_TABLES
        .iter()
        .copied()
        .find(|t| super::sqlite::has_table(conn, t).unwrap_or(false))
        .ok_or_else(|| IngestError::MissingTable("signals".into()))?;
    let cols = super::sqlite::columns(conn, table)?;

    let need = |names: &[&'static str], label: &'static str| {
        pick(&cols, names).ok_or(IngestError::MissingColumn {
            table,
            column: label,
        })
    };
    let time = need(&["time", "timestamp"], "time")?;
    let dir = need(&["direction", "action", "side", "signal"], "direction")?;
    let entry = need(&["entry_price", "price"], "entry_price")?;
    let sl = pick(&cols, &["stop_loss", "sl", "initial_sl"]);
    let tp = pick(&cols, &["take_profit", "tp"]);
    let strat = pick(&cols, &["strategy", "name"]);

    let id_expr = if cols.contains("id") {
        "CAST(id AS TEXT)"
    } else {
        "NULL"
    };
    let sym_expr = if cols.contains("symbol") {
        "symbol"
    } else {
        "NULL"
    };
    let sl_expr = sl
        .map(|c| format!("COALESCE({c}, 0.0)"))
        .unwrap_or_else(|| "0.0".to_string());
    let tp_expr = tp
        .map(|c| format!("COALESCE({c}, 0.0)"))
        .unwrap_or_else(|| "0.0".to_string());
    let strat_expr = strat.unwrap_or("NULL");
    let comment_expr = if cols.contains("comment") {
        "comment"
    } else {
        "NULL"
    };

    // Table and column names come from the static lists above, never from user input.
    let sql = format!(
        "SELECT {id_expr}, {time}, {sym_expr}, {dir}, {entry}, {sl_expr}, {tp_expr}, {strat_expr}, {comment_expr} FROM {table}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, f64>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
        ))
    })?;

    let mut out = Vec::new();
    for (row_idx, r) in rows.enumerate() {
        let (id_raw, time, symbol, dir_str, entry_price, stop_loss, take_profit, strategy, comment) =
            r?;
        let id = id_raw.unwrap_or_default();
        let signal_id = if id.is_empty() {
            format!("sig_{}", row_idx + 1)
        } else {
            id.clone()
        };

        let direction: Direction =
            parse_enum(&dir_str).map_err(|e| IngestError::InvalidSignal {
                id: signal_id,
                reason: format!("direction `{dir_str}`: {e}"),
            })?;

        out.push(Signal {
            id,
            time,
            symbol,
            direction,
            entry_price,
            stop_loss,
            take_profit,
            strategy,
            comment,
        });
    }
    finish_signals(out)
}

pub fn load_sqlite(path: &Path) -> Result<Vec<Signal>> {
    let conn = super::sqlite::open(path)?;
    read_sqlite(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_sqlite_file(sql: &str) -> tempfile::NamedTempFile {
        let tmp = tempfile::Builder::new()
            .suffix(".sqlite")
            .tempfile()
            .unwrap();
        let conn = Connection::open(tmp.path()).unwrap();
        conn.execute_batch(sql).unwrap();
        conn.close().unwrap();
        tmp
    }

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

    #[test]
    fn load_sqlite_canonical_columns() {
        let tmp = create_sqlite_file(
            r#"
            CREATE TABLE signals (
                id TEXT,
                time INTEGER,
                symbol TEXT,
                direction TEXT,
                entry_price REAL,
                stop_loss REAL,
                take_profit REAL,
                strategy TEXT,
                comment TEXT
            );
            INSERT INTO signals VALUES ('sig-canonical', 1700000000, 'BTCUSDT', 'buy', 65000.0, 64000.0, 66000.0, 'EMA Breakout', 'test note');
        "#,
        );
        let sigs = load_sqlite(tmp.path()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].id, "sig-canonical");
        assert_eq!(sigs[0].time, 1700000000);
        assert_eq!(sigs[0].symbol.as_deref(), Some("BTCUSDT"));
        assert_eq!(sigs[0].direction, Direction::Buy);
        assert_eq!(sigs[0].entry_price, 65000.0);
        assert_eq!(sigs[0].stop_loss, 64000.0);
        assert_eq!(sigs[0].take_profit, 66000.0);
        assert_eq!(sigs[0].strategy.as_deref(), Some("EMA Breakout"));
        assert_eq!(sigs[0].comment.as_deref(), Some("test note"));
    }

    #[test]
    fn load_sqlite_aliases_and_alternative_table() {
        let tmp = create_sqlite_file(
            r#"
            CREATE TABLE strategy_signals (
                timestamp INTEGER,
                action TEXT,
                price REAL,
                sl REAL,
                tp REAL,
                name TEXT
            );
            INSERT INTO strategy_signals VALUES (1700000000, 'short', 3500.0, 3600.0, 3400.0, 'RSI Div');
        "#,
        );
        let sigs = load_sqlite(tmp.path()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].id, "sig_1");
        assert_eq!(sigs[0].time, 1700000000);
        assert_eq!(sigs[0].direction, Direction::Sell);
        assert_eq!(sigs[0].entry_price, 3500.0);
        assert_eq!(sigs[0].stop_loss, 3600.0);
        assert_eq!(sigs[0].take_profit, 3400.0);
        assert_eq!(sigs[0].strategy.as_deref(), Some("RSI Div"));
    }

    #[test]
    fn load_sqlite_integer_id() {
        let tmp = create_sqlite_file(
            r#"
            CREATE TABLE signals (
                id INTEGER PRIMARY KEY,
                time INTEGER,
                direction TEXT,
                entry_price REAL
            );
            INSERT INTO signals VALUES (1042, 1700000000, 'buy', 100.0);
        "#,
        );
        let sigs = load_sqlite(tmp.path()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].id, "1042");
    }

    #[test]
    fn load_sqlite_missing_stop_loss_column() {
        let tmp = create_sqlite_file(
            r#"
            CREATE TABLE signals (
                time INTEGER,
                direction TEXT,
                entry_price REAL
            );
            INSERT INTO signals VALUES (1700000000, 'buy', 100.0);
        "#,
        );
        let sigs = load_sqlite(tmp.path()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].stop_loss, 0.0);
        assert_eq!(sigs[0].take_profit, 0.0);
    }

    #[test]
    fn load_sqlite_invalid_direction_reports_invalid_signal() {
        let tmp = create_sqlite_file(
            r#"
            CREATE TABLE signals (
                id TEXT,
                time INTEGER,
                direction TEXT,
                entry_price REAL
            );
            INSERT INTO signals VALUES ('sig-bad', 1700000000, 'banana', 100.0);
        "#,
        );
        match load_sqlite(tmp.path()) {
            Err(IngestError::InvalidSignal { id, reason }) => {
                assert_eq!(id, "sig-bad");
                assert!(reason.contains("direction `banana`"));
            }
            other => panic!("expected InvalidSignal, got {other:?}"),
        }
    }

    #[test]
    fn jsonl_numeric_id_and_null_sl() {
        let jsonl = r#"{"id": 5, "time": 1700000000, "direction": "buy", "entry_price": 100.0, "stop_loss": null}"#;
        let sigs = parse_jsonl(jsonl.as_bytes()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].id, "5");
        assert_eq!(sigs[0].stop_loss, 0.0);
    }

    #[test]
    fn csv_empty_take_profit() {
        let csv = "time,direction,entry_price,stop_loss,take_profit\n1700000000,buy,100.0,95.0,\n";
        let sigs = parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].take_profit, 0.0);
    }

    #[test]
    fn duplicate_signal_ids_rejected() {
        let jsonl = "{\"id\": \"sig_2\", \"time\": 1700000000, \"direction\": \"buy\", \"entry_price\": 100.0}\n\
                     {\"id\": \"sig_2\", \"time\": 1700000060, \"direction\": \"sell\", \"entry_price\": 105.0}\n";
        match parse_jsonl(jsonl.as_bytes()) {
            Err(IngestError::InvalidSignal { id, reason }) => {
                assert_eq!(id, "sig_2");
                assert!(reason.contains("duplicate signal id"));
            }
            other => panic!("expected duplicate signal id error, got {other:?}"),
        }
    }
}
