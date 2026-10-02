# markout

An interactive financial time-series visualizer, session replay engine, and live trading monitor. Ships as a single binary with an embedded web interface.

## Features

### Shipped
- **Dense product terminal layout**: Left-anchored 3-column / 3-row grid with responsive desktop, mobile drawer, and bottom sheet ledger.
- **Canvas-based candlestick charting**: Volume pane, custom indicators, and dynamic crosshair synchronization.
- **Session replay engine**: Candle-by-candle replay, speed controls, timeline scrubber with trade markers, and keyboard controls (`Space`, `←`, `→`).
- **Hindsight-free ghost mode**: Simulates real-time execution by masking future bars, trailing stop advances, and exits until the replay cursor reaches them.
- **Trade lifecycle overlays**: Step-wise trailing stop paths, take-profit levels, entry/exit markers, and selected trade analysis card.
- **Performance analytics panel**: Hero Net PnL, cumulative equity sparkline, R-multiple distribution histogram, and exit reason breakdown.
- **Trade ledger with MAE / MFE**: Granular maximum adverse and favorable excursion metrics, duration, and in-cell R-multiple micro-bars.
- **Interactive drawing suite**: Trendlines, rays, horizontal/vertical levels, Fibonacci retracements, risk/reward position brackets, zones, measurement rulers, and text notes.
- **Live streaming daemon**: Generic event bus with WebSocket streaming (`/ws/stream`) and REST API.
- **Apache Parquet ingestion**: High-throughput zero-copy loading of `.parquet` bar and trade datasets (including compatibility with market simulators and tick feeds).

### Planned
- Multi-chart synchronized split layouts
- Export annotated replay sessions to video / animated GIF

## Usage

```bash
# Offline review of historical sessions
markout --db ./data/trades.parquet --bars ./data/bars.parquet

# Live monitoring daemon
markout live --port 8080
```

Common flags: `--host` (default `127.0.0.1`), `--port` (default `8080`).

## Try it

Sample data is included:

```bash
cargo run -- --db examples/trades.jsonl --bars examples/bars.csv
```

Entries and exits are drawn as arrows and dots, with each trade's trailing stop shown as a dashed step line and its take-profit as a dotted line. Click a row in the trade ledger to focus the chart on that trade.

## Input formats

| Data | Formats |
| :-- | :-- |
| Bars | Apache Parquet (`.parquet`), CSV (`time,open,high,low,close,volume`), a directory of CSV/Parquet files, or a SQLite `bars` table |
| Trades | Apache Parquet (`.parquet`), SQLite `trades` table, `.jsonl`/`.ndjson`, `.json` array, or `.csv` |

Timestamps are Unix seconds (millisecond, microsecond, and nanosecond values are automatically detected and converted). Every record is validated on load (finite prices, consistent high/low, ordered timestamps, no duplicate bars) and errors name the offending row or trade.

## Embedding

```rust
let bus = markout::EventBus::default();
// publish markout::MarketEvent values from any task...
markout::serve(config, bus).await?;
```

## HTTP API

| Endpoint | Description |
| :-- | :-- |
| `GET /api/v1/health` | Liveness and mode |
| `GET /api/v1/bars` | OHLCV bars |
| `GET /api/v1/trades` | Trades |
| `GET /api/v1/stats` | Performance summary (counts, win rate, net PnL, fees, average R, max drawdown) |
| `WS /ws/stream` | Live `MarketEvent` stream (JSON) |

## Build

```bash
# Frontend (requires Node 18+); outputs to web/dist/
cd web && npm install && npm run build && cd ..

# Backend (embeds web/dist/ at compile time)
cargo build --release
cargo test
```

Frontend overlay logic has unit tests that run on Node 22.18+ with no extra dependencies: `cd web && npm test`.

For frontend development, run the server (`cargo run -- --bars ./data/bars`) and then `npm run dev` inside `web/`; the dev server proxies `/api` and `/ws` to port 8080.
