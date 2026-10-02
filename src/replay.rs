use crate::{
    event_bus::{EventBus, MarketEvent},
    models::Bar,
};
use thiserror::Error;

/// Supported speed multipliers for replaying market data.
pub const SUPPORTED_SPEEDS: &[u32] = &[1, 2, 5, 10, 20, 50, 100];

/// Error conditions in replay operations.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReplayError {
    #[error("unsupported speed multiplier {0}x; must be one of {SUPPORTED_SPEEDS:?}")]
    InvalidSpeed(u32),
}

/// Operational state of the replay engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplayStatus {
    #[default]
    Paused,
    Playing,
    Finished,
}

/// In-memory replay state machine over a series of candlesticks.
#[derive(Debug, Clone)]
pub struct ReplayEngine {
    bars: Vec<Bar>,
    cursor: usize,
    status: ReplayStatus,
    speed: u32,
}

impl ReplayEngine {
    /// Initialize a replay engine with a collection of bars, positioned at the start.
    pub fn new(bars: Vec<Bar>) -> Self {
        Self {
            bars,
            cursor: 0,
            status: ReplayStatus::Paused,
            speed: 1,
        }
    }

    /// Initialize a replay engine positioned at the latest bar (for offline inspection).
    pub fn at_end(bars: Vec<Bar>) -> Self {
        let cursor = bars.len().saturating_sub(1);
        Self {
            bars,
            cursor,
            status: ReplayStatus::Paused,
            speed: 1,
        }
    }

    /// Total number of bars in the replay dataset.
    pub fn len(&self) -> usize {
        self.bars.len()
    }

    /// Whether the replay dataset is empty.
    pub fn is_empty(&self) -> bool {
        self.bars.is_empty()
    }

    /// Zero-based index of the current bar cursor.
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Current operational status.
    pub fn status(&self) -> ReplayStatus {
        self.status
    }

    /// Current playback speed multiplier.
    pub fn speed(&self) -> u32 {
        self.speed
    }

    /// Set playback speed multiplier. Must be in [`SUPPORTED_SPEEDS`].
    pub fn set_speed(&mut self, speed: u32) -> Result<(), ReplayError> {
        if !SUPPORTED_SPEEDS.contains(&speed) {
            return Err(ReplayError::InvalidSpeed(speed));
        }
        self.speed = speed;
        Ok(())
    }

    /// Start or resume playback.
    pub fn play(&mut self) {
        if self.bars.is_empty() {
            self.status = ReplayStatus::Finished;
            return;
        }
        if self.cursor >= self.bars.len().saturating_sub(1) {
            self.cursor = 0;
        }
        self.status = ReplayStatus::Playing;
    }

    /// Pause playback.
    pub fn pause(&mut self) {
        if self.status != ReplayStatus::Finished {
            self.status = ReplayStatus::Paused;
        }
    }

    /// Toggle between playing and paused.
    pub fn toggle_play(&mut self) -> ReplayStatus {
        if self.status == ReplayStatus::Playing {
            self.pause();
        } else {
            self.play();
        }
        self.status
    }

    /// Reset playback cursor to the first bar and pause.
    pub fn reset(&mut self) {
        self.cursor = 0;
        self.status = ReplayStatus::Paused;
    }

    /// Jump cursor to the final bar in the dataset.
    pub fn jump_to_end(&mut self) -> Option<&Bar> {
        if self.bars.is_empty() {
            self.cursor = 0;
            self.status = ReplayStatus::Finished;
            return None;
        }
        self.cursor = self.bars.len() - 1;
        self.status = ReplayStatus::Finished;
        self.bars.get(self.cursor)
    }

