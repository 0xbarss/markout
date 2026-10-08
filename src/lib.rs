//! markout: interactive financial time-series visualizer, replay engine and live monitor.
//!
//! Embed it by creating an [`EventBus`], publishing [`MarketEvent`]s to it,
//! and awaiting [`serve`].

pub mod config;
pub mod event_bus;
pub mod ingestion;
pub mod models;
pub mod replay;
pub mod server;
pub mod stats;

pub use config::{Cli, Config, Mode};
pub use event_bus::{EventBus, MarketEvent};
pub use replay::{ReplayEngine, ReplayError, ReplayStatus, SUPPORTED_SPEEDS};

pub use ingestion::Dataset;

/// Load the configured offline data (none in live mode), then start the server.
/// Resolves on Ctrl-C.
pub async fn serve(config: Config, bus: EventBus) -> anyhow::Result<()> {
    let data = match &config.mode {
        Mode::Offline {
            trades,
            bars,
            strategy,
        } => Dataset::load_opts(
            trades.as_deref(),
            bars.as_deref(),
            strategy.as_deref(),
            config.lenient,
        )?,
        Mode::Live { .. } => Dataset::default(),
        Mode::Replay { bars, .. } => {
            Dataset::load_opts(None, Some(bars.as_path()), None, config.lenient)?
        }
    };
    tracing::info!(
        "loaded {} bars, {} trades, {} strategy signals",
        data.bars.len(),
        data.trades.len(),
        data.signals.len()
    );
    server::run(config, bus, data).await
}

/// Start the server with caller-provided data (for embedding).
pub async fn serve_with_data(config: Config, bus: EventBus, data: Dataset) -> anyhow::Result<()> {
    server::run(config, bus, data).await
}
