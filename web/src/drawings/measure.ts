import { fmtSigned } from "../format.ts";
import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, MeasureDrawing } from "./types.ts";


export function drawMeasure(
  ctx: CanvasRenderingContext2D,
  d: MeasureDrawing,
  conv: CoordinateConverter
): void {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);

  if (x1 === null || y1 === null || x2 === null || y2 === null) return;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  const deltaPrice = d.p2.price - d.p1.price;
  const pct = d.p1.price !== 0 ? (deltaPrice / d.p1.price) * 100 : 0;
  const elapsedSec = Math.abs(d.p2.time - d.p1.time);
  const durationStr = formatDuration(elapsedSec);

  const isUp = deltaPrice >= 0;
  const color = d.color ?? (isUp ? "#0ecb81" : "#f6465d");
  const bg = d.fillColor ?? (isUp ? "rgba(14, 203, 129, 0.12)" : "rgba(246, 70, 93, 0.12)");
  const lineWidth = d.lineWidth ?? 1;

  ctx.save();
  ctx.fillStyle = bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  ctx.fillRect(left, top, width, height);

  applyLineDash(ctx, d.lineStyle);
  ctx.strokeRect(left, top, width, height);

  // Diagonal line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Information badge
  const info = `${fmtSigned(pct, 2)}% (${fmtSigned(deltaPrice, 2)}) | ${durationStr}`;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const m = ctx.measureText(info);
  const badgeW = m.width + 12;
  const badgeH = 20;
  const badgeX = left + Math.max(0, (width - badgeW) / 2);
  const badgeY = top + Math.max(0, (height - badgeH) / 2);

  ctx.setLineDash([]);
  ctx.fillStyle = "#161b22";
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3) : ctx.rect(badgeX, badgeY, badgeW, badgeH);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#eaecef";

  ctx.fillText(info, badgeX + 6, badgeY + 14);

  ctx.restore();
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
