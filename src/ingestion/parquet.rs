//! Apache Parquet ingestion for OHLCV bars and trade sessions.
//!
//! Supports reading Parquet files created by Pandas, Polars, Arrow, or market simulators.
//! Handles various timestamp units (seconds, milliseconds, microseconds, nanoseconds),
//! flexible column naming conventions, and diverse numeric encodings.

use std::{fs::File, path::Path};

use arrow::array::{Array, AsArray};
use arrow::datatypes::*;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

use super::{
    finish_trades, io_err, normalize_bars, normalize_time, validate_bar, IngestError, Result,
};
use crate::models::{Bar, ExitReason, StopPoint, Trade, TradeSide};

fn find_column_index(schema: &Schema, candidates: &[&str]) -> Option<usize> {
    for candidate in candidates {
        for (i, field) in schema.fields().iter().enumerate() {
            if field.name().eq_ignore_ascii_case(candidate) {
                return Some(i);
            }
        }
    }
    None
}

fn get_f64(col: &dyn Array, row: usize) -> Option<f64> {
    if col.is_null(row) {
        return None;
    }
    match col.data_type() {
        DataType::Float64 => Some(col.as_primitive::<Float64Type>().value(row)),
        DataType::Float32 => Some(col.as_primitive::<Float32Type>().value(row) as f64),
        DataType::Int64 => Some(col.as_primitive::<Int64Type>().value(row) as f64),
        DataType::UInt64 => Some(col.as_primitive::<UInt64Type>().value(row) as f64),
        DataType::Int32 => Some(col.as_primitive::<Int32Type>().value(row) as f64),
        DataType::UInt32 => Some(col.as_primitive::<UInt32Type>().value(row) as f64),
        DataType::Int16 => Some(col.as_primitive::<Int16Type>().value(row) as f64),
        DataType::UInt16 => Some(col.as_primitive::<UInt16Type>().value(row) as f64),
        DataType::Int8 => Some(col.as_primitive::<Int8Type>().value(row) as f64),
        DataType::UInt8 => Some(col.as_primitive::<UInt8Type>().value(row) as f64),
        DataType::Decimal128(_, scale) => {
            let v = col.as_primitive::<Decimal128Type>().value(row);
            Some(v as f64 / 10f64.powi(*scale as i32))
        }
        DataType::Dictionary(_, _) => {
            let one = col.slice(row, 1);
            let cast = arrow::compute::cast(&one, &DataType::Float64).ok()?;
            let p = cast.as_primitive::<Float64Type>();
            if p.is_null(0) {
                None
            } else {
                Some(p.value(0))
            }
        }
        _ => None,
    }
}

fn get_timestamp(col: &dyn Array, row: usize) -> Option<i64> {
    if col.is_null(row) {
        return None;
    }
    match col.data_type() {
        DataType::Timestamp(unit, _) => {
            let val = match unit {
                TimeUnit::Second => col.as_primitive::<TimestampSecondType>().value(row),
                TimeUnit::Millisecond => {
                    col.as_primitive::<TimestampMillisecondType>().value(row) / 1_000
                }
                TimeUnit::Microsecond => {
                    col.as_primitive::<TimestampMicrosecondType>().value(row) / 1_000_000
                }
                TimeUnit::Nanosecond => {
                    col.as_primitive::<TimestampNanosecondType>().value(row) / 1_000_000_000
                }
            };
            Some(val)
        }
        DataType::Int64 => Some(normalize_time(col.as_primitive::<Int64Type>().value(row))),
        DataType::UInt64 => Some(normalize_time(
            col.as_primitive::<UInt64Type>().value(row) as i64
        )),
        DataType::Int32 => Some(normalize_time(
            col.as_primitive::<Int32Type>().value(row) as i64
        )),
        DataType::UInt32 => Some(normalize_time(
            col.as_primitive::<UInt32Type>().value(row) as i64
        )),
        DataType::Date32 => {
            let days = col.as_primitive::<Date32Type>().value(row);
            Some(days as i64 * 86_400)
        }
        DataType::Date64 => {
            let ms = col.as_primitive::<Date64Type>().value(row);
            Some(ms / 1000)
        }
        DataType::Float64 => Some(normalize_time(
            col.as_primitive::<Float64Type>().value(row) as i64
        )),
        DataType::Utf8 => {
            let s = col.as_string::<i32>().value(row);
            if let Ok(ts) = s.parse::<i64>() {
                Some(normalize_time(ts))
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                Some(dt.timestamp())
            } else {
                None
            }
        }
        DataType::LargeUtf8 => {
            let s = col.as_string::<i64>().value(row);
            if let Ok(ts) = s.parse::<i64>() {
                Some(normalize_time(ts))
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                Some(dt.timestamp())
            } else {
                None
            }
        }
        DataType::Utf8View => {
            let s = col.as_string_view().value(row);
            if let Ok(ts) = s.parse::<i64>() {
                Some(normalize_time(ts))
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                Some(dt.timestamp())
            } else {
                None
            }
        }
        DataType::Dictionary(_, _) => {
            let one = col.slice(row, 1);
            if let Ok(cast) = arrow::compute::cast(&one, &DataType::Utf8) {
                let s = cast.as_string::<i32>();
                if !s.is_null(0) {
                    let val = s.value(0);
                    if let Ok(ts) = val.parse::<i64>() {
                        return Some(normalize_time(ts));
                    } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(val) {
                        return Some(dt.timestamp());
                    }
                }
            }
            if let Ok(cast) = arrow::compute::cast(&one, &DataType::Int64) {
                let p = cast.as_primitive::<Int64Type>();
                if !p.is_null(0) {
                    return Some(normalize_time(p.value(0)));
                }
            }
            None
        }
        _ => None,
    }
}

