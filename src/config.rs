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

    /// Allow lenient parsing for trade files (e.g. Parquet defaults).
    #[arg(long = "lenient", global = true)]
    pub lenient: bool,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the real-time event streaming daemon.
    Live(LiveArgs),
    /// Replay historical bars to the WebSocket stream at a chosen speed multiplier.
    Replay(ReplayArgs),
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

#[derive(Debug, Args)]
pub struct ReplayArgs {
    /// Bars file or directory to replay.
    #[arg(long)]
    pub bars: PathBuf,
    /// Playback speed multiplier (1, 2, 5, 10, 20, 50, 100).
    #[arg(long, default_value_t = 10)]
    pub speed: u32,
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
    Replay {
        bars: PathBuf,
        speed: u32,
        tf: Option<String>,
    },
}

impl Mode {
    pub fn name(&self) -> &'static str {
        match self {
            Mode::Offline { .. } => "offline",
            Mode::Live { .. } => "live",
            Mode::Replay { .. } => "replay",
        }
    }
}

/// Parse a timeframe string into seconds (e.g. "15m" -> 900, "1h" -> 3600, "60" -> 60).
pub fn parse_timeframe_sec(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(sec) = s.parse::<u64>() {
        return if sec > 0 { Some(sec) } else { None };
    }
    let num_end = s.find(|c: char| !c.is_ascii_digit())?;
    let (num_part, unit_part) = s.split_at(num_end);
    let n: u64 = num_part.parse().ok()?;
    let mult = match unit_part {
        "s" | "S" => 1,
        "m" => 60,
        "h" | "H" => 3600,
        "d" | "D" => 86400,
        "w" | "W" => 604800,
        "M" => 2592000,
        _ => return None,
    };
    Some(n.saturating_mul(mult))
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
    pub lenient: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            host: "127.0.0.1".into(),
            port: 8080,
            mode: Mode::Offline {
                trades: None,
                bars: None,
                strategy: None,
            },
            allow_hosts: Vec::new(),
            allow_origins: Vec::new(),
            allow_ws_publish: false,
            lenient: false,
        }
    }
}

impl From<Cli> for Config {
    fn from(cli: Cli) -> Self {
        let mode = match cli.command {
            Some(Command::Live(l)) => Mode::Live {
                feed: l.feed,
                symbol: l.symbol,
                tf: l.tf,
            },
            Some(Command::Replay(r)) => Mode::Replay {
                bars: r.bars,
                speed: r.speed,
                tf: r.tf,
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
            lenient: cli.lenient,
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
    fn replay_subcommand_parsed() {
        let c = parse(&[
            "replay",
            "--bars",
            "./bars.csv",
            "--speed",
            "20",
            "--tf",
            "5m",
        ]);
        assert_eq!(
            c.mode,
            Mode::Replay {
                bars: PathBuf::from("./bars.csv"),
                speed: 20,
                tf: Some("5m".into()),
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

    #[test]
    fn parse_timeframe_seconds() {
        assert_eq!(parse_timeframe_sec("60"), Some(60));
        assert_eq!(parse_timeframe_sec("15m"), Some(900));
        assert_eq!(parse_timeframe_sec("1h"), Some(3600));
        assert_eq!(parse_timeframe_sec("1D"), Some(86400));
        assert_eq!(parse_timeframe_sec("1W"), Some(604800));
        assert_eq!(parse_timeframe_sec("1M"), Some(2592000));
        assert_eq!(parse_timeframe_sec("invalid"), None);
        assert_eq!(parse_timeframe_sec("0"), None);
        assert_eq!(parse_timeframe_sec(""), None);
    }
}
