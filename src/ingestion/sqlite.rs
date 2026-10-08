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
    let mut stmt =
        conn.prepare("SELECT time, open, high, low, close, volume FROM bars ORDER BY time")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, f64>(5)?,
        ))
    })?;

    let mut bars = Vec::new();
    for (i, row) in rows.enumerate() {
        let (time, open, high, low, close, volume) = row?;
        let bar = Bar {
            time: normalize_time(time),
            open,
            high,
            low,
            close,
            volume,
        };
        validate_bar(&bar).map_err(|reason| IngestError::InvalidBar { row: i + 1, reason })?;
        bars.push(bar);
    }
    normalize_bars(bars)
}

struct RawTrade {
    id: i64,
    symbol: String,
    direction: String,
    size: f64,
    entry_time: i64,
    entry_price: f64,
    initial_sl: f64,
    pnl: f64,
    r_multiple: f64,
    exit_time: Option<i64>,
    exit_price: Option<f64>,
    exit_reason: Option<String>,
    take_profit: Option<f64>,
    sl_history: Option<String>,
    fee: Option<f64>,
    mae_pct: Option<f64>,
    mfe_pct: Option<f64>,
}

fn into_trade(r: RawTrade) -> Result<Trade> {
    let id = u64::try_from(r.id).map_err(|_| IngestError::InvalidTrade {
        id: r.id.to_string(),
        reason: "negative id".into(),
    })?;
    let bad = |reason: String| IngestError::InvalidTrade {
        id: id.to_string(),
        reason,
    };

    let direction: TradeSide =
        parse_enum(&r.direction).map_err(|e| bad(format!("direction `{}`: {e}", r.direction)))?;
    let exit_reason: Option<ExitReason> = r
        .exit_reason
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(parse_enum::<ExitReason>)
        .transpose()
        .map_err(|e| bad(format!("exit_reason: {e}")))?;
    let sl_history: Vec<StopPoint> = match r.sl_history.as_deref() {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).map_err(|e| bad(format!("sl_history: {e}")))?
        }
        _ => Vec::new(),
    };

    Ok(Trade {
        id,
        symbol: r.symbol,
        direction,
        size: r.size,
        entry_time: r.entry_time,
        entry_price: r.entry_price,
        exit_time: r.exit_time,
        exit_price: r.exit_price,
        exit_reason,
        initial_sl: r.initial_sl,
        take_profit: r.take_profit,
        sl_history,
        pnl: r.pnl,
        r_multiple: r.r_multiple,
        fee: r.fee.unwrap_or(0.0),
        mae_pct: r.mae_pct,
        mfe_pct: r.mfe_pct,
    })
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

    let mut stmt = conn.prepare(&format!("SELECT {select} FROM trades"))?;
    let rows = stmt.query_map([], |r| {
        Ok(RawTrade {
            id: r.get(0)?,
            symbol: r.get(1)?,
            direction: r.get(2)?,
            size: r.get(3)?,
            entry_time: r.get(4)?,
            entry_price: r.get(5)?,
            initial_sl: r.get(6)?,
            pnl: r.get(7)?,
            r_multiple: r.get(8)?,
            exit_time: r.get(9)?,
            exit_price: r.get(10)?,
            exit_reason: r.get(11)?,
            take_profit: r.get(12)?,
            sl_history: r.get(13)?,
            fee: r.get(14)?,
            mae_pct: r.get(15)?,
            mfe_pct: r.get(16)?,
        })
    })?;

    let mut trades = Vec::new();
    for row in rows {
        trades.push(into_trade(row?)?);
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
}
