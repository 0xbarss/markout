import { barIndexAt } from "./snap.ts";
import type { Bar, Trade } from "../types";

/** A line point; a point without `value` is a gap that breaks the line. */
export interface TrailPoint { time: number; value?: number; }
export interface Trail { sl: TrailPoint[][]; tp: TrailPoint[][]; }

interface Segment { start: number; end: number; pts: [number, number][]; } // [barIndex, price]

/** First and last bar index a trade covers on this chart, or null if it has no drawable span. */
export function spanOf(t: Trade, bars: Bar[]): [number, number] | null {
  const n = bars.length;
  if (n === 0 || t.entry_time > bars[n - 1].time + (n > 1 ? bars[n - 1].time - bars[n - 2].time : 0)) return null;
  if (t.exit_time !== null && t.exit_time < bars[0].time) return null;
  const s = Math.max(0, barIndexAt(bars, t.entry_time));
  const e = t.exit_time === null ? n - 1 : Math.min(n - 1, barIndexAt(bars, t.exit_time));
  return e > s ? [s, e] : null;
}

function slSegment(t: Trade, bars: Bar[], s: number, e: number): Segment {
  const steps = new Map<number, number>([[s, t.initial_sl]]);
  const history = [...t.sl_history].sort((a, b) => a.time - b.time);
  for (const p of history) {
    const i = Math.min(e, Math.max(s, barIndexAt(bars, p.time)));
    steps.set(i, p.price);
  }
  const pts = [...steps.entries()].sort((a, b) => a[0] - b[0]);
  const last = pts[pts.length - 1];
  if (last[0] < e) pts.push([e, last[1]]); // hold the final stop level until exit
  return { start: s, end: e, pts };
}

/** Greedily pack segments into lanes of non-overlapping segments (one chart series per lane). */
function toLanes(segs: Segment[], bars: Bar[]): TrailPoint[][] {
  segs.sort((a, b) => a.start - b.start);
  const ends: number[] = [];
  const lanes: TrailPoint[][] = [];
  for (const seg of segs) {
    // Need one spare bar between segments to hold the gap point.
    let k = ends.findIndex((end) => end + 2 <= seg.start);
    if (k < 0) { k = ends.length; ends.push(-2); lanes.push([]); }
    if (lanes[k].length > 0) lanes[k].push({ time: bars[ends[k] + 1].time });
    for (const [i, v] of seg.pts) lanes[k].push({ time: bars[i].time, value: v });
    ends[k] = seg.end;
  }
  return lanes;
}

/** Step-wise trailing stop paths and take-profit levels, packed into series lanes. */
export function buildTrail(trades: Trade[], bars: Bar[]): Trail {
  const sl: Segment[] = [], tp: Segment[] = [];
  for (const t of trades) {
    const span = spanOf(t, bars);
    if (!span) continue;
    const [s, e] = span;
    sl.push(slSegment(t, bars, s, e));
    if (t.take_profit !== null) tp.push({ start: s, end: e, pts: [[s, t.take_profit], [e, t.take_profit]] });
  }
  return { sl: toLanes(sl, bars), tp: toLanes(tp, bars) };
}
