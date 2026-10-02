use clap::Parser;
use markout::{Cli, Config, EventBus};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "markout=info,tower_http=info".into()),
        )
        .init();

    let config: Config = Cli::parse().into();
    markout::serve(config, EventBus::default()).await
}
