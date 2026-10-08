//! Generic trade logs: `.jsonl`/`.ndjson` (one trade per line), `.json` (array), `.csv`.
//!
//! CSV columns match the `Trade` fields; `sl_history` is an optional JSON-encoded cell,
//! e.g. `[{"time":1700003600,"price":63500.0}]`. Empty cells mean "not set".

use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

use serde::Deserialize;

use super::{extension, finish_trades, io_err, IngestError, Result};
use crate::models::{ExitReason, StopPoint, Trade, TradeSide};

pub fn is_text_format(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "jsonl" | "ndjson" | "json" | "csv"
    )
}

pub fn parse_jsonl<R: BufRead>(reader: R) -> Result<Vec<Trade>> {
    let mut trades = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| io_err(Path::new("<stream>"), e))?;
        if line.trim().is_empty() {
            continue;
        }
        let trade: Trade = serde_json::from_str(&line).map_err(|e| IngestError::InvalidTrade {
            id: format!("line {}", i + 1),
            reason: e.to_string(),
        })?;
        trades.push(trade);
    }
    finish_trades(trades)
}

pub fn parse_json_array<R: Read>(reader: R) -> Result<Vec<Trade>> {
    finish_trades(serde_json::from_reader(reader)?)
}

#[derive(Deserialize)]
struct TradeRow {
    id: u64,
    symbol: String,
    direction: TradeSide,
    size: f64,
    #[serde(deserialize_with = "crate::models::de_time")]
    entry_time: i64,
    entry_price: f64,
    #[serde(default, deserialize_with = "crate::models::de_opt_time")]
    exit_time: Option<i64>,
    #[serde(default)]
    exit_price: Option<f64>,
    #[serde(default)]
    exit_reason: Option<ExitReason>,
    initial_sl: f64,
    #[serde(default)]
    take_profit: Option<f64>,
    #[serde(default)]
    sl_history: Option<String>,
    pnl: f64,
    r_multiple: f64,
    #[serde(default)]
    fee: Option<f64>,
    #[serde(default)]
    mae_pct: Option<f64>,
    #[serde(default)]
    mfe_pct: Option<f64>,
}

pub fn parse_trades_csv<R: Read>(reader: R) -> Result<Vec<Trade>> {
    let mut rdr = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    let mut trades = Vec::new();
    for rec in rdr.deserialize::<TradeRow>() {
        let r = rec?;
        let sl_history: Vec<StopPoint> = match r.sl_history.as_deref() {
            Some(s) if !s.trim().is_empty() => {
                serde_json::from_str(s).map_err(|e| IngestError::InvalidTrade {
                    id: r.id.to_string(),
                    reason: format!("sl_history: {e}"),
                })?
            }
            _ => Vec::new(),
        };
        trades.push(Trade {
            id: r.id,
            symbol: r.symbol,
            direction: r.direction,
            size: r.size,
            entry_time: r.entry_time,
            entry_price: r.entry_price,
            exit_time: r.exit_time,
            exit_price: r.exit_price,
            exit_reason: r.exit_reason,
            initial_sl: r.initial_sl,
            take_profit: r.take_profit,
            sl_history,
            pnl: r.pnl,
            r_multiple: r.r_multiple,
            fee: r.fee.unwrap_or(0.0),
            mae_pct: r.mae_pct,
            mfe_pct: r.mfe_pct,
        });
    }
    finish_trades(trades)
}

pub fn load_trades(path: &Path) -> Result<Vec<Trade>> {
    let file = File::open(path).map_err(|e| io_err(path, e))?;
    let reader = BufReader::new(file);
    match extension(path).as_str() {
        "jsonl" | "ndjson" => parse_jsonl(reader),
        "json" => parse_json_array(reader),
        _ => parse_trades_csv(reader),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"id":1,"symbol":"BTCUSDT","direction":"long","size":0.5,"entry_time":1700000000,"entry_price":63500.0,"exit_time":1700008100,"exit_price":64800.0,"exit_reason":"trailing_stop","initial_sl":63000.0,"take_profit":65000.0,"sl_history":[{"time":1700003600,"price":63500.0}],"pnl":650.0,"r_multiple":2.15}"#;

    #[test]
    fn jsonl_skips_blank_lines_and_accepts_long_alias() {
        let line2 = LINE.replace("\"id\":1", "\"id\":2");
        let input = format!("{LINE}\n\n{line2}\n");
        let trades = parse_jsonl(input.as_bytes()).unwrap();
        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].direction, TradeSide::Buy);
        assert_eq!(trades[0].fee, 0.0);
    }

    #[test]
    fn jsonl_error_names_the_line() {
        let input = format!("{LINE}\n{{not json}}\n");
        match parse_jsonl(input.as_bytes()) {
            Err(IngestError::InvalidTrade { id, .. }) => assert_eq!(id, "line 2"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn json_array_works() {
        let input = format!("[{LINE}]");
        assert_eq!(parse_json_array(input.as_bytes()).unwrap().len(), 1);
    }

    #[test]
    fn csv_with_blank_optionals_and_json_stop_path() {
        let csv = "id,symbol,direction,size,entry_time,entry_price,exit_time,exit_price,exit_reason,initial_sl,take_profit,sl_history,pnl,r_multiple\n\
                   1,ETHUSDT,short,2,1700000000,3420,,,,3460,,\"[{\"\"time\"\":1700000600,\"\"price\"\":3440.0}]\",0,0\n";
        let trades = parse_trades_csv(csv.as_bytes()).unwrap();
        let t = &trades[0];
        assert_eq!(t.direction, TradeSide::Sell);
        assert_eq!(t.exit_time, None);
        assert_eq!(
            t.sl_history,
            vec![StopPoint {
                time: 1_700_000_600,
                price: 3440.0
            }]
        );
    }

    #[test]
    fn exit_before_entry_is_rejected() {
        let input = LINE.replace("\"exit_time\":1700008100", "\"exit_time\":1600000000");
        assert!(matches!(
            parse_jsonl(input.as_bytes()),
            Err(IngestError::InvalidTrade { .. })
        ));
    }

    #[test]
    fn float_entry_time_in_jsonl() {
        let line = LINE.replace("\"entry_time\":1700000000", "\"entry_time\":1700000000.5");
        let trades = parse_jsonl(line.as_bytes()).unwrap();
        assert_eq!(trades[0].entry_time, 1_700_000_000);
    }

    #[test]
    fn csv_empty_fee_cell() {
        let csv = "id,symbol,direction,size,entry_time,entry_price,exit_time,exit_price,exit_reason,initial_sl,take_profit,sl_history,pnl,r_multiple,fee\n\
                   1,ETHUSDT,buy,1,1700000000,3420,,,,3400,,,0,0,\n";
        let trades = parse_trades_csv(csv.as_bytes()).unwrap();
        assert_eq!(trades[0].fee, 0.0);
    }
}