    /// Seek directly to a bar index, clamped to dataset bounds.
    pub fn seek(&mut self, index: usize) -> Option<&Bar> {
        if self.bars.is_empty() {
            self.cursor = 0;
            self.status = ReplayStatus::Finished;
            return None;
        }
        self.cursor = index.min(self.bars.len() - 1);
        if self.cursor == self.bars.len() - 1 {
            self.status = ReplayStatus::Finished;
        } else if self.status == ReplayStatus::Finished {
            self.status = ReplayStatus::Paused;
        }
        self.bars.get(self.cursor)
    }

    /// Advance cursor by one bar. Marks status as `Finished` when end is reached.
    pub fn step_forward(&mut self) -> Option<&Bar> {
        if self.bars.is_empty() {
            self.status = ReplayStatus::Finished;
            return None;
        }
        if self.cursor + 1 < self.bars.len() {
            self.cursor += 1;
            if self.cursor == self.bars.len() - 1 {
                self.status = ReplayStatus::Finished;
            }
            self.bars.get(self.cursor)
        } else {
            self.cursor = self.bars.len() - 1;
            self.status = ReplayStatus::Finished;
            None
        }
    }

    /// Move cursor backward by one bar.
    pub fn step_backward(&mut self) -> Option<&Bar> {
        if self.bars.is_empty() {
            self.status = ReplayStatus::Finished;
            return None;
        }
        if self.cursor > 0 {
            self.cursor -= 1;
            self.status = ReplayStatus::Paused;
            self.bars.get(self.cursor)
        } else {
            self.bars.first()
        }
    }

    /// Reference to the current bar under the replay cursor.
    pub fn current_bar(&self) -> Option<&Bar> {
        self.bars.get(self.cursor)
    }

    /// Slice of bars from index 0 up to and including the cursor (hindsight eraser view).
    pub fn visible_bars(&self) -> &[Bar] {
        if self.bars.is_empty() {
            &[]
        } else {
            let end = (self.cursor + 1).min(self.bars.len());
            &self.bars[..end]
        }
    }

    /// Playback completion percentage from 0.0 to 100.0.
    pub fn progress_pct(&self) -> f64 {
        if self.bars.len() <= 1 {
            return 100.0;
        }
        (self.cursor as f64 / (self.bars.len() - 1) as f64) * 100.0
    }

    /// Advance by one bar and return the emitted [`MarketEvent::Bar`], if available.
    pub fn step_event(&mut self) -> Option<MarketEvent> {
        self.step_forward().copied().map(MarketEvent::Bar)
    }

