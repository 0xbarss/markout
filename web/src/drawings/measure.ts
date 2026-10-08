import { fmtPrice, fmtSigned } from "../format.ts";
import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, MeasureDrawing } from "./types.ts";

function formatCompact(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return String(Math.round(val));
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

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
  const barsCount = conv.getBarCount ? conv.getBarCount(d.p1.time, d.p2.time) : null;
  const rangeVol = conv.getRangeVolume ? conv.getRangeVolume(d.p1.time, d.p2.time) : null;

  const isUp = deltaPrice >= 0;
  const color = isUp ? "#0ecb81" : "#f6465d";
  const bg = isUp ? "rgba(14, 203, 129, 0.12)" : "rgba(246, 70, 93, 0.12)";
  const lineWidth = d.lineWidth ?? 1;

  ctx.save();

  // Bounding zone fill
  ctx.fillStyle = bg;
  ctx.fillRect(left, top, width, height);

  // Border outline
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  applyLineDash(ctx, d.lineStyle ?? "dashed");
  ctx.strokeRect(left, top, width, height);

  // Diagonal guideline from p1 to p2
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Arrowhead at endpoint p2
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 8;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();

  // Small anchor dots at p1 and p2
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.arc(x2, y2, 3, 0, Math.PI * 2);
  ctx.fill();

  // TradingView-style Multi-line Floating Information Card
  const priceLine = `${isUp ? "▲ +" : "▼ "}${fmtPrice(Math.abs(deltaPrice))} (${fmtSigned(pct, 2)}%)`;
  const timeLine = `${barsCount !== null ? `${barsCount} bar${barsCount === 1 ? "" : "s"}, ` : ""}${durationStr}`;
  const volLine = rangeVol !== null && rangeVol > 0 ? `Vol ${formatCompact(rangeVol)}` : null;

  ctx.font = "bold 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const m1 = ctx.measureText(priceLine);
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  const m2 = ctx.measureText(timeLine);
  const m3 = volLine ? ctx.measureText(volLine) : { width: 0 };

  const padX = 8;
  const padY = 6;
  const cardW = Math.max(m1.width, m2.width, m3.width) + padX * 2;
  const cardH = (volLine ? 44 : 32) + padY;

  // Position card near p2, clamped
  let cardX = x2 - cardW / 2;
  let cardY = y2 > y1 ? y2 + 10 : y2 - cardH - 10;
  if (cardY < 6) cardY = y2 + 10;

  // Background box with shadow
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = "#161b22";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(cardX, cardY, cardW, cardH, 4);
  } else {
    ctx.rect(cardX, cardY, cardW, cardH);
  }
  ctx.fill();
  ctx.stroke();

  // Reset shadow for text
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // Draw Price line (bold colored)
  ctx.font = "bold 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = color;
  ctx.fillText(priceLine, cardX + padX, cardY + padY + 10);

  // Draw Time / Bars line (muted)
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#848e9c";
  ctx.fillText(timeLine, cardX + padX, cardY + padY + 23);

  // Draw Volume line if applicable
  if (volLine) {
    ctx.fillStyle = "#f7a600";
    ctx.fillText(volLine, cardX + padX, cardY + padY + 36);
  }

  ctx.restore();
}

