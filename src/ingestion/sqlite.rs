//! SQLite reader (opened read-only).
//!
//! `bars (time, open, high, low, close, volume)`
//!
//! `trades` requires: id, symbol, direction, size, entry_time, entry_price, initial_sl, pnl,
//! r_multiple. Optional (missing columns read as NULL): exit_time, exit_price, exit_reason,
//! take_profit, sl_history, fee, mae_pct, mfe_pct. `sl_history` is a JSON text column holding
//! `[{"time":..,"price":..}]`. Direction accepts buy/sell/long/short (case-insensitive).

use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, OpenFlags};

use super::{
    finish_trades, normalize_bars, normalize_time, parse_enum, validate_bar, IngestError, Result,
};
use crate::models::{Bar, ExitReason, StopPoint, Trade, TradeSide};

const REQUIRED: &[&str] = &[
    "id",
    "symbol",
    "direction",
    "size",
    "entry_time",
    "entry_price",
    "initial_sl",
    "pnl",
    "r_multiple",
];
const OPTIONAL: &[&str] = &[
    "exit_time",
    "exit_price",
    "exit_reason",
    "take_profit",
    "sl_history",
    "fee",
    "mae_pct",
    "mfe_pct",
];

pub fn open(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

pub(crate) fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let cols = stmt
        .query_map([table], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    Ok(cols)
}

pub fn has_table(conn: &Connection, table: &str) -> Result<bool> {
    Ok(!columns(conn, table)?.is_empty())
}

fn time_from_value(v: rusqlite::types::ValueRef<'_>) -> Option<i64> {
    use rusqlite::types::ValueRef::*;
    match v {
        Integer(i) => Some(normalize_time(i)),
        Real(f) if f.is_finite() => Some(normalize_time(f as i64)),
        Text(t) => {
            let s = std::str::from_utf8(t).ok()?;
            crate::models::parse_time_str(s)
        }
        _ => None,
    }
}

pub fn read_bars(conn: &Connection) -> Result<Vec<Bar>> {
    let cols = columns(conn, "bars")?;
    if cols.is_empty() {
        return Err(IngestError::MissingTable("bars".into()));
    }
    for c in ["time", "open", "high", "low", "close", "volume"] {
        if !cols.contains(c) {
            return Err(IngestError::MissingColumn {
                table: "bars",
                column: c,
            });
        }
    }
    let mut stmt = conn.prepare("SELECT time, open, high, low, close, volume FROM bars")?;
    let mut rows = stmt.query([])?;
    let mut bars = Vec::new();
    let mut row_idx = 0;
    while let Some(r) = rows.next()? {
        row_idx += 1;
        let time = time_from_value(r.get_ref(0)?).ok_or_else(|| IngestError::InvalidBar {
            row: row_idx,
            reason: "invalid or missing timestamp".into(),
        })?;
        let open: f64 = r.get(1).map_err(|e| IngestError::InvalidBar {
            row: row_idx,
            reason: e.to_string(),
        })?;
        let high: f64 = r.get(2).map_err(|e| IngestError::InvalidBar {
            row: row_idx,
            reason: e.to_string(),
        })?;
        let low: f64 = r.get(3).map_err(|e| IngestError::InvalidBar {
            row: row_idx,
            reason: e.to_string(),
        })?;
        let close: f64 = r.get(4).map_err(|e| IngestError::InvalidBar {
            row: row_idx,
            reason: e.to_string(),
        })?;
        let volume: f64 = r.get(5).map_err(|e| IngestError::InvalidBar {
            row: row_idx,
            reason: e.to_string(),
        })?;

        let bar = Bar {
            time,
            open,
            high,
            low,
            close,
            volume,
        };
        validate_bar(&bar).map_err(|reason| IngestError::InvalidBar {
            row: row_idx,
            reason,
        })?;
        bars.push(bar);
    }
    normalize_bars(bars)
}

pub fn read_trades(conn: &Connection) -> Result<Vec<Trade>> {
    let cols = columns(conn, "trades")?;
    if cols.is_empty() {
        return Err(IngestError::MissingTable("trades".into()));
    }
    for c in REQUIRED {
        if !cols.contains(*c) {
            return Err(IngestError::MissingColumn {
                table: "trades",
                column: c,
            });
        }
    }
    // Column names come from the static lists above, never from user input.
    let select = REQUIRED
        .iter()
        .map(|c| c.to_string())
        .chain(OPTIONAL.iter().map(|c| {
            if cols.contains(*c) {
                c.to_string()
            } else {
                format!("NULL AS {c}")
            }
        }))
        .collect::<Vec<_>>()
        .join(", ");

    let mut stmt = conn.prepare(&format!("SELECT rowid, {select} FROM trades"))?;
    let mut rows = stmt.query([])?;
    let mut trades = Vec::new();
    let mut fallback_row = 0;

    while let Some(r) = rows.next()? {
        fallback_row += 1;
        let rowid: i64 = r.get::<_, i64>(0).unwrap_or(fallback_row);

        let id_val = r.get_ref(1)?;
        let trade_id_str = match id_val {
            rusqlite::types::ValueRef::Integer(i) => i.to_string(),
            rusqlite::types::ValueRef::Real(f) => f.to_string(),
            rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
            _ => rowid.to_string(),
        };

        let id_raw: i64 = match id_val {
            rusqlite::types::ValueRef::Integer(i) => i,
            rusqlite::types::ValueRef::Real(f) if f.is_finite() && f >= 0.0 && f.fract() == 0.0 => {
                f as i64
            }
            rusqlite::types::ValueRef::Text(t) => {
                let s = std::str::from_utf8(t).map_err(|_| IngestError::InvalidTrade {
                    id: trade_id_str.clone(),
                    reason: "column `id`: invalid utf8".into(),
                })?;
                s.parse::<i64>().map_err(|_| IngestError::InvalidTrade {
                    id: trade_id_str.clone(),
                    reason: format!("column `id`: invalid integer `{s}`"),
                })?
            }
            rusqlite::types::ValueRef::Null => {
                return Err(IngestError::InvalidTrade {
                    id: rowid.to_string(),
                    reason: "column `id`: NULL".into(),
                });
            }
            _ => {
                return Err(IngestError::InvalidTrade {
                    id: trade_id_str.clone(),
                    reason: "column `id`: invalid type".into(),
                });
            }
        };

        let id = u64::try_from(id_raw).map_err(|_| IngestError::InvalidTrade {
            id: trade_id_str.clone(),
            reason: "negative id".into(),
        })?;

        let symbol: String = r.get(2).map_err(|e| {
            let is_null = r
                .get_ref(2)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `symbol`: NULL".to_string()
            } else {
                format!("column `symbol`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let direction_str: String = r.get(3).map_err(|e| {
            let is_null = r
                .get_ref(3)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `direction`: NULL".to_string()
            } else {
                format!("column `direction`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let size: f64 = r.get(4).map_err(|e| {
            let is_null = r
                .get_ref(4)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `size`: NULL".to_string()
            } else {
                format!("column `size`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let entry_time = time_from_value(r.get_ref(5)?).ok_or_else(|| {
            let is_null = r
                .get_ref(5)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `entry_time`: NULL".to_string()
            } else {
                "column `entry_time`: invalid time".to_string()
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let entry_price: f64 = r.get(6).map_err(|e| {
            let is_null = r
                .get_ref(6)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `entry_price`: NULL".to_string()
            } else {
                format!("column `entry_price`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let initial_sl: f64 = r.get(7).map_err(|e| {
            let is_null = r
                .get_ref(7)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `initial_sl`: NULL".to_string()
            } else {
                format!("column `initial_sl`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let pnl: f64 = r.get(8).map_err(|e| {
            let is_null = r
                .get_ref(8)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `pnl`: NULL".to_string()
            } else {
                format!("column `pnl`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let r_multiple: f64 = r.get(9).map_err(|e| {
            let is_null = r
                .get_ref(9)
                .map(|v| matches!(v, rusqlite::types::ValueRef::Null))
                .unwrap_or(false);
            let reason = if is_null {
                "column `r_multiple`: NULL".to_string()
            } else {
                format!("column `r_multiple`: {e}")
            };
            IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason,
            }
        })?;

        let exit_time_ref = r.get_ref(10)?;
        let exit_time = match exit_time_ref {
            rusqlite::types::ValueRef::Null => None,
            v => Some(time_from_value(v).ok_or_else(|| IngestError::InvalidTrade {
                id: trade_id_str.clone(),
                reason: "column `exit_time`: invalid time".into(),
            })?),
        };

        let exit_price: Option<f64> = r.get(11).unwrap_or(None);
        let exit_reason_str: Option<String> = r.get(12).unwrap_or(None);
        let take_profit: Option<f64> = r.get(13).unwrap_or(None);
        let sl_history_str: Option<String> = r.get(14).unwrap_or(None);
        let fee: Option<f64> = r.get(15).unwrap_or(None);
        let mae_pct: Option<f64> = r.get(16).unwrap_or(None);
        let mfe_pct: Option<f64> = r.get(17).unwrap_or(None);

        let bad = |reason: String| IngestError::InvalidTrade {
            id: trade_id_str.clone(),
            reason,
        };
        let direction: TradeSide = parse_enum(&direction_str)
            .map_err(|e| bad(format!("direction `{direction_str}`: {e}")))?;
        let exit_reason: Option<ExitReason> = exit_reason_str
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(parse_enum::<ExitReason>)
            .transpose()
            .map_err(|e| bad(format!("exit_reason: {e}")))?;
        let sl_history: Vec<StopPoint> = match sl_history_str.as_deref() {
            Some(s) if !s.trim().is_empty() => {
                serde_json::from_str(s).map_err(|e| bad(format!("sl_history: {e}")))?
            }
            _ => Vec::new(),
        };

        trades.push(Trade {
            id,
            symbol,
            direction,
            size,
            entry_time,
            entry_price,
            exit_time,
            exit_price,
            exit_reason,
            initial_sl,
            take_profit,
            sl_history,
            pnl,
            r_multiple,
            fee: fee.unwrap_or(0.0),
            mae_pct,
            mfe_pct,
        });
    }
    finish_trades(trades)
}

pub fn load_trades(path: &Path) -> Result<Vec<Trade>> {
    read_trades(&open(path)?)
}

pub fn load_bars(path: &Path) -> Result<Vec<Bar>> {
    read_bars(&open(path)?)
}

/// Bars from the database if it has a `bars` table, otherwise empty.
pub fn load_bars_if_present(path: &Path) -> Result<Vec<Bar>> {
    let conn = open(path)?;
    if has_table(&conn, "bars")? {
        read_bars(&conn)
    } else {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(schema_and_rows: &str) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(schema_and_rows).unwrap();
        c
    }

    const FULL_TRADES: &str = r#"
        CREATE TABLE trades (id INTEGER PRIMARY KEY, symbol TEXT, direction TEXT, size REAL,
          entry_time INTEGER, entry_price REAL, exit_time INTEGER, exit_price REAL, exit_reason TEXT,
          initial_sl REAL, take_profit REAL, sl_history TEXT, pnl REAL, r_multiple REAL, fee REAL);
        INSERT INTO trades VALUES (2,'ETHUSDT','Short',2,1700001000,3420,1700002000,3460,'initial_stop',3460,NULL,NULL,-80,-1,0.5);
        INSERT INTO trades VALUES (1,'BTCUSDT','buy',0.5,1700000000,63500,1700008100,64800,'trailing_stop',63000,65000,
          '[{"time":1700003600,"price":63500.0},{"time":1700001800,"price":63200.0}]',650,2.15,1.2);
    "#;

    #[test]
    fn reads_trades_sorted_with_stop_path() {
        let trades = read_trades(&db(FULL_TRADES)).unwrap();
        assert_eq!(trades.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 2]);
        let t = &trades[0];
        assert_eq!(t.direction, TradeSide::Buy);
        assert_eq!(t.exit_reason, Some(ExitReason::TrailingStop));
        assert_eq!(t.fee, 1.2);
        // stop path sorted by time
        assert_eq!(t.sl_history[0].time, 1_700_001_800);
        assert_eq!(trades[1].direction, TradeSide::Sell);
        assert_eq!(trades[1].take_profit, None);
    }

    #[test]
    fn missing_optional_columns_are_tolerated() {
        let c = db(r#"
            CREATE TABLE trades (id INTEGER, symbol TEXT, direction TEXT, size REAL, entry_time INTEGER,
              entry_price REAL, initial_sl REAL, pnl REAL, r_multiple REAL);
            INSERT INTO trades VALUES (1,'BTCUSDT','long',1,1700000000,100,95,0,0);
        "#);
        let t = &read_trades(&c).unwrap()[0];
        assert_eq!(t.exit_time, None);
        assert_eq!(t.fee, 0.0);
        assert!(t.sl_history.is_empty());
    }

    #[test]
    fn missing_required_column_is_an_error() {
        let c = db("CREATE TABLE trades (id INTEGER, symbol TEXT);");
        assert!(matches!(
            read_trades(&c),
            Err(IngestError::MissingColumn {
                table: "trades",
                ..
            })
        ));
    }

    #[test]
    fn missing_table_is_an_error() {
        let c = db("CREATE TABLE other (x INTEGER);");
        assert!(matches!(read_trades(&c), Err(IngestError::MissingTable(_))));
        assert!(!has_table(&c, "bars").unwrap());
    }

    #[test]
    fn bad_direction_is_reported_with_trade_id() {
        let c = db(r#"
            CREATE TABLE trades (id INTEGER, symbol TEXT, direction TEXT, size REAL, entry_time INTEGER,
              entry_price REAL, initial_sl REAL, pnl REAL, r_multiple REAL);
            INSERT INTO trades VALUES (9,'X','sideways',1,1700000000,100,95,0,0);
        "#);
        match read_trades(&c) {
            Err(IngestError::InvalidTrade { id, .. }) => assert_eq!(id, "9"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn reads_and_validates_bars() {
        let ok = db(r#"
            CREATE TABLE bars (time INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL);
            INSERT INTO bars VALUES (1700000060,1,2,0.5,1.5,10), (1700000000,1,2,0.5,1.5,10);
        "#);
        let bars = read_bars(&ok).unwrap();
        assert_eq!(bars[0].time, 1_700_000_000);

        let bad = db(r#"
            CREATE TABLE bars (time INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL);
            INSERT INTO bars VALUES (1700000000,1,0.5,2,1.5,10);
        "#);
        assert!(matches!(
            read_bars(&bad),
            Err(IngestError::InvalidBar { row: 1, .. })
        ));
    }

    #[test]
    fn sqlite_real_and_text_entry_time() {
        let c = db(r#"
            CREATE TABLE trades (id INTEGER, symbol TEXT, direction TEXT, size REAL, entry_time REAL,
              entry_price REAL, initial_sl REAL, pnl REAL, r_multiple REAL);
            INSERT INTO trades VALUES (1,'BTCUSDT','long',1,1700000000.5,100,95,0,0);
        "#);
        let t = &read_trades(&c).unwrap()[0];
        assert_eq!(t.entry_time, 1_700_000_000);

        let c2 = db(r#"
            CREATE TABLE trades (id INTEGER, symbol TEXT, direction TEXT, size REAL, entry_time TEXT,
              entry_price REAL, initial_sl REAL, pnl REAL, r_multiple REAL);
            INSERT INTO trades VALUES (2,'BTCUSDT','long',1,'2024-01-01T00:00:00Z',100,95,0,0);
        "#);
        let t2 = &read_trades(&c2).unwrap()[0];
        assert_eq!(t2.entry_time, 1_704_067_200);
    }

    #[test]
    fn sqlite_null_symbol_reports_invalid_trade() {
        let c = db(r#"
            CREATE TABLE trades (id INTEGER, symbol TEXT, direction TEXT, size REAL, entry_time INTEGER,
              entry_price REAL, initial_sl REAL, pnl REAL, r_multiple REAL);
            INSERT INTO trades VALUES (42, NULL, 'long', 1, 1700000000, 100, 95, 0, 0);
        "#);
        match read_trades(&c) {
            Err(IngestError::InvalidTrade { id, reason }) => {
                assert_eq!(id, "42");
                assert_eq!(reason, "column `symbol`: NULL");
            }
            other => panic!("expected InvalidTrade for null symbol, got {other:?}"),
        }
    }
}
