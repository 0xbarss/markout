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

    /// Trades database or log file (offline review).
    #[arg(long, alias = "db")]
    pub trades: Option<PathBuf>,

    /// Bars file or directory (offline review).
    #[arg(long)]
    pub bars: Option<PathBuf>,

    /// Strategy signals file (offline review).
    #[arg(long)]
    pub strategy: Option<PathBuf>,

    /// Allowed Host header values (can be repeated).
    #[arg(long = "allow-host", global = true)]
    pub allow_host: Vec<String>,

    /// Allowed WebSocket Origin values (can be repeated).
    #[arg(long = "allow-origin", global = true)]
    pub allow_origin: Vec<String>,

    /// Allow clients to publish MarketEvent frames over WebSocket.
    #[arg(long = "allow-ws-publish", global = true)]
    pub allow_ws_publish: bool,

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
        trades: Option<PathBuf>,
        bars: Option<PathBuf>,
        strategy: Option<PathBuf>,
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
    pub allow_hosts: Vec<String>,
    pub allow_origins: Vec<String>,
    pub allow_ws_publish: bool,
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
                trades: cli.trades,
                bars: cli.bars,
                strategy: cli.strategy,
            },
        };
        Config {
            host: cli.host,
            port: cli.port,
            mode,
            allow_hosts: cli.allow_host,
            allow_origins: cli.allow_origin,
            allow_ws_publish: cli.allow_ws_publish,
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
        let c = parse(&[
            "--trades",
            "t.sqlite",
            "--bars",
            "./bars",
            "--strategy",
            "./signals.jsonl",
        ]);
        assert_eq!(c.port, 8080);
        assert_eq!(
            c.mode,
            Mode::Offline {
                trades: Some("t.sqlite".into()),
                bars: Some("./bars".into()),
                strategy: Some("./signals.jsonl".into()),
            }
        );

        // Verify --db alias works as well
        let c_alias = parse(&["--db", "t.sqlite", "--bars", "./bars"]);
        assert_eq!(
            c_alias.mode,
            Mode::Offline {
                trades: Some("t.sqlite".into()),
                bars: Some("./bars".into()),
                strategy: None,
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

    #[test]
    fn security_flags_parsed() {
        let c = parse(&[
            "--allow-host",
            "example.com",
            "--allow-host",
            "192.168.1.50",
            "--allow-origin",
            "https://app.example.com",
            "--allow-ws-publish",
        ]);
        assert_eq!(c.allow_hosts, vec!["example.com", "192.168.1.50"]);
        assert_eq!(c.allow_origins, vec!["https://app.example.com"]);
        assert!(c.allow_ws_publish);
    }
}
