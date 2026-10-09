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

fn load_dataset_for_config(config: &Config) -> anyhow::Result<Dataset> {
    match &config.mode {
        Mode::Offline {
            trades,
            bars,
            strategy,
        } => Ok(Dataset::load_opts(
            trades.as_deref(),
            bars.as_deref(),
            strategy.as_deref(),
            config.lenient,
        )?),
        Mode::Live { .. } => Ok(Dataset::default()),
        Mode::Replay { bars, .. } => Ok(Dataset::load_opts(
            None,
            Some(bars.as_path()),
            None,
            config.lenient,
        )?),
    }
}

/// Load the configured offline data (none in live mode), then start the server.
/// Resolves on Ctrl-C or SIGTERM.
pub async fn serve(config: Config, bus: EventBus) -> anyhow::Result<()> {
    let data = load_dataset_for_config(&config)?;
    tracing::info!(
        "loaded {} bars, {} trades, {} strategy signals",
        data.bars.len(),
        data.trades.len(),
        data.signals.len()
    );
    server::run(config, bus, data).await
}

/// Load the configured offline data and start the server with a caller-supplied shutdown future.
pub async fn serve_with_shutdown<F>(
    config: Config,
    bus: EventBus,
    shutdown: F,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let data = load_dataset_for_config(&config)?;
    tracing::info!(
        "loaded {} bars, {} trades, {} strategy signals",
        data.bars.len(),
        data.trades.len(),
        data.signals.len()
    );
    server::run_with_shutdown(config, bus, data, shutdown).await
}

/// Start the server with caller-provided data (for embedding).
pub async fn serve_with_data(config: Config, bus: EventBus, data: Dataset) -> anyhow::Result<()> {
    server::run(config, bus, data).await
}

/// Start the server with caller-provided data and a caller-supplied shutdown future (for embedding).
pub async fn serve_with_data_and_shutdown<F>(
    config: Config,
    bus: EventBus,
    data: Dataset,
    shutdown: F,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    server::run_with_shutdown(config, bus, data, shutdown).await
}
