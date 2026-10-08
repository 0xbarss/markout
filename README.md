# markout

[![Crates.io](https://img.shields.io/crates/v/markout-app.svg)](https://crates.io/crates/markout-app)
[![Docs.rs](https://docs.rs/markout-app/badge.svg)](https://docs.rs/markout-app)
[![Release](https://img.shields.io/github/v/release/0xbarss/markout.svg)](https://github.com/0xbarss/markout/releases)
[![Rust](https://img.shields.io/badge/rust-1.88%2B-orange.svg)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.4%2B-blue.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Author](https://img.shields.io/badge/author-0xbarss-purple.svg)](https://github.com/0xbarss)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)]()

Interactive financial time-series visualizer, session replay engine, and live trading monitor. Compiles as a single binary with an embedded web interface.

---

## Table of Contents

- [Why markout?](#why-markout)
- [Architecture & Design](#architecture--design)
  - [System Topology](#system-topology)
  - [Data Ingestion & Normalization Pipeline](#data-ingestion--normalization-pipeline)
  - [Replay Engine & Hindsight-Free Ghost Mode](#replay-engine--hindsight-free-ghost-mode)
  - [Real-Time Event Streaming & Concurrency](#real-time-event-streaming--concurrency)
  - [Frontend Architecture & Canvas Overlays](#frontend-architecture--canvas-overlays)
- [Key Features](#key-features)
- [Repository Structure](#repository-structure)
- [Prerequisites & Installation](#prerequisites--installation)
  - [Install via Cargo](#install-via-cargo)
  - [Building from Source](#building-from-source)
  - [Development Workflow](#development-workflow)
- [Usage & Code Examples](#usage--code-examples)
  - [1. Offline Session Review](#1-offline-session-review)
  - [2. Live Monitoring Daemon](#2-live-monitoring-daemon)
  - [3. Embedding as a Rust Library](#3-embedding-as-a-rust-library)
  - [4. Streaming Events via WebSocket](#4-streaming-events-via-websocket)
- [API Reference & Data Contracts](#api-reference--data-contracts)
  - [Command-Line Interface](#command-line-interface)
  - [HTTP Endpoints](#http-endpoints)
  - [WebSocket Streaming Protocol](#websocket-streaming-protocol)
  - [Supported Input Formats & Schemas](#supported-input-formats--schemas)
- [Testing & Quality Assurance](#testing--quality-assurance)
  - [Rust Test Suite](#rust-test-suite)
  - [Frontend Unit Tests](#frontend-unit-tests)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Author & Contributions](#author--contributions)
- [License & Disclaimer](#license--disclaimer)

---

## Why markout?

Reviewing algorithmic trading strategies usually means inspecting how individual orders, stops, and take-profit targets behaved alongside historical price action. Most existing tools make this awkward:

- Hosted charting platforms like TradingView require monthly subscriptions, cap replay history, and require uploading private trade logs to external servers.
- Python tools like `matplotlib` or `plotly` generate static charts that turn sluggish with large datasets. They lack interactive playback controls, do not link charts to an order ledger, and struggle once a dataset reaches hundreds of thousands of bars.
- Open-source chart viewers rarely track trade lifecycles. They show entry and exit arrows, but drop the steps in between, like trailing stop adjustments, maximum adverse and favorable excursion (MAE/MFE), and strategy indicator signals.
- Standard charts show future price action while you inspect an earlier trade, which introduces hindsight bias when evaluating discretionary or automated trades.

`markout` runs entirely on your local machine with zero external cloud dependencies:

1. A single executable embeds the web interface at compile time, so there are no separate frontend servers to configure or run.
2. Ingests Apache Parquet, SQLite, CSV, and JSONL files directly from disk with automatic timestamp normalization.
3. A candle-by-candle replay engine with ghost mode hides future candles, trailing stop updates, and exit fills until playback reaches them.
4. An internal broadcast bus streams live bars, ticks, and order lifecycle events over WebSockets to connected browsers.

---

## Architecture & Design

### System Topology

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                 Data Ingestion                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Apache Parquet  │  │ SQLite Database │  │ CSV Datasets │  │  JSON / JSONL │  │
│  │ (Bars / Trades) │  │  (bars/trades)  │  │ (OHLCV Bars) │  │ (Trades/Sigs) │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  └───────┬───────┘  │
└───────────┼────────────────────┼──────────────────┼──────────────────┼──────────┘
            │                    │                  │                  │
            ▼                    ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     Ingestion Normalizer & Schema Validator                     │
│  - Multi-scale timestamp detection (sec, ms, µs, ns) -> Normalized UTC seconds  │
│  - OHLC bounds check: high >= max(open, close) and low <= min(open, close)      │
│  - Duplicate bar elimination, ascending time sort, finite floating-point checks │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     markout Core Runtime (Rust / Tokio / Axum)                  │
│                                                                                 │
│   ┌───────────────────────────┐             ┌───────────────────────────────┐   │
│   │       Dataset Store       │             │       EventBus Broadcast      │   │
│   │ (In-Memory Bars & Trades) │             │   (Tokio broadcast channel)   │   │
│   └─────────────┬─────────────┘             └───────────────┬───────────────┘   │
│                 │                                           │                   │
│                 ▼                                           ▼                   │
│   ┌───────────────────────────┐             ┌───────────────────────────────┐   │
│   │    REST API Handlers      │             │       WebSocket Server        │   │
│   │  /api/v1/{bars,trades,...}│             │          /ws/stream           │   │
│   └─────────────┬─────────────┘             └───────────────┬───────────────┘   │
│                 │                                           │                   │
│                 ▼                                           ▼                   │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │             Embedded Static Web Assets (rust-embed SPA)                 │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ HTTP / WebSocket
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Web Terminal (Vanilla TS / Canvas)                       │
│                                                                                 │
│  ┌────────────────────────┐  ┌────────────────────────┐  ┌──────────────────┐   │
│  │ Lightweight Charts v4  │  │ Chart Overlays & Canvas│  │   Trade Ledger   │   │
│  │ - Candlesticks & Volume│  │  - Trailing Stop Lines │  │ - Tabbed views   │   │
│  │ - Timeframe Resampling │  │  - Entry/Exit Markers  │  │ - In-cell R bars │   │
│  │ - Bar Close Countdown  │  │  - User Drawing Tools  │  │ - MAE / MFE      │   │
│  └────────────────────────┘  └────────────────────────┘  └──────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ Replay & Ghost Controller (Playback state machine, speed, scrub timeline)│   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Data Ingestion & Normalization Pipeline

The ingestion layer (`src/ingestion/`) loads time-series and trade data from various formats and normalizes them into common memory models:

- **Timestamp Normalization**: Accepts Unix timestamps in seconds, milliseconds, microseconds, or nanoseconds. The loader checks magnitude thresholds (`10^11`, `10^14`, `10^17`) and converts every value to UTC seconds.
- **Defensive Validation**:
  - Bars: Rejects non-finite values (`NaN`, `±Inf`), negative volume, non-positive timestamps, inverted ranges (`low > high`), and prices where open or close fall outside high and low.
  - Trades: Checks for positive position size and entry price, chronological order (`exit_time >= entry_time`), and finite stop-loss coordinates.
- **Deduplication and Sorting**: Bars are sorted chronologically. If two bars share the exact same timestamp, the loader fails fast with a `DuplicateBar` error instead of silently dropping data.
- **Apache Parquet Access**: Reads Parquet files directly via Arrow record batches, mapping columns to typed Rust structs with support for primitive numeric encodings, dictionary-encoded strings, and ISO timestamp string parsing.

### Replay Engine & Hindsight-Free Ghost Mode

Session playback in the web UI is driven by the client-side replay controller (`web/src/replay/controller.ts`), providing instant scrubbing and hindsight-free ghost mode without roundtrips. For server-driven live simulation, the Rust `ReplayEngine` (`src/replay.rs`) steps through historical candlesticks and streams them to `/ws/stream` on a configurable ticker:

- Transitions across `Paused`, `Playing`, and `Finished` states.
- Supports discrete speed multipliers: `1x`, `2x`, `5x`, `10x`, `20x`, `50x`, and `100x`.
- Ghost mode masks future data:
  - Bars after the current cursor timestamp are hidden from the chart.
  - Open trades show only the stop-loss steps and excursion metrics reached up to that point.
  - Exit prices, final PnL, and closing markers stay hidden until the replay cursor reaches the trade's exit timestamp.

### Real-Time Event Streaming & Concurrency

For live monitoring and bot integration:

- **Broadcast Event Bus**: A Tokio broadcast channel distributes incoming `MarketEvent` messages to active WebSocket connections.
- **Backpressure Handling**: If a client falls behind the event rate, the client loop catches `RecvError::Lagged(n)` and logs the skipped count without dropping the connection.
- **Bi-Directional Channel**: Clients receive live ticks, bars, and risk adjustments from the server or push `MarketEvent` payloads directly to the event bus over `/ws/stream` (requires `--allow-ws-publish`).

### Frontend Architecture & Canvas Overlays

The browser terminal (`web/src/`) is written in strict TypeScript without UI framework overhead:

- Uses Lightweight Charts v4 to render candlestick and volume series, with native line series for stepped trailing stop paths and series markers for trade entries and exits.
- An HTML5 canvas overlay supports user drawings (trendlines, rays, horizontal and vertical levels, Fibonacci retracements, position risk/reward brackets, price/time boxes, and measurement rulers). A magnet toggle snaps points directly to bar OHLC values.
- Client-side resampling aggregates base bars into 20 higher timeframes (1m to 1M) without requesting new data from the server.

---

## Key Features

| Category | Capability | Description |
| :--- | :--- | :--- |
| **Ingestion** | Multi-Format Ingestion | Apache Parquet, SQLite, CSV, JSON, and JSONL data sources. |
| | Auto Timestamp Detection | Normalizes seconds, milliseconds, microseconds, and nanoseconds to UTC seconds. |
| | Strict Data Integrity | Validates finite values, positive volume, OHLC integrity, and chronological ordering. |
| **Replay Engine** | Step-by-Step Playback | Play, pause, step forward/backward, and scrub along the full session timeline. |
| | Discrete Speeds | Configurable speed steps from `1x` to `100x`. |
| | Ghost Execution Mode | Hides future bars and trade exits during session review. |
| **Visualizer** | Dense Terminal Layout | 3-column / 3-row grid with responsive drawers, popups, and bottom sheet ledger. |
| | Multi-Timeframe Resampling | Real-time bar aggregation across 20 timeframes (1m to 1M) without backend roundtrips. |
| | Dynamic Drawing Suite | Trendlines, rays, levels, Fibonacci retracements, position brackets, and measurement tools. |
| | OHLC Magnet Snap | Locks drawing control points to exact bar open, high, low, or close prices. |
| | Bar Close Countdown | Displays real-time countdown timer to the completion of the active candle in live sessions. |
| **Analytics** | Risk Lifecycle Overlays | Visualizes entry arrows, exit markers, take-profit levels, and stepped stop-loss paths. |
| | Excursion Tracking | Visualizes per-trade Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE). |
| | Performance Metrics | Net PnL, Win Rate, Profit Factor, Expected Payoff, Average R, Drawdown, and fee accounting. |
| | Interactive Trade Ledger | Tabbed trade ledger (Positions, Closed Trades, Signals) with in-cell R-multiple micro-bars. |
| **Deployment** | Standalone Binary | Bakes frontend web distribution into the Rust binary using `rust-embed`. |
| | Live Daemon Streaming | WebSocket streaming interface (`/ws/stream`) for live algorithmic trading feeds. |
| | Library Embedding | Directly embeddable into host Rust binaries via `markout::serve`. |

---

## Repository Structure

```text
markout/
├── Cargo.toml                # Rust package manifest and dependencies
├── Cargo.lock                # Deterministic dependency lockfile
├── LICENSE                   # MIT License specification
├── README.md                 # Project documentation and architectural reference
├── CONTRIBUTING.md           # Contribution guidelines and coding conventions
├── examples/                 # Sample datasets for testing and verification
│   ├── bars.csv              # Benchmark OHLCV candlestick data
│   └── trades.jsonl          # Benchmark trade lifecycle logs with stop paths
├── src/                      # Backend Rust implementation
│   ├── main.rs               # Binary entry point and CLI initialization
│   ├── lib.rs                # Library interface, engine exports, and serve routines
│   ├── config.rs             # CLI argument parsing and runtime configuration
│   ├── event_bus.rs          # MarketEvent definitions and Tokio broadcast bus
│   ├── replay.rs             # In-memory replay state machine and speed controls
│   ├── server.rs             # Axum HTTP router, WebSocket stream, and static assets
│   ├── stats.rs              # Aggregate performance metrics (PnL, Win Rate, Profit Factor, Drawdown)
│   ├── models/               # Domain data models
│   │   ├── mod.rs            # Re-exports for bar, trade, and signal structures
│   │   ├── bar.rs            # Bar and Tick definitions
│   │   ├── signal.rs         # Strategy signal definitions and direction enums
│   │   └── trade.rs          # Trade, StopPoint, Side, and ExitReason definitions
│   └── ingestion/            # File parsers and data normalizers
│       ├── mod.rs            # Ingestion orchestrator, Dataset loader, and validators
│       ├── ohlcv.rs          # CSV OHLCV bar loader and directory scanner
│       ├── parquet.rs        # Apache Parquet reader for bars and trade logs
│       ├── sqlite.rs         # SQLite table parser for bars and trades
│       ├── json.rs           # JSON array and JSONL trade log parser
│       └── signal.rs         # Strategy signal parser
└── web/                      # Embedded frontend web application
    ├── package.json          # Node.js dependencies and build scripts
    ├── tsconfig.json         # TypeScript compiler configuration
    ├── vite.config.ts        # Vite bundling and development server configuration
    ├── index.html            # SPA entry point
    ├── src/                  # Frontend TypeScript source code
    │   ├── main.ts           # Application bootstrap and layout coordinator
    │   ├── chart.ts          # Lightweight Charts integration and series manager
    │   ├── types.ts          # TypeScript type definitions matching backend models
    │   ├── api.ts            # REST client and WebSocket connection lifecycle
    │   ├── dom.ts            # DOM utility helpers and element queries
    │   ├── format.ts         # Numeric, currency, and timestamp formatting
    │   ├── resample.ts       # Client-side candle resampling engine
    │   ├── stats.ts          # Client-side metrics calculator
    │   ├── theme.ts          # Dark product terminal color scheme constants
    │   ├── styles.css        # Layout grid, terminal controls, and widget styles
    │   ├── drawings/         # Drawing tools (trendlines, fibonacci, position, etc.)
    │   ├── overlays/         # Chart overlay layers (signals, markers, stop paths)
    │   ├── replay/           # Replay controller and ghost mode masking logic
    │   └── ui/               # Header, toolbar, trade ledger, and dialog components
    └── test/                 # Frontend unit tests
```

---

## Prerequisites & Installation

### Install via Cargo

```bash
cargo install markout-app
```

### Building from Source

To compile `markout` into a standalone binary embedding the web UI, install the standard Rust toolchain (1.88+) and Node.js (22+).

```bash
# 1. Clone the repository
git clone https://github.com/0xbarss/markout.git
cd markout

# 2. Build the frontend distribution (outputs to web/dist/)
cd web
npm install
npm run build
cd ..

# 3. Compile the release binary
cargo build --release

# The compiled binary is available at target/release/markout
./target/release/markout --help
```

### Development Workflow

For active frontend or backend development, run the server and the Vite proxy concurrently:

```bash
# Terminal 1: Run the backend with sample data
cargo run -- --bars examples/bars.csv --trades examples/trades.jsonl

# Terminal 2: Run the Vite development server with hot module reloading
cd web
npm install
npm run dev
```

The Vite dev server runs at `http://localhost:5173` and proxies API requests (`/api/*`) and WebSocket connections (`/ws/*`) to the backend listening on port `8080`.

---

## Usage & Code Examples

### 1. Offline Session Review

To review historical executions, provide the paths to your candlestick data and trade logs:

```bash
# Load Apache Parquet datasets
markout --trades ./data/trades.parquet --bars ./data/bars.parquet

# Load CSV bars with JSONL trade logs
markout --bars ./data/bars.csv --trades ./data/trades.jsonl

# Load SQLite database containing 'bars' and 'trades' tables
markout --trades ./data/trading_session.sqlite

# Ingest strategy signal logs alongside trades and bars
markout \
  --bars ./data/bars.parquet \
  --trades ./data/trades.parquet \
  --strategy ./data/signals.jsonl \
  --host 127.0.0.1 \
  --port 8080
```

Open `http://127.0.0.1:8080` in your web browser.

#### Keyboard Shortcuts

- `Space`: Toggle replay playback (Play / Pause).
- `←`: Step backward one candle.
- `→`: Step forward one candle.
- `R`: Reset playback to the beginning of the session.

### 2. Live Monitoring Daemon

Run `markout` as a real-time event streaming daemon:

```bash
markout live --host 0.0.0.0 --port 8080
```

In this mode, the server initializes with an empty dataset and waits for events emitted across WebSocket clients or published through library hooks.

### 3. Replay Streaming Daemon

Stream historical market data to the live UI and WebSocket subscribers using the backend replay engine:

```bash
markout replay --bars ./data/bars.csv --speed 10 --tf 1m
```

### 4. Embedding as a Rust Library

You can embed `markout` directly into proprietary trading execution engines or backtesting frameworks:

Add `markout-app` to your `Cargo.toml`:

```toml
[dependencies]
markout-app = "1.0"
tokio = { version = "1", features = ["full"] }
```

Initialize the event bus, launch the server asynchronously, and push events:

```rust
use markout::{Config, EventBus, MarketEvent, Mode};
use markout::models::{Bar, Trade, TradeSide, ExitReason};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bus = EventBus::default();
    let config = Config {
        host: "127.0.0.1".into(),
        port: 8080,
        mode: Mode::Live {
            feed: None,
            symbol: Some("BTCUSDT".into()),
            tf: Some("1m".into()),
        },
        ..Default::default()
    };

    let server_bus = bus.clone();
    tokio::spawn(async move {
        if let Err(e) = markout::serve(config, server_bus).await {
            eprintln!("Server terminated: {e}");
        }
    });

    // Publish market events from your trading strategy loop
    bus.publish(MarketEvent::Bar(Bar {
        time: 1700000000,
        open: 65000.0,
        high: 65200.0,
        low: 64950.0,
        close: 65150.0,
        volume: 120.5,
    }));

    // Keep host process alive
    tokio::signal::ctrl_c().await?;
    Ok(())
}
```

### 5. Streaming Events via WebSocket

External processes (such as Python backtest harnesses or MT5 scripts) can push and consume real-time market data via `/ws/stream` (launch `markout` with `--allow-ws-publish` to accept inbound event injection):

```python
import json
import websocket

def on_open(ws):
    # Publish a live bar update
    event = {
        "type": "bar",
        "data": {
            "time": 1700000060,
            "open": 65150.0,
            "high": 65300.0,
            "low": 65100.0,
            "close": 65280.0,
            "volume": 85.2
        }
    }
    ws.send(json.dumps(event))

def on_message(ws, message):
    data = json.loads(message)
    print(f"Received market event: {data['type']}")

ws = websocket.WebSocketApp(
    "ws://127.0.0.1:8080/ws/stream",
    on_open=on_open,
    on_message=on_message
)
ws.run_forever()
```

---

## API Reference & Data Contracts

### Command-Line Interface

```text
markout [OPTIONS] [COMMAND]

Commands:
  live      Run the real-time event streaming daemon
  replay    Replay historical bars to the WebSocket stream at a chosen speed multiplier
  help      Print this message or the help of the given subcommand(s)

Options:
      --host <HOST>          Interface to bind [default: 127.0.0.1]
      --port <PORT>          Port to listen on [default: 8080]
      --trades <PATH>        Trades database or log file (alias: --db)
      --bars <PATH>          Bars file or directory (CSV, Parquet, or SQLite)
      --strategy <PATH>      Strategy signals log file (JSONL, JSON, CSV, SQLite, or Parquet)
      --allow-host <HOST>    Allowed Host header values (can be repeated)
      --allow-origin <ORIGIN> Allowed WebSocket Origin values (can be repeated)
      --allow-ws-publish     Allow clients to publish MarketEvent frames over WebSocket
  -h, --help                 Print help
  -V, --version              Print version
```

### HTTP Endpoints

| Endpoint | Method | Response Type | Description |
| :--- | :--- | :--- | :--- |
| `/api/v1/health` | `GET` | `JSON` | Returns service status, version, and active execution mode (`offline` or `live`). |
| `/api/v1/bars` | `GET` | `JSON Array` | Ingested OHLCV candlestick records ordered ascending by timestamp. |
| `/api/v1/trades` | `GET` | `JSON Array` | Ingested trade lifecycle records with stop-loss history and excursions. |
| `/api/v1/signals` | `GET` | `JSON Array` | Emitted strategy signal markers. |
| `/api/v1/stats` | `GET` | `JSON Object` | Summary performance metrics computed over all closed trades. |
| `/ws/stream` | `GET` (WS) | `WebSocket` | Bi-directional JSON stream of `MarketEvent` frames. |

### WebSocket Streaming Protocol

All frames exchanged over `/ws/stream` adhere to the tagged `MarketEvent` schema:

```json
// Bar event
{
  "type": "bar",
  "data": {
    "time": 1700000000,
    "open": 100.0,
    "high": 105.0,
    "low": 99.5,
    "close": 104.2,
    "volume": 1500.0
  }
}

// Tick quote event
{
  "type": "tick",
  "data": {
    "symbol": "EURUSD",
    "time": 1700000001,
    "price": 1.08502,
    "bid": 1.08501,
    "ask": 1.08503
  }
}

// Risk bracket adjustment event
{
  "type": "risk_bracket",
  "data": {
    "trade_id": 42,
    "stop_loss": 99.8,
    "take_profit": 108.0,
    "timestamp": 1700000120
  }
}
```

### Supported Input Formats & Schemas

#### 1. Candlestick Bars (`--bars`)

- **Apache Parquet (`.parquet`)**: Arrow schema with columns:
  - `time` (`Int64` or `Timestamp`)
  - `open`, `high`, `low`, `close` (`Float64` or `Float32`)
  - `volume` (`Float64` or `Float32`, optional, defaults to `0.0`)
- **CSV (`.csv`)**: Header row with case-insensitive column names:
  ```csv
  time,open,high,low,close,volume
  1700000000,100.5,102.0,99.8,101.2,500
  ```
- **SQLite Database**: Table named `bars` containing columns `time`, `open`, `high`, `low`, `close`, and `volume`.

#### 2. Trade Logs (`--trades` or `--db`)

- **Apache Parquet (`.parquet`)**: Columns `id`, `symbol`, `direction`, `size`, `entry_time`, `entry_price`, `exit_time`, `exit_price`, `exit_reason`, `initial_sl`, `take_profit`, `pnl`, `r_multiple`, `fee`, `mae_pct`, `mfe_pct`.
- **JSON Lines (`.jsonl`, `.ndjson`)**: One JSON object per line conforming to the `Trade` model:
  ```json
  {
    "id": 101,
    "symbol": "BTCUSDT",
    "direction": "buy",
    "size": 0.5,
    "entry_time": 1700000000,
    "entry_price": 65000.0,
    "exit_time": 1700003600,
    "exit_price": 66200.0,
    "exit_reason": "take_profit",
    "initial_sl": 64200.0,
    "take_profit": 66200.0,
    "sl_history": [
      { "time": 1700001200, "price": 64600.0 },
      { "time": 1700002400, "price": 65200.0 }
    ],
    "pnl": 600.0,
    "r_multiple": 1.5,
    "fee": 6.5,
    "mae_pct": -0.45,
    "mfe_pct": 1.95
  }
  ```
- **SQLite Database**: Table named `trades` with corresponding columns.

#### 3. Strategy Signals (`--strategy`)

Supports JSON Lines (`.jsonl`), JSON (`.json`), CSV (`.csv`), SQLite (`.sqlite`), and Parquet (`.parquet`).

- **Signal Schema (`.jsonl`)**:
  ```json
  {
    "id": "sig-001",
    "time": 1700000000,
    "direction": "buy",
    "entry_price": 65000.0,
    "stop_loss": 64200.0,
    "take_profit": 66200.0,
    "strategy": "EMA Breakout",
    "comment": "20/50 cross"
  }
  ```

Accepted field and column aliases:
- `time`: `timestamp`
- `direction`: `action`, `side`, `signal` (values: `buy`/`long`, `sell`/`short`, `hold`/`neutral`)
- `entry_price`: `price`, `entry`
- `stop_loss`: `sl`, `initial_sl` (defaults to `0.0` if omitted)
- `take_profit`: `tp` (defaults to `0.0` if omitted)
- `strategy`: `name`
- `comment`: `note`, `notes`

---

## Testing & Quality Assurance

### Rust Test Suite

The backend test suite covers ingestion validation, deduplication, error handling, stats calculation, replay state progression, and HTTP routes.

Run the test suite via `cargo test`:

```bash
# Run all tests
cargo test

# Run tests with output logging
cargo test -- --nocapture

# Run clippy and format checks
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Key test areas:
- **Ingestion tests**: Tests CSV, JSON, Parquet, and SQLite loaders across `src/ingestion/` modules and `tests/` integration suites against malformed rows, timestamp scaling variations, out-of-order candles, and duplicate bar timestamps.
- **`replay::tests`**: Tests discrete speed multiplier transitions, candle-by-candle stepping, and boundary conditions.
- **`stats::tests`**: Validates win rate, net PnL, profit factor, expected payoff, average R, and drawdown calculations.
- **`server::tests`**: Integration tests checking Axum HTTP routing, JSON serialization, and fallback handlers.

### Frontend Unit Tests

The frontend overlay and calculation tests run directly on Node.js using the built-in test runner:

```bash
cd web
npm test
```

Verifies:
- Numeric coordinate mapping and canvas scaling.
- Candle aggregation and timeframe resampling algorithms.
- Ghost mode masking logic across varying playback cursor indices.

---

## Troubleshooting & FAQ

### 1. Embedded assets not found during compilation

**Problem**: `cargo build` fails with an error referencing missing files in `web/dist/`.

**Cause**: The Rust binary uses `rust-embed` to bake frontend assets into the binary at compile time. If `web/dist/` has not been generated, the compiler cannot find the asset folder.

**Solution**: Build the frontend bundle before compiling the Rust binary:
```bash
cd web && npm install && npm run build && cd ..
cargo build --release
```

### 2. Timestamps appear distorted or far in the future

**Problem**: Candlesticks render compressed or timestamps display erroneous years.

**Cause**: Dataset timestamps are encoded in an unexpected unit (such as seconds supplied to a millisecond-only parser).

**Solution**: `markout` automatically detects magnitude thresholds:
- Values `< 10^11` are treated as seconds.
- Values `>= 10^11` and `< 10^14` are divided by `1,000` (milliseconds).
- Values `>= 10^14` and `< 10^17` are divided by `1,000,000` (microseconds).
- Values `>= 10^17` are divided by `1,000,000,000` (nanoseconds).
Verify that your dataset timestamps represent valid UTC Unix epochs.

### 3. Error: `invalid bar at row N: open/close outside the high-low range`

**Problem**: Ingestion terminates with an invalid bar error.

**Cause**: Defensive checks detected a candlestick where `open > high`, `close > high`, `open < low`, or `close < low`.

**Solution**: Inspect the source row identified in the error message. Ensure prices are uncorrupted before ingestion.

### 4. WebSocket client lagging warnings

**Problem**: Server logs emit `ws client lagged, skipped N events`.

**Cause**: Downstream consumers are processing slower than the ingestion or playback stream emission rate, causing the broadcast buffer capacity to cycle before frames are drained.

**Solution**: Increase consumer processing efficiency, reduce playback speed multiplier, or consume via streaming batches.

---

## Author & Contributions

Created and maintained by **0xbarss** ([@0xbarss](https://github.com/0xbarss)).

Issues and feature requests are tracked on the [GitHub Issue Tracker](https://github.com/0xbarss/markout/issues). Contributions adhering to the repository coding style and architectural guidelines are welcome via pull requests (see [CONTRIBUTING.md](CONTRIBUTING.md) for full conventions and verification procedures).

---

## License & Disclaimer

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for full details.

### Operational Disclaimer

`markout` is an analytical visualization and data inspection tool. It does not provide financial, investment, or trading advice. Past simulation performance, backtest metrics, and excursion analytics do not guarantee future market results. Always verify execution algorithms and risk controls in simulated environments before committing capital.
