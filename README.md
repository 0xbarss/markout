# markout

An interactive financial time-series visualizer, session replay engine, and live trading monitor. Ships as a single binary with an embedded web interface.

## Features (roadmap)

- Dark-mode derivatives terminal layout, responsive for desktop and mobile
- Canvas-based candlestick charting with volume pane
- Candle-by-candle replay with speed control and a hindsight-free "ghost" mode
- Trade lifecycle overlays with dynamic trailing stop and take-profit paths
- Drawing suite: trendlines, zones, retracements, risk/reward and measurement tools
- Live streaming over a generic event channel; embeddable as a Rust library

## Usage

```bash
# Offline review of historical sessions
markout --db ./data/trades.sqlite --bars ./data/bars/

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
| Bars | CSV (`time,open,high,low,close,volume`), a directory of CSV files, or a SQLite `bars` table |
| Trades | SQLite `trades` table, `.jsonl`/`.ndjson`, `.json` array, or `.csv` |

Timestamps are Unix seconds (millisecond values are detected and converted). Every record is validated on load (finite prices, consistent high/low, ordered timestamps, no duplicate bars) and errors name the offending row or trade. Parquet is not yet supported.

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
