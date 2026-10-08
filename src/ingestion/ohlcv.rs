//! OHLCV bar loader. Supports CSV files, Parquet files, directories, and SQLite databases.
//! Case-insensitive column names. Missing volume defaults to 0. Timestamps must be positive Unix
//! seconds (pre-1970 timestamps are rejected).

use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

use serde::Deserialize;

use super::{extension, io_err, normalize_bars, sqlite, validate_bar, IngestError, Result};
use crate::models::Bar;

#[derive(Deserialize)]
struct RawBar {
    #[serde(deserialize_with = "crate::models::de_time")]
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(default)]
    volume: Option<f64>,
}

fn true_line_number(data: &[u8], byte_offset: usize) -> usize {
    let mut offset = byte_offset;
    while offset < data.len()
        && (data[offset] == b'\r'
            || data[offset] == b'\n'
            || data[offset] == b' '
            || data[offset] == b'\t')
    {
        offset += 1;
    }
    1 + data[..offset].iter().filter(|&&b| b == b'\n').count()
}

pub fn parse_csv<R: Read>(mut reader: R) -> Result<Vec<Bar>> {
    let mut data = Vec::new();
    reader
        .read_to_end(&mut data)
        .map_err(|e| io_err(Path::new("<stream>"), e))?;

    let mut rdr = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(&data[..]);
    let raw_headers = rdr.headers()?.clone();
    let headers: csv::StringRecord = raw_headers
        .iter()
        .map(|h| match h.trim().to_ascii_lowercase().as_str() {
            "timestamp" | "date" | "datetime" | "ts" => "time".to_string(),
            other => other.to_ascii_lowercase(),
        })
        .collect();

    let mut bars = Vec::new();
    let mut row_idx = 0;
    for rec in rdr.records() {
        row_idx += 1;
        let record = rec?;
        let line_no = record
            .position()
            .map(|p| true_line_number(&data, p.byte() as usize))
            .unwrap_or(row_idx + 1);
        let raw: RawBar =
            record
                .deserialize(Some(&headers))
                .map_err(|e| IngestError::InvalidBar {
                    row: line_no,
                    reason: e.to_string(),
                })?;
        let bar = Bar {
            time: raw.time,
            open: raw.open,
            high: raw.high,
            low: raw.low,
            close: raw.close,
            volume: raw.volume.unwrap_or(0.0),
        };
        validate_bar(&bar).map_err(|reason| IngestError::InvalidBar {
            row: line_no,
            reason,
        })?;
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
        let bars = if extension(&f) == "parquet" {
            super::parquet::load_bars(&f)
        } else {
            load_csv(&f)
        }
        .map_err(|e| IngestError::InFile {
            path: f.display().to_string(),
            source: Box::new(e),
        })?;
        all.extend(bars);
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

    #[test]
    fn case_insensitive_headers_and_aliases() {
        let csv = "Time,Open,High,Low,Close,Volume\n1700000000,10,12,9,11,100\n";
        let bars = parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].close, 11.0);

        let csv_alias = "Timestamp,OPEN,HIGH,LOW,CLOSE,VOLUME\n1700000000,10,12,9,11,100\n";
        let bars_alias = parse_csv(csv_alias.as_bytes()).unwrap();
        assert_eq!(bars_alias.len(), 1);
        assert_eq!(bars_alias[0].time, 1_700_000_000);
    }

    #[test]
    fn missing_volume_defaults_to_zero() {
        let csv = "time,open,high,low,close\n1700000000,10,12,9,11\n";
        let bars = parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].volume, 0.0);
    }

    #[test]
    fn rfc3339_timestamp_parsed() {
        let csv = "time,open,high,low,close,volume\n2024-01-01T00:00:00Z,10,12,9,11,100\n";
        let bars = parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].time, 1_704_067_200);
    }

    #[test]
    fn blank_lines_preserve_file_line_numbers() {
        let csv = "time,open,high,low,close,volume\n1700000000,10,12,9,11,100\n\n1700000060,10,8,9,11,100\n";
        match parse_csv(csv.as_bytes()) {
            Err(IngestError::InvalidBar { row, .. }) => assert_eq!(row, 4),
            other => panic!("expected InvalidBar at line 4, got {other:?}"),
        }
    }

    #[test]
    fn load_dir_reports_in_file_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a_bad.csv"),
            "time,open,high,low,close,volume\n1700000000,10,8,9,11,100\n",
        )
        .unwrap();
        match load_dir(dir.path()) {
            Err(IngestError::InFile { path, source }) => {
                assert!(path.contains("a_bad.csv"));
                assert!(matches!(*source, IngestError::InvalidBar { .. }));
            }
            other => panic!("expected InFile error, got {other:?}"),
        }
    }
}
