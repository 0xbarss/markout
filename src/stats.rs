//! Summary statistics over closed trades.

use serde::{Deserialize, Serialize};

use crate::models::Trade;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Stats {
    pub total_trades: usize,
    pub open_trades: usize,
    pub closed_trades: usize,
    pub wins: usize,
    pub losses: usize,
    /// Fraction of closed trades with positive PnL (pnl > 0), in 0.0..=1.0.
    /// Breakeven trades (pnl == 0) are in neither wins nor losses, so win_rate + loss_rate <= 1.0.
    pub win_rate: f64,
    /// Sum of net realized PnL over closed trades (after fees).
    pub net_pnl: f64,
    pub total_fees: f64,
    pub avg_r: f64,
    /// Largest peak-to-trough drop of cumulative realized PnL, in currency units.
    pub max_drawdown: f64,
    /// Gross profit / gross loss over closed trades; None when there are no losing trades.
    pub profit_factor: Option<f64>,
}

pub fn compute(trades: &[Trade]) -> Stats {
    let mut closed: Vec<&Trade> = trades.iter().filter(|t| t.exit_time.is_some()).collect();
    closed.sort_by_key(|t| (t.exit_time, t.id));

    let n = closed.len();
    let (mut cum, mut peak, mut max_dd) = (0.0_f64, 0.0_f64, 0.0_f64);
    for t in &closed {
        cum += t.pnl;
        peak = peak.max(cum);
        max_dd = max_dd.max(peak - cum);
    }
    let wins = closed.iter().filter(|t| t.pnl > 0.0).count();
    let losses = closed.iter().filter(|t| t.pnl < 0.0).count();
    let gross_win: f64 = closed.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).sum();
    let gross_loss: f64 = closed.iter().filter(|t| t.pnl < 0.0).map(|t| -t.pnl).sum();
    let profit_factor = if gross_loss > 0.0 {
        Some(gross_win / gross_loss)
    } else {
        None
    };

    Stats {
        total_trades: trades.len(),
        open_trades: trades.len() - n,
        closed_trades: n,
        wins,
        losses,
        win_rate: if n > 0 { wins as f64 / n as f64 } else { 0.0 },
        net_pnl: closed.iter().map(|t| t.pnl).sum(),
        total_fees: closed.iter().map(|t| t.fee).sum(),
        avg_r: if n > 0 {
            closed.iter().map(|t| t.r_multiple).sum::<f64>() / n as f64
        } else {
            0.0
        },
        max_drawdown: max_dd,
        profit_factor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TradeSide;

    fn trade(id: u64, exit: Option<i64>, pnl: f64, r: f64) -> Trade {
        Trade {
            id,
            symbol: "X".into(),
            direction: TradeSide::Buy,
            size: 1.0,
            entry_time: 1,
            entry_price: 100.0,
            exit_time: exit,
            exit_price: exit.map(|_| 100.0),
            exit_reason: None,
            initial_sl: 95.0,
            take_profit: None,
            sl_history: vec![],
            pnl,
            r_multiple: r,
            fee: 1.0,
            mae_pct: None,
            mfe_pct: None,
        }
    }

    #[test]
    fn empty_is_all_zero() {
        assert_eq!(compute(&[]), Stats::default());
    }

    #[test]
    fn drawdown_and_counts() {
        let trades = [
            trade(1, Some(10), 100.0, 2.0),
            trade(2, Some(20), -50.0, -1.0),
            trade(3, Some(30), -80.0, -1.0),
            trade(4, None, 999.0, 9.0), // open: ignored in PnL stats
        ];
        let s = compute(&trades);
        assert_eq!((s.total_trades, s.open_trades, s.closed_trades), (4, 1, 3));
        assert_eq!((s.wins, s.losses), (1, 2));
        assert_eq!(s.net_pnl, -30.0);
        assert_eq!(s.max_drawdown, 130.0);
        assert!((s.win_rate - 1.0 / 3.0).abs() < 1e-12);
        assert_eq!(s.total_fees, 3.0);
        assert_eq!(s.profit_factor, Some(100.0 / 130.0));
    }

    #[derive(Deserialize)]
    struct StatsTestCase {
        name: String,
        trades: Vec<Trade>,
        expected: Stats,
    }

    #[test]
    fn cross_language_stats_parity_fixtures() {
        let fixture_data = include_str!("../tests/fixtures/stats_cases.json");
        let cases: Vec<StatsTestCase> = serde_json::from_str(fixture_data).unwrap();
        assert!(!cases.is_empty());

        for tc in cases {
            let actual = compute(&tc.trades);
            assert_eq!(
                actual.total_trades, tc.expected.total_trades,
                "{}: total_trades",
                tc.name
            );
            assert_eq!(
                actual.open_trades, tc.expected.open_trades,
                "{}: open_trades",
                tc.name
            );
            assert_eq!(
                actual.closed_trades, tc.expected.closed_trades,
                "{}: closed_trades",
                tc.name
            );
            assert_eq!(actual.wins, tc.expected.wins, "{}: wins", tc.name);
            assert_eq!(actual.losses, tc.expected.losses, "{}: losses", tc.name);
            assert!(
                (actual.win_rate - tc.expected.win_rate).abs() < 1e-9,
                "{}: win_rate expected {} got {}",
                tc.name,
                tc.expected.win_rate,
                actual.win_rate
            );
            assert!(
                (actual.net_pnl - tc.expected.net_pnl).abs() < 1e-9,
                "{}: net_pnl expected {} got {}",
                tc.name,
                tc.expected.net_pnl,
                actual.net_pnl
            );
            assert!(
                (actual.total_fees - tc.expected.total_fees).abs() < 1e-9,
                "{}: total_fees expected {} got {}",
                tc.name,
                tc.expected.total_fees,
                actual.total_fees
            );
            assert!(
                (actual.avg_r - tc.expected.avg_r).abs() < 1e-9,
                "{}: avg_r expected {} got {}",
                tc.name,
                tc.expected.avg_r,
                actual.avg_r
            );
            assert!(
                (actual.max_drawdown - tc.expected.max_drawdown).abs() < 1e-9,
                "{}: max_drawdown expected {} got {}",
                tc.name,
                tc.expected.max_drawdown,
                actual.max_drawdown
            );
            match (actual.profit_factor, tc.expected.profit_factor) {
                (Some(a), Some(e)) => assert!(
                    (a - e).abs() < 1e-9,
                    "{}: profit_factor expected {} got {}",
                    tc.name,
                    e,
                    a
                ),
                (None, None) => {}
                _ => panic!(
                    "{}: profit_factor mismatch: actual {:?}, expected {:?}",
                    tc.name, actual.profit_factor, tc.expected.profit_factor
                ),
            }
        }
    }
}