fn get_string(col: &dyn Array, row: usize) -> Option<String> {
    if col.is_null(row) {
        return None;
    }
    match col.data_type() {
        DataType::Utf8 => Some(col.as_string::<i32>().value(row).to_string()),
        DataType::LargeUtf8 => Some(col.as_string::<i64>().value(row).to_string()),
        DataType::Utf8View => Some(col.as_string_view().value(row).to_string()),
        DataType::Int64 => Some(col.as_primitive::<Int64Type>().value(row).to_string()),
        DataType::UInt64 => Some(col.as_primitive::<UInt64Type>().value(row).to_string()),
        DataType::Int32 => Some(col.as_primitive::<Int32Type>().value(row).to_string()),
        DataType::UInt32 => Some(col.as_primitive::<UInt32Type>().value(row).to_string()),
        DataType::Dictionary(_, _) => {
            let one = col.slice(row, 1);
            let cast = arrow::compute::cast(&one, &DataType::Utf8).ok()?;
            let s = cast.as_string::<i32>();
            if s.is_null(0) {
                None
            } else {
                Some(s.value(0).to_string())
            }
        }
        _ => None,
    }
}

fn parse_direction(val: &str) -> Option<TradeSide> {
    match val.trim().to_ascii_lowercase().as_str() {
        "buy" | "long" | "bid" | "b" | "1" => Some(TradeSide::Buy),
        "sell" | "short" | "ask" | "s" | "-1" => Some(TradeSide::Sell),
        _ => None,
    }
}

