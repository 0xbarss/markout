//! OHLCV bar loader. CSV header: `time,open,high,low,close,volume` (lowercase, any order).
//!
//! Directories load every `*.csv` inside and merge; overlapping timestamps are an error.
//! Parquet is not supported yet.

use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

use serde::Deserialize;

use super::{
    extension, io_err, normalize_bars, normalize_time, sqlite, validate_bar, IngestError, Result,
};
use crate::models::Bar;

#[derive(Deserialize)]
struct RawBar {
    time: f64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

pub fn parse_csv<R: Read>(reader: R) -> Result<Vec<Bar>> {
    let mut rdr = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    let mut bars = Vec::new();
    for (i, rec) in rdr.deserialize::<RawBar>().enumerate() {
        let raw = rec?;
        let bar = Bar {
            time: normalize_time(raw.time as i64),
            open: raw.open,
            high: raw.high,
            low: raw.low,
            close: raw.close,
            volume: raw.volume,
        };
        // +2: one for the header line, one for 1-based numbering
        validate_bar(&bar).map_err(|reason| IngestError::InvalidBar { row: i + 2, reason })?;
        bars.push(bar);
    }
    normalize_bars(bars)
}

pub fn load_csv(path: &Path) -> Result<Vec<Bar>> {
    let file = File::open(path).map_err(|e| io_err(path, e))?;
    parse_csv(BufReader::new(file))
}

pub fn load_dir(dir: &Path) -> Result<Vec<Bar>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| io_err(dir, e))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && matches!(extension(p).as_str(), "csv" | "parquet"))
        .collect();
    files.sort();

    let mut all = Vec::new();
    for f in files {
        if extension(&f) == "parquet" {
            all.extend(super::parquet::load_bars(&f)?);
        } else {
            all.extend(load_csv(&f)?);
        }
    }
    normalize_bars(all)
}

/// Load bars from a CSV file, a Parquet file, a directory of CSV/Parquet files, or a SQLite database.
pub fn load(path: &Path) -> Result<Vec<Bar>> {
    if path.is_dir() {
        load_dir(path)
    } else if matches!(extension(path).as_str(), "sqlite" | "sqlite3" | "db") {
        sqlite::load_bars(path)
    } else if extension(path) == "parquet" {
        super::parquet::load_bars(path)
    } else {
        load_csv(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_any_column_order_and_sorts() {
        let csv = "close,open,high,low,volume,time\n1.5,1.0,2.0,0.5,10,1700000060\n1.2,1.1,1.3,1.0,5,1700000000\n";
        let bars = parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].time, 1_700_000_000);
        assert_eq!(bars[1].close, 1.5);
    }

    #[test]
    fn millisecond_timestamps_become_seconds() {
        let csv = "time,open,high,low,close,volume\n1700000000000,1,2,0.5,1.5,1\n";
        assert_eq!(parse_csv(csv.as_bytes()).unwrap()[0].time, 1_700_000_000);
    }

    #[test]
    fn invalid_bar_reports_row() {
        let csv = "time,open,high,low,close,volume\n1700000000,1,2,0.5,1.5,1\n1700000060,1,0.9,0.5,0.8,1\n";
        match parse_csv(csv.as_bytes()) {
            Err(IngestError::InvalidBar { row, .. }) => assert_eq!(row, 3),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn duplicate_timestamps_rejected() {
        let csv =
            "time,open,high,low,close,volume\n1700000000,1,2,0.5,1.5,1\n1700000000,1,2,0.5,1.5,1\n";
        assert!(matches!(
            parse_csv(csv.as_bytes()),
            Err(IngestError::DuplicateBar(1_700_000_000))
        ));
    }

    #[test]
    fn directory_merges_csv_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let hdr = "time,open,high,low,close,volume\n";
        std::fs::write(
            dir.path().join("b.csv"),
            format!("{hdr}1700000060,1,2,0.5,1.5,1\n"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("a.csv"),
            format!("{hdr}1700000000,1,2,0.5,1.5,1\n"),
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), "ignore me").unwrap();
        let bars = load(dir.path()).unwrap();
        assert_eq!(
            bars.iter().map(|b| b.time).collect::<Vec<_>>(),
            vec![1_700_000_000, 1_700_000_060]
        );
    }
}