    /// Advance by one bar and publish the event to an [`EventBus`].
    pub fn publish_next(&mut self, bus: &EventBus) -> Option<MarketEvent> {
        let ev = self.step_event()?;
        bus.publish(ev.clone());
        Some(ev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bars(n: usize) -> Vec<Bar> {
        (0..n)
            .map(|i| Bar {
                time: 1_700_000_000 + (i as i64 * 60),
                open: 100.0 + i as f64,
                high: 105.0 + i as f64,
                low: 95.0 + i as f64,
                close: 102.0 + i as f64,
                volume: 10.0,
            })
            .collect()
    }

    #[test]
    fn empty_dataset_handling() {
        let mut engine = ReplayEngine::new(vec![]);
        assert!(engine.is_empty());
        assert_eq!(engine.len(), 0);
        assert_eq!(engine.cursor(), 0);
        assert_eq!(engine.current_bar(), None);
        assert!(engine.visible_bars().is_empty());
        assert_eq!(engine.step_forward(), None);
        assert_eq!(engine.step_backward(), None);
        assert_eq!(engine.progress_pct(), 100.0);

        engine.play();
        assert_eq!(engine.status(), ReplayStatus::Finished);
    }

    #[test]
    fn step_and_cursor_boundaries() {
        let bars = make_bars(3);
        let mut engine = ReplayEngine::new(bars.clone());

        assert_eq!(engine.cursor(), 0);
        assert_eq!(engine.visible_bars().len(), 1);
        assert_eq!(engine.current_bar(), Some(&bars[0]));

        assert_eq!(engine.step_forward(), Some(&bars[1]));
        assert_eq!(engine.cursor(), 1);
        assert_eq!(engine.visible_bars().len(), 2);

        assert_eq!(engine.step_forward(), Some(&bars[2]));
        assert_eq!(engine.cursor(), 2);
        assert_eq!(engine.status(), ReplayStatus::Finished);
        assert_eq!(engine.visible_bars().len(), 3);

        // Cannot step past end
        assert_eq!(engine.step_forward(), None);
        assert_eq!(engine.cursor(), 2);

        // Step backward
        assert_eq!(engine.step_backward(), Some(&bars[1]));
        assert_eq!(engine.cursor(), 1);
        assert_eq!(engine.status(), ReplayStatus::Paused);

        assert_eq!(engine.step_backward(), Some(&bars[0]));
        assert_eq!(engine.cursor(), 0);

        // Step backward at 0 stays at 0
        assert_eq!(engine.step_backward(), Some(&bars[0]));
        assert_eq!(engine.cursor(), 0);
    }

    #[test]
    fn seek_and_jump_to_end() {
        let bars = make_bars(10);
        let mut engine = ReplayEngine::new(bars.clone());

        assert_eq!(engine.seek(5), Some(&bars[5]));
        assert_eq!(engine.cursor(), 5);
        assert_eq!(engine.visible_bars().len(), 6);

        // Clamped seek beyond bounds
        assert_eq!(engine.seek(100), Some(&bars[9]));
        assert_eq!(engine.cursor(), 9);
        assert_eq!(engine.status(), ReplayStatus::Finished);

        // Jump to end
        engine.reset();
        assert_eq!(engine.cursor(), 0);
        assert_eq!(engine.jump_to_end(), Some(&bars[9]));
        assert_eq!(engine.cursor(), 9);
        assert_eq!(engine.status(), ReplayStatus::Finished);
    }

    #[test]
    fn play_pause_and_loop_behavior() {
        let bars = make_bars(3);
        let mut engine = ReplayEngine::new(bars);

        engine.play();
        assert_eq!(engine.status(), ReplayStatus::Playing);

        engine.pause();
        assert_eq!(engine.status(), ReplayStatus::Paused);

        assert_eq!(engine.toggle_play(), ReplayStatus::Playing);
        assert_eq!(engine.toggle_play(), ReplayStatus::Paused);

        // If at end, play restarts from beginning
        engine.jump_to_end();
        assert_eq!(engine.status(), ReplayStatus::Finished);
        engine.play();
        assert_eq!(engine.cursor(), 0);
        assert_eq!(engine.status(), ReplayStatus::Playing);
    }

    #[test]
    fn speed_validation() {
        let mut engine = ReplayEngine::new(make_bars(5));
        assert_eq!(engine.speed(), 1);

        assert!(engine.set_speed(10).is_ok());
        assert_eq!(engine.speed(), 10);

        assert_eq!(engine.set_speed(7), Err(ReplayError::InvalidSpeed(7)));
    }

    #[test]
    fn step_event_and_publish() {
        let bars = make_bars(2);
        let mut engine = ReplayEngine::new(bars.clone());
        let bus = EventBus::new(4);
        let mut rx = bus.subscribe();

        let ev = engine.publish_next(&bus).unwrap();
        assert_eq!(ev, MarketEvent::Bar(bars[1]));
        assert_eq!(rx.try_recv().unwrap(), MarketEvent::Bar(bars[1]));

        assert_eq!(engine.publish_next(&bus), None);
    }

    #[test]
    fn progress_pct_calculation() {
        let bars = make_bars(5);
        let mut engine = ReplayEngine::new(bars);

        assert_eq!(engine.progress_pct(), 0.0);
        engine.seek(2);
        assert_eq!(engine.progress_pct(), 50.0);
        engine.seek(4);
        assert_eq!(engine.progress_pct(), 100.0);
    }
}