/// Load OHLCV bars from an Apache Parquet file.
pub fn load_bars(path: &Path) -> Result<Vec<Bar>> {
    let file = File::open(path).map_err(|e| io_err(path, e))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let schema = builder.schema().clone();

    let time_idx = find_column_index(
        &schema,
        &[
            "time",
            "timestamp",
            "timestamp_ms",
            "datetime",
            "date",
            "ts",
            "t",
        ],
    )
    .ok_or_else(|| IngestError::MissingColumn {
        table: "parquet_bars",
        column: "time/timestamp",
    })?;

    let open_idx =
        find_column_index(&schema, &["open", "o"]).ok_or_else(|| IngestError::MissingColumn {
            table: "parquet_bars",
            column: "open",
        })?;

    let high_idx =
        find_column_index(&schema, &["high", "h"]).ok_or_else(|| IngestError::MissingColumn {
            table: "parquet_bars",
            column: "high",
        })?;

    let low_idx =
        find_column_index(&schema, &["low", "l"]).ok_or_else(|| IngestError::MissingColumn {
            table: "parquet_bars",
            column: "low",
        })?;

    let close_idx = find_column_index(&schema, &["close", "c", "price"]).ok_or_else(|| {
        IngestError::MissingColumn {
            table: "parquet_bars",
            column: "close",
        }
    })?;

    let vol_idx = find_column_index(&schema, &["volume", "vol", "v", "qty"]);

    let reader = builder.build()?;
    let mut bars = Vec::new();
    let mut row_count = 0;

    for batch_res in reader {
        let batch = batch_res?;
        let time_col = batch.column(time_idx);
        let open_col = batch.column(open_idx);
        let high_col = batch.column(high_idx);
        let low_col = batch.column(low_idx);
        let close_col = batch.column(close_idx);
        let vol_col = vol_idx.map(|idx| batch.column(idx));

        for r in 0..batch.num_rows() {
            row_count += 1;
            let time =
                get_timestamp(time_col.as_ref(), r).ok_or_else(|| IngestError::InvalidBar {
                    row: row_count,
                    reason: "missing or invalid timestamp".to_string(),
                })?;
            let open = get_f64(open_col.as_ref(), r).ok_or_else(|| IngestError::InvalidBar {
                row: row_count,
                reason: "missing or invalid open price".to_string(),
            })?;
            let high = get_f64(high_col.as_ref(), r).ok_or_else(|| IngestError::InvalidBar {
                row: row_count,
                reason: "missing or invalid high price".to_string(),
            })?;
            let low = get_f64(low_col.as_ref(), r).ok_or_else(|| IngestError::InvalidBar {
                row: row_count,
                reason: "missing or invalid low price".to_string(),
            })?;
            let close = get_f64(close_col.as_ref(), r).ok_or_else(|| IngestError::InvalidBar {
                row: row_count,
                reason: "missing or invalid close price".to_string(),
            })?;
            let volume = vol_col.and_then(|c| get_f64(c.as_ref(), r)).unwrap_or(0.0);

            let bar = Bar {
                time,
                open,
                high,
                low,
                close,
                volume,
            };
            validate_bar(&bar).map_err(|reason| IngestError::InvalidBar {
                row: row_count,
                reason,
            })?;
            bars.push(bar);
        }
    }

    normalize_bars(bars)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParquetWarningCounters {
    pub defaulted_symbol: usize,
    pub defaulted_size: usize,
    pub defaulted_direction: usize,
    pub defaulted_initial_sl: usize,
    pub defaulted_id: usize,
    pub invalid_exit_reason: usize,
    pub invalid_sl_history: usize,
}

/// Load trades from an Apache Parquet file using strict mode.
pub fn load_trades(path: &Path) -> Result<Vec<Trade>> {
    load_trades_opts(path, false)
}

/// Load trades from an Apache Parquet file with optional lenient parsing.
pub fn load_trades_opts(path: &Path, lenient: bool) -> Result<Vec<Trade>> {
    let (trades, _counters) = load_trades_with_counters(path, lenient)?;
    Ok(trades)
}

/// Load trades returning collected warning counters for testability and logging.
pub fn load_trades_with_counters(
    path: &Path,
    lenient: bool,
) -> Result<(Vec<Trade>, ParquetWarningCounters)> {
    let file = File::open(path).map_err(|e| io_err(path, e))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let schema = builder.schema().clone();

    let id_idx = find_column_index(&schema, &["id", "trade_id", "seq"]);
    let symbol_idx = find_column_index(&schema, &["symbol", "sym", "pair", "ticker"]);
    let dir_idx = find_column_index(&schema, &["direction", "side", "action", "aggressor"]);
    if !lenient && dir_idx.is_none() {
        return Err(IngestError::MissingColumn {
            table: "parquet_trades",
            column: "direction/side",
        });
    }

    let size_idx = find_column_index(&schema, &["size", "qty", "quantity", "amount"]);
    if !lenient && size_idx.is_none() {
        return Err(IngestError::MissingColumn {
            table: "parquet_trades",
            column: "size/qty",
        });
    }

    let entry_time_idx = find_column_index(
        &schema,
        &[
            "entry_time",
            "entry_timestamp",
            "time",
            "timestamp",
            "timestamp_ms",
            "ts",
        ],
    )
    .ok_or_else(|| IngestError::MissingColumn {
        table: "parquet_trades",
        column: "entry_time/timestamp",
    })?;

    let entry_price_idx = find_column_index(
        &schema,
        &["entry_price", "price", "fill_price", "open_price"],
    )
    .ok_or_else(|| IngestError::MissingColumn {
        table: "parquet_trades",
        column: "entry_price/price",
    })?;

    let exit_time_idx = find_column_index(&schema, &["exit_time", "close_time", "exit_timestamp"]);
    let exit_price_idx = find_column_index(&schema, &["exit_price", "close_price"]);
    let exit_reason_idx = find_column_index(&schema, &["exit_reason", "reason", "exit_type"]);
    let sl_idx = find_column_index(&schema, &["initial_sl", "sl", "stop_loss", "stop"]);
    if !lenient && sl_idx.is_none() {
        return Err(IngestError::MissingColumn {
            table: "parquet_trades",
            column: "initial_sl/stop_loss",
        });
    }

    let tp_idx = find_column_index(&schema, &["take_profit", "tp", "target"]);
    let sl_hist_idx = find_column_index(&schema, &["sl_history"]);
    let pnl_idx = find_column_index(&schema, &["pnl", "profit", "net_pnl"]);
    let r_idx = find_column_index(&schema, &["r_multiple", "r", "rmultiple"]);
    let fee_idx = find_column_index(&schema, &["fee", "commission", "fees"]);
    let mae_idx = find_column_index(&schema, &["mae_pct", "mae"]);
    let mfe_idx = find_column_index(&schema, &["mfe_pct", "mfe"]);

    let reader = builder.build()?;
    let mut trades = Vec::new();
    let mut trade_seq: u64 = 0;
    let mut counters = ParquetWarningCounters::default();

    for batch_res in reader {
        let batch = batch_res?;
        let num_rows = batch.num_rows();

        let id_col = id_idx.map(|i| batch.column(i));
        let sym_col = symbol_idx.map(|i| batch.column(i));
        let dir_col = dir_idx.map(|i| batch.column(i));
        let size_col = size_idx.map(|i| batch.column(i));
        let entry_time_col = batch.column(entry_time_idx);
        let entry_price_col = batch.column(entry_price_idx);
        let exit_time_col = exit_time_idx.map(|i| batch.column(i));
        let exit_price_col = exit_price_idx.map(|i| batch.column(i));
        let exit_reason_col = exit_reason_idx.map(|i| batch.column(i));
        let sl_col = sl_idx.map(|i| batch.column(i));
        let tp_col = tp_idx.map(|i| batch.column(i));
        let sl_hist_col = sl_hist_idx.map(|i| batch.column(i));
        let pnl_col = pnl_idx.map(|i| batch.column(i));
        let r_col = r_idx.map(|i| batch.column(i));
        let fee_col = fee_idx.map(|i| batch.column(i));
        let mae_col = mae_idx.map(|i| batch.column(i));
        let mfe_col = mfe_idx.map(|i| batch.column(i));

        for r in 0..num_rows {
            trade_seq += 1;
            let id = if let Some(c) = id_col {
                if c.is_null(r) {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: "-".to_string(),
                            reason: "null id in id column".to_string(),
                        });
                    }
                    counters.defaulted_id += 1;
                    trade_seq
                } else if let Some(v) = get_f64(c.as_ref(), r) {
                    if v < 0.0 || v.fract() != 0.0 {
                        return Err(IngestError::InvalidTrade {
                            id: v.to_string(),
                            reason: "negative or fractional id".to_string(),
                        });
                    }
                    v as u64
                } else if let Some(s) = get_string(c.as_ref(), r) {
                    s.parse::<u64>().map_err(|_| IngestError::InvalidTrade {
                        id: s.clone(),
                        reason: "invalid numeric trade id".to_string(),
                    })?
                } else {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: "-".to_string(),
                            reason: "unrecognized id format".to_string(),
                        });
                    }
                    counters.defaulted_id += 1;
                    trade_seq
                }
            } else {
                trade_seq
            };

            let symbol = if let Some(c) = sym_col {
                match get_string(c.as_ref(), r) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => {
                        counters.defaulted_symbol += 1;
                        "UNKNOWN".to_string()
                    }
                }
            } else {
                counters.defaulted_symbol += 1;
                "UNKNOWN".to_string()
            };

            let direction = if let Some(c) = dir_col {
                if c.is_null(r) {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "null direction".to_string(),
                        });
                    }
                    counters.defaulted_direction += 1;
                    TradeSide::Buy
                } else if let Some(s) = get_string(c.as_ref(), r) {
                    match parse_direction(&s) {
                        Some(d) => d,
                        None => {
                            if !lenient {
                                return Err(IngestError::InvalidTrade {
                                    id: id.to_string(),
                                    reason: format!("unrecognized direction `{s}`"),
                                });
                            }
                            counters.defaulted_direction += 1;
                            TradeSide::Buy
                        }
                    }
                } else if let Some(n) = get_f64(c.as_ref(), r) {
                    if n == 1.0 || n >= 0.0 {
                        TradeSide::Buy
                    } else {
                        TradeSide::Sell
                    }
                } else {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "unrecognized direction".to_string(),
                        });
                    }
                    counters.defaulted_direction += 1;
                    TradeSide::Buy
                }
            } else {
                counters.defaulted_direction += 1;
                TradeSide::Buy
            };

            let size = if let Some(c) = size_col {
                if c.is_null(r) {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "missing size".to_string(),
                        });
                    }
                    counters.defaulted_size += 1;
                    1.0
                } else if let Some(sz) = get_f64(c.as_ref(), r) {
                    if sz <= 0.0 || !sz.is_finite() {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "size must be positive".to_string(),
                        });
                    }
                    sz
                } else {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "unrecognized size".to_string(),
                        });
                    }
                    counters.defaulted_size += 1;
                    1.0
                }
            } else {
                counters.defaulted_size += 1;
                1.0
            };

            let entry_time = get_timestamp(entry_time_col.as_ref(), r).ok_or_else(|| {
                IngestError::InvalidTrade {
                    id: id.to_string(),
                    reason: "missing entry timestamp".to_string(),
                }
            })?;

            let entry_price =
                get_f64(entry_price_col.as_ref(), r).ok_or_else(|| IngestError::InvalidTrade {
                    id: id.to_string(),
                    reason: "missing entry price".to_string(),
                })?;
            if entry_price <= 0.0 || !entry_price.is_finite() {
                return Err(IngestError::InvalidTrade {
                    id: id.to_string(),
                    reason: "entry price must be positive".to_string(),
                });
            }

            let exit_time = exit_time_col.and_then(|c| get_timestamp(c.as_ref(), r));
            let exit_price = exit_price_col.and_then(|c| get_f64(c.as_ref(), r));

            let exit_reason = if let Some(c) = exit_reason_col {
                if c.is_null(r) {
                    None
                } else if let Some(s) = get_string(c.as_ref(), r) {
                    if s.trim().is_empty() {
                        None
                    } else {
                        match super::parse_enum::<ExitReason>(&s) {
                            Ok(reason) => Some(reason),
                            Err(_) => {
                                if !lenient {
                                    let truncated = if s.len() > 80 {
                                        format!("{}...", &s[..80])
                                    } else {
                                        s
                                    };
                                    return Err(IngestError::InvalidTrade {
                                        id: id.to_string(),
                                        reason: format!("unrecognized exit_reason `{truncated}`"),
                                    });
                                }
                                counters.invalid_exit_reason += 1;
                                None
                            }
                        }
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let initial_sl = if let Some(c) = sl_col {
                if c.is_null(r) {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "missing stop loss".to_string(),
                        });
                    }
                    counters.defaulted_initial_sl += 1;
                    entry_price
                } else if let Some(sl) = get_f64(c.as_ref(), r) {
                    if sl <= 0.0 || !sl.is_finite() {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "stop loss must be positive".to_string(),
                        });
                    }
                    sl
                } else {
                    if !lenient {
                        return Err(IngestError::InvalidTrade {
                            id: id.to_string(),
                            reason: "unrecognized stop loss".to_string(),
                        });
                    }
                    counters.defaulted_initial_sl += 1;
                    entry_price
                }
            } else {
                counters.defaulted_initial_sl += 1;
                entry_price
            };

            let take_profit = tp_col.and_then(|c| get_f64(c.as_ref(), r));

            let sl_history = if let Some(c) = sl_hist_col {
                if c.is_null(r) {
                    Vec::new()
                } else if let Some(s) = get_string(c.as_ref(), r) {
                    if s.trim().is_empty() {
                        Vec::new()
                    } else {
                        match serde_json::from_str::<Vec<StopPoint>>(&s) {
                            Ok(hist) => hist,
                            Err(_) => {
                                if !lenient {
                                    let truncated = if s.len() > 80 {
                                        format!("{}...", &s[..80])
                                    } else {
                                        s
                                    };
                                    return Err(IngestError::InvalidTrade {
                                        id: id.to_string(),
                                        reason: format!("invalid sl_history `{truncated}`"),
                                    });
                                }
                                counters.invalid_sl_history += 1;
                                Vec::new()
                            }
                        }
                    }
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };

            let fee = fee_col.and_then(|c| get_f64(c.as_ref(), r)).unwrap_or(0.0);

            // Compute PnL if not explicitly provided
            let pnl = if let Some(explicit_pnl) = pnl_col.and_then(|c| get_f64(c.as_ref(), r)) {
                explicit_pnl
            } else if let Some(exit_p) = exit_price {
                let diff = exit_p - entry_price;
                let sign = match direction {
                    TradeSide::Buy => 1.0,
                    TradeSide::Sell => -1.0,
                };
                (diff * sign * size) - fee
            } else {
                0.0
            };

            // Compute R-multiple if not explicitly provided
            let r_multiple = if let Some(explicit_r) = r_col.and_then(|c| get_f64(c.as_ref(), r)) {
                explicit_r
            } else {
                let risk = (entry_price - initial_sl).abs() * size;
                if risk > 1e-9 {
                    pnl / risk
                } else {
                    0.0
                }
            };

            let mae_pct = mae_col.and_then(|c| get_f64(c.as_ref(), r));
            let mfe_pct = mfe_col.and_then(|c| get_f64(c.as_ref(), r));

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
                fee,
                mae_pct,
                mfe_pct,
            });
        }
    }

    if lenient {
        if counters.defaulted_symbol > 0
            || counters.defaulted_size > 0
            || counters.defaulted_direction > 0
            || counters.defaulted_initial_sl > 0
            || counters.defaulted_id > 0
            || counters.invalid_exit_reason > 0
            || counters.invalid_sl_history > 0
        {
            tracing::warn!(
                "parquet: defaulted symbol for {} rows, size for {} rows, direction for {} rows, initial_sl for {} rows, id for {} rows, invalid exit_reason for {} rows, invalid sl_history for {} rows",
                counters.defaulted_symbol,
                counters.defaulted_size,
                counters.defaulted_direction,
                counters.defaulted_initial_sl,
                counters.defaulted_id,
                counters.invalid_exit_reason,
                counters.invalid_sl_history,
            );
        }
        if counters.defaulted_initial_sl > 0 {
            tracing::warn!(
                "parquet: {} rows loaded as open trades without a stop; chart overlays will be limited",
                counters.defaulted_initial_sl
            );
        }
    }

    let finished = finish_trades(trades)?;
    Ok((finished, counters))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Float64Array, Int64Array, StringArray, UInt64Array};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    #[test]
    fn test_load_bars_parquet() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("time", DataType::Int64, false),
            Field::new("open", DataType::Float64, false),
            Field::new("high", DataType::Float64, false),
            Field::new("low", DataType::Float64, false),
            Field::new("close", DataType::Float64, false),
            Field::new("volume", DataType::Float64, false),
        ]));

        let times = Int64Array::from(vec![1_700_000_060, 1_700_000_000]);
        let opens = Float64Array::from(vec![100.0, 99.0]);
        let highs = Float64Array::from(vec![105.0, 102.0]);
        let lows = Float64Array::from(vec![98.0, 97.0]);
        let closes = Float64Array::from(vec![103.0, 101.0]);
        let volumes = Float64Array::from(vec![150.0, 120.0]);

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(times),
                Arc::new(opens),
                Arc::new(highs),
                Arc::new(lows),
                Arc::new(closes),
                Arc::new(volumes),
            ],
        )
        .unwrap();

        let file = NamedTempFile::new().unwrap();
        let mut writer = ArrowWriter::try_new(file.reopen().unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let bars = load_bars(file.path()).unwrap();
        assert_eq!(bars.len(), 2);
        // Verify sorted order
        assert_eq!(bars[0].time, 1_700_000_000);
        assert_eq!(bars[0].close, 101.0);
        assert_eq!(bars[1].time, 1_700_000_060);
        assert_eq!(bars[1].close, 103.0);
    }

    #[test]
    fn test_load_trades_parquet() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::UInt64, false),
            Field::new("symbol", DataType::Utf8, false),
            Field::new("side", DataType::Utf8, false),
            Field::new("size", DataType::Float64, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("exit_time", DataType::Int64, false),
            Field::new("exit_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
            Field::new("take_profit", DataType::Float64, false),
        ]));

        let ids = UInt64Array::from(vec![1, 2]);
        let symbols = StringArray::from(vec!["BTCUSDT", "BTCUSDT"]);
        let sides = StringArray::from(vec!["buy", "sell"]);
        let sizes = Float64Array::from(vec![1.5, 2.0]);
        let entry_times = Int64Array::from(vec![1_700_000_000, 1_700_000_500]);
        let entry_prices = Float64Array::from(vec![50_000.0, 51_000.0]);
        let exit_times = Int64Array::from(vec![1_700_000_300, 1_700_000_800]);
        let exit_prices = Float64Array::from(vec![52_000.0, 50_000.0]);
        let initial_sls = Float64Array::from(vec![49_000.0, 52_000.0]);
        let take_profits = Float64Array::from(vec![53_000.0, 48_000.0]);

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(ids),
                Arc::new(symbols),
                Arc::new(sides),
                Arc::new(sizes),
                Arc::new(entry_times),
                Arc::new(entry_prices),
                Arc::new(exit_times),
                Arc::new(exit_prices),
                Arc::new(initial_sls),
                Arc::new(take_profits),
            ],
        )
        .unwrap();

        let file = NamedTempFile::new().unwrap();
        let mut writer = ArrowWriter::try_new(file.reopen().unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let trades = load_trades(file.path()).unwrap();
        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].id, 1);
        assert_eq!(trades[0].direction, TradeSide::Buy);
        assert_eq!(trades[0].pnl, 3000.0); // (52000 - 50000) * 1.5
        assert_eq!(trades[1].id, 2);
        assert_eq!(trades[1].direction, TradeSide::Sell);
        assert_eq!(trades[1].pnl, 2000.0); // (51000 - 50000) * 2.0
    }

    #[test]
    fn test_load_market_simulator_trades_parquet() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("seq", DataType::UInt64, false),
            Field::new("timestamp_ms", DataType::UInt64, false),
            Field::new("price", DataType::UInt64, false),
            Field::new("qty", DataType::UInt64, false),
            Field::new("aggressor", DataType::Utf8, false),
            Field::new("taker_order", DataType::UInt64, false),
            Field::new("maker_order", DataType::UInt64, false),
            Field::new("buyer", DataType::UInt64, false),
            Field::new("seller", DataType::UInt64, false),
        ]));

        let seqs = UInt64Array::from(vec![101, 102]);
        let timestamps = UInt64Array::from(vec![1_700_000_000_000, 1_700_000_005_000]);
        let prices = UInt64Array::from(vec![60_000, 60_050]);
        let qtys = UInt64Array::from(vec![10, 5]);
        let aggressors = StringArray::from(vec!["Bid", "Ask"]);
        let takers = UInt64Array::from(vec![1, 2]);
        let makers = UInt64Array::from(vec![3, 4]);
        let buyers = UInt64Array::from(vec![10, 11]);
        let sellers = UInt64Array::from(vec![20, 21]);

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(seqs),
                Arc::new(timestamps),
                Arc::new(prices),
                Arc::new(qtys),
                Arc::new(aggressors),
                Arc::new(takers),
                Arc::new(makers),
                Arc::new(buyers),
                Arc::new(sellers),
            ],
        )
        .unwrap();

        let file = NamedTempFile::new().unwrap();
        let mut writer = ArrowWriter::try_new(file.reopen().unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        // Strict mode rejects fills log due to missing stop-loss column
        let strict_err = load_trades(file.path()).unwrap_err();
        assert!(matches!(
            strict_err,
            IngestError::MissingColumn {
                column: "initial_sl/stop_loss",
                ..
            }
        ));

        // Lenient mode allows loading with warnings and defaulted stop/symbol
        let (trades, counters) = load_trades_with_counters(file.path(), true).unwrap();
        assert_eq!(counters.defaulted_initial_sl, 2);
        assert_eq!(counters.defaulted_symbol, 2);
        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].id, 101);
        assert_eq!(trades[0].entry_time, 1_700_000_000);
        assert_eq!(trades[0].entry_price, 60_000.0);
        assert_eq!(trades[0].size, 10.0);
        assert_eq!(trades[0].direction, TradeSide::Buy);
        assert_eq!(trades[0].initial_sl, 60_000.0);

        assert_eq!(trades[1].id, 102);
        assert_eq!(trades[1].entry_time, 1_700_000_005);
        assert_eq!(trades[1].entry_price, 60_050.0);
        assert_eq!(trades[1].size, 5.0);
        assert_eq!(trades[1].direction, TradeSide::Sell);
        assert_eq!(trades[1].initial_sl, 60_050.0);
    }

    #[test]
    fn test_load_trades_dictionary_categorical() {
        use arrow::array::{DictionaryArray, Int32Array};
        use arrow::datatypes::Int32Type;

        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::UInt64, false),
            Field::new(
                "symbol",
                DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
                false,
            ),
            Field::new(
                "side",
                DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
                false,
            ),
            Field::new("size", DataType::Float64, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
        ]));

        let ids = UInt64Array::from(vec![1, 2]);
        let sym_keys = Int32Array::from(vec![0, 1]);
        let sym_vals = Arc::new(StringArray::from(vec!["BTCUSDT", "ETHUSDT"]));
        let symbols = DictionaryArray::<Int32Type>::try_new(sym_keys, sym_vals).unwrap();

        let side_keys = Int32Array::from(vec![0, 1]);
        let side_vals = Arc::new(StringArray::from(vec!["buy", "sell"]));
        let sides = DictionaryArray::<Int32Type>::try_new(side_keys, side_vals).unwrap();

        let sizes = Float64Array::from(vec![1.0, 2.0]);
        let entry_times = Int64Array::from(vec![1_700_000_000, 1_700_000_100]);
        let entry_prices = Float64Array::from(vec![50_000.0, 3_000.0]);
        let initial_sls = Float64Array::from(vec![49_000.0, 3_100.0]);

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(ids),
                Arc::new(symbols),
                Arc::new(sides),
                Arc::new(sizes),
                Arc::new(entry_times),
                Arc::new(entry_prices),
                Arc::new(initial_sls),
            ],
        )
        .unwrap();

        let file = NamedTempFile::new().unwrap();
        let mut writer = ArrowWriter::try_new(file.reopen().unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let trades = load_trades(file.path()).unwrap();
        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].symbol, "BTCUSDT");
        assert_eq!(trades[0].direction, TradeSide::Buy);
        assert_eq!(trades[1].symbol, "ETHUSDT");
        assert_eq!(trades[1].direction, TradeSide::Sell);
    }

    #[test]
    fn test_load_bars_large_utf8_and_string_view() {
        use arrow::array::{LargeStringArray, StringViewArray};

        // Test with LargeUtf8
        let schema_large = Arc::new(Schema::new(vec![
            Field::new("time", DataType::LargeUtf8, false),
            Field::new("open", DataType::Float64, false),
            Field::new("high", DataType::Float64, false),
            Field::new("low", DataType::Float64, false),
            Field::new("close", DataType::Float64, false),
        ]));
        let times_large = LargeStringArray::from(vec!["2024-01-01T00:00:00Z"]);
        let opens = Float64Array::from(vec![100.0]);
        let highs = Float64Array::from(vec![105.0]);
        let lows = Float64Array::from(vec![98.0]);
        let closes = Float64Array::from(vec![103.0]);

        let batch_large = RecordBatch::try_new(
            schema_large.clone(),
            vec![
                Arc::new(times_large),
                Arc::new(opens.clone()),
                Arc::new(highs.clone()),
                Arc::new(lows.clone()),
                Arc::new(closes.clone()),
            ],
        )
        .unwrap();

        let file_large = NamedTempFile::new().unwrap();
        let mut writer_large =
            ArrowWriter::try_new(file_large.reopen().unwrap(), schema_large, None).unwrap();
        writer_large.write(&batch_large).unwrap();
        writer_large.close().unwrap();

        let bars_large = load_bars(file_large.path()).unwrap();
        assert_eq!(bars_large.len(), 1);
        assert_eq!(bars_large[0].time, 1704067200);

        // Test with Utf8View
        let schema_view = Arc::new(Schema::new(vec![
            Field::new("time", DataType::Utf8View, false),
            Field::new("open", DataType::Float64, false),
            Field::new("high", DataType::Float64, false),
            Field::new("low", DataType::Float64, false),
            Field::new("close", DataType::Float64, false),
        ]));
        let times_view = StringViewArray::from(vec!["2024-01-01T00:00:00Z"]);
        let batch_view = RecordBatch::try_new(
            schema_view.clone(),
            vec![
                Arc::new(times_view),
                Arc::new(opens),
                Arc::new(highs),
                Arc::new(lows),
                Arc::new(closes),
            ],
        )
        .unwrap();

        let file_view = NamedTempFile::new().unwrap();
        let mut writer_view =
            ArrowWriter::try_new(file_view.reopen().unwrap(), schema_view, None).unwrap();
        writer_view.write(&batch_view).unwrap();
        writer_view.close().unwrap();

        let bars_view = load_bars(file_view.path()).unwrap();
        assert_eq!(bars_view.len(), 1);
        assert_eq!(bars_view[0].time, 1704067200);
    }

    #[test]
    fn test_strict_parquet_rejections() {
        // 1. Invalid direction "banana"
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::UInt64, false),
            Field::new("side", DataType::Utf8, false),
            Field::new("size", DataType::Float64, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
        ]));

        let batch_banana = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(UInt64Array::from(vec![1])),
                Arc::new(StringArray::from(vec!["banana"])),
                Arc::new(Float64Array::from(vec![1.0])),
                Arc::new(Int64Array::from(vec![1700000000])),
                Arc::new(Float64Array::from(vec![100.0])),
                Arc::new(Float64Array::from(vec![95.0])),
            ],
        )
        .unwrap();

        let file = NamedTempFile::new().unwrap();
        let mut writer =
            ArrowWriter::try_new(file.reopen().unwrap(), schema.clone(), None).unwrap();
        writer.write(&batch_banana).unwrap();
        writer.close().unwrap();

        let err = load_trades(file.path()).unwrap_err();
        assert!(matches!(
            err,
            IngestError::InvalidTrade { ref reason, .. } if reason.contains("unrecognized direction `banana`")
        ));

        // 2. Missing size column
        let schema_no_size = Arc::new(Schema::new(vec![
            Field::new("id", DataType::UInt64, false),
            Field::new("side", DataType::Utf8, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
        ]));

        let batch_no_size = RecordBatch::try_new(
            schema_no_size.clone(),
            vec![
                Arc::new(UInt64Array::from(vec![1])),
                Arc::new(StringArray::from(vec!["buy"])),
                Arc::new(Int64Array::from(vec![1700000000])),
                Arc::new(Float64Array::from(vec![100.0])),
                Arc::new(Float64Array::from(vec![95.0])),
            ],
        )
        .unwrap();

        let file2 = NamedTempFile::new().unwrap();
        let mut writer2 =
            ArrowWriter::try_new(file2.reopen().unwrap(), schema_no_size, None).unwrap();
        writer2.write(&batch_no_size).unwrap();
        writer2.close().unwrap();

        let err2 = load_trades(file2.path()).unwrap_err();
        assert!(matches!(
            err2,
            IngestError::MissingColumn {
                column: "size/qty",
                ..
            }
        ));

        // 3. Negative ID
        let schema_id_f64 = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Float64, false),
            Field::new("side", DataType::Utf8, false),
            Field::new("size", DataType::Float64, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
        ]));

        let batch_neg_id = RecordBatch::try_new(
            schema_id_f64.clone(),
            vec![
                Arc::new(Float64Array::from(vec![-3.0])),
                Arc::new(StringArray::from(vec!["buy"])),
                Arc::new(Float64Array::from(vec![1.0])),
                Arc::new(Int64Array::from(vec![1700000000])),
                Arc::new(Float64Array::from(vec![100.0])),
                Arc::new(Float64Array::from(vec![95.0])),
            ],
        )
        .unwrap();

        let file3 = NamedTempFile::new().unwrap();
        let mut writer3 =
            ArrowWriter::try_new(file3.reopen().unwrap(), schema_id_f64, None).unwrap();
        writer3.write(&batch_neg_id).unwrap();
        writer3.close().unwrap();

        let err3 = load_trades(file3.path()).unwrap_err();
        assert!(matches!(
            err3,
            IngestError::InvalidTrade { ref reason, .. } if reason.contains("negative or fractional id")
        ));

        // 4. Null ID in strict mode
        let schema_nullable_id = Arc::new(Schema::new(vec![
            Field::new("id", DataType::UInt64, true),
            Field::new("side", DataType::Utf8, false),
            Field::new("size", DataType::Float64, false),
            Field::new("entry_time", DataType::Int64, false),
            Field::new("entry_price", DataType::Float64, false),
            Field::new("initial_sl", DataType::Float64, false),
        ]));

        let batch_null_id = RecordBatch::try_new(
            schema_nullable_id.clone(),
            vec![
                Arc::new(UInt64Array::from(vec![None])),
                Arc::new(StringArray::from(vec!["buy"])),
                Arc::new(Float64Array::from(vec![1.0])),
                Arc::new(Int64Array::from(vec![1700000000])),
                Arc::new(Float64Array::from(vec![100.0])),
                Arc::new(Float64Array::from(vec![95.0])),
            ],
        )
        .unwrap();

        let file4 = NamedTempFile::new().unwrap();
        let mut writer4 =
            ArrowWriter::try_new(file4.reopen().unwrap(), schema_nullable_id, None).unwrap();
        writer4.write(&batch_null_id).unwrap();
        writer4.close().unwrap();

        let err4 = load_trades(file4.path()).unwrap_err();
        assert!(matches!(
            err4,
            IngestError::InvalidTrade { ref reason, .. } if reason.contains("null id in id column")
        ));
    }
}
