use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "markout", version, about)]
pub struct Cli {
    /// Interface to bind.
    #[arg(long, global = true, default_value = "127.0.0.1")]
    pub host: String,

    /// Port to listen on.
    #[arg(long, global = true, default_value_t = 8080)]
    pub port: u16,

    /// Trades database (offline review).
    #[arg(long)]
    pub db: Option<PathBuf>,

    /// Bars file or directory (offline review).
    #[arg(long)]
    pub bars: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the real-time event streaming daemon.
    Live(LiveArgs),
}

#[derive(Debug, Args)]
pub struct LiveArgs {
    /// Optional built-in feed adapter name.
    #[arg(long)]
    pub feed: Option<String>,
    #[arg(long)]
    pub symbol: Option<String>,
    /// Timeframe, e.g. 15m.
    #[arg(long)]
    pub tf: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Offline {
        db: Option<PathBuf>,
        bars: Option<PathBuf>,
    },
    Live {
        feed: Option<String>,
        symbol: Option<String>,
        tf: Option<String>,
    },
}

impl Mode {
    pub fn name(&self) -> &'static str {
        match self {
            Mode::Offline { .. } => "offline",
            Mode::Live { .. } => "live",
        }
    }
}

/// Resolved runtime configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub mode: Mode,
}

impl From<Cli> for Config {
    fn from(cli: Cli) -> Self {
        let mode = match cli.command {
            Some(Command::Live(l)) => Mode::Live {
                feed: l.feed,
                symbol: l.symbol,
                tf: l.tf,
            },
            None => Mode::Offline {
                db: cli.db,
                bars: cli.bars,
            },
        };
        Config {
            host: cli.host,
            port: cli.port,
            mode,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Config {
        Cli::try_parse_from(std::iter::once("markout").chain(args.iter().copied()))
            .unwrap()
            .into()
    }

    #[test]
    fn default_is_offline() {
        let c = parse(&["--db", "t.sqlite", "--bars", "./bars"]);
        assert_eq!(c.port, 8080);
        assert_eq!(
            c.mode,
            Mode::Offline {
                db: Some("t.sqlite".into()),
                bars: Some("./bars".into())
            }
        );
    }

    #[test]
    fn live_subcommand_accepts_port_and_feed() {
        let c = parse(&[
            "live", "--port", "9000", "--feed", "mt5", "--symbol", "EURUSD", "--tf", "15m",
        ]);
        assert_eq!(c.port, 9000);
        assert_eq!(
            c.mode,
            Mode::Live {
                feed: Some("mt5".into()),
                symbol: Some("EURUSD".into()),
                tf: Some("15m".into())
            }
        );
    }
}
