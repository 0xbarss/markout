# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-09

### Added
- **Security Hardening**:
  - Enforce Host header validation (`--allow-host`) and strict WebSocket Origin checking (`--allow-origin`).
  - Opt-in WebSocket client event publishing (`--allow-ws-publish`) with schema validation.
  - Security headers added to all HTTP responses: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
  - Prefix routing isolation ensuring non-existent `/api*` and `/ws*` endpoints immediately return 404.
  - Support for hostname (`localhost`) and IPv6 address resolution in `--host`.
- **Replay Subcommand & Engine Synchronization**:
  - Added dedicated `replay` subcommand (`markout replay --bars <PATH> --speed <N>`).
  - Server-driven candle-by-candle playback streaming over WebSocket with bidirectional client sync.
  - High-precision accumulator using `performance.now()` preventing drift at 50x/100x playback speeds.
- **Live Streaming State Snapshot**:
  - Dynamic in-memory ring-buffered state snapshot for late-joining browsers.
  - Real-time candle aggregation and dynamic median base interval calculation from streaming ticks.
  - MetaTrader 5 bridge integration tested end-to-end via IPC named pipe.
- **Drawing Tools Suite**:
  - Full financial charting toolset: Trendline, Horizontal Line, Ray, Fibonacci Retracements, Date/Price Measure, Text Annotation, and Long/Short Position risk-reward boxes.
  - Non-destructive dialog edits, lazy undo history, magnetic OHLC snapping, and versioned `localStorage` persistence.
- **Ingestion & Data Format Expansions**:
  - Full Apache Parquet support: categorical dictionary arrays, `LargeUtf8` / `Utf8View` string arrays, and Parquet strategy signals.
  - SQLite dynamic column mapping, type-tolerant numeric parsing, and typed error reporting (`InvalidSignal`, `InvalidTrade`).
  - Universal timestamp parser supporting RFC 3339 strings, seconds, milliseconds, microseconds, and nanoseconds.
  - Case-insensitive CSV column detection and optional bar volume defaulting.
- **Performance Optimizations**:
  - Transparent gzip HTTP compression via `tower-http` on all REST endpoints and static assets.
  - Pre-serialized immutable JSON payloads for cached bars and trade queries.
  - $O(1)$ timestamp-to-index binary search locator (`locate` / `barIndexAt`).
  - Open trades overlay lane capping (8-lane pool trimming) preventing UI lag during high concurrent order density.
- **Analytics & UX**:
  - Calendar-aligned weekly (Monday 00:00 UTC) and monthly timeframe resampling.
  - Strict profit factor and win-rate accounting parity with cross-language regression test fixtures.
  - Sparkline numeric rendering optimization preventing call-stack overflows on 100k+ trades.
  - Graceful SIGTERM and caller-provided async shutdown support across all server runtimes.

### Changed
- Standardized minimum supported Rust version (MSRV) to 1.88.
- Upgraded web runtime target to Node.js `>=22.18`.
- Anchored package include globs to prevent local `node_modules` pollution in release packages.
- Zero explicit TypeScript `any` annotations across the web application.

## [1.0.0] - 2026-10-02

### Added
- Initial public release of `markout-app`.
- Interactive candlestick chart powered by Lightweight Charts.
- Embedded Axum web server and Tokio event broadcast bus.
- Multi-format ingestion for CSV, JSONL, Parquet, and SQLite.
- Ghost mode simulation and trade trail visualizer.
