import { fmtPrice, fmtSigned } from "../format.ts";
import type { CoordinateConverter, PositionDrawing } from "./types.ts";

export function drawPosition(
  ctx: CanvasRenderingContext2D,
  d: PositionDrawing,
  conv: CoordinateConverter
): void {
  const x1 = conv.timeToX(d.entry.time);
  const x2 = conv.timeToX(d.endTime);
  const yEntry = conv.priceToY(d.entry.price);
  const yTarget = conv.priceToY(d.targetPrice);
  const yStop = conv.priceToY(d.stopPrice);

  if (x1 === null || x2 === null || yEntry === null || yTarget === null || yStop === null) {
    return;
  }

  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const width = Math.max(20, right - left);

  const risk = Math.abs(d.entry.price - d.stopPrice);
  const reward = Math.abs(d.targetPrice - d.entry.price);
  const rr = risk > 0 ? (reward / risk).toFixed(2) : "—";

  const targetPct = d.entry.price !== 0 ? ((d.targetPrice - d.entry.price) / d.entry.price) * 100 : 0;
  const stopPct = d.entry.price !== 0 ? ((d.stopPrice - d.entry.price) / d.entry.price) * 100 : 0;

  const isLong = d.side !== "short";
  const targetColor = d.targetColor ?? "#0ecb81";
  const stopColor = d.stopColor ?? "#f6465d";

  ctx.save();

  // Target box (green for long / customizable)
  const topTarget = Math.min(yEntry, yTarget);
  const heightTarget = Math.abs(yTarget - yEntry);
  ctx.fillStyle = isLong ? "rgba(14, 203, 129, 0.16)" : "rgba(14, 203, 129, 0.16)";
  ctx.strokeStyle = targetColor;
  ctx.lineWidth = 1;
  ctx.fillRect(left, topTarget, width, heightTarget);
  ctx.strokeRect(left, topTarget, width, heightTarget);

  // Stop box (red for long / customizable)
  const topStop = Math.min(yEntry, yStop);
  const heightStop = Math.abs(yStop - yEntry);
  ctx.fillStyle = isLong ? "rgba(246, 70, 93, 0.16)" : "rgba(246, 70, 93, 0.16)";
  ctx.strokeStyle = stopColor;
  ctx.fillRect(left, topStop, width, heightStop);
  ctx.strokeRect(left, topStop, width, heightStop);

  // Center badge with compact R:R (avoids blocking candles)
  const badgeText = `R:R ${rr}`;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  const metrics = ctx.measureText(badgeText);
  const badgeW = metrics.width + 10;
  const badgeH = 18;
  const badgeX = Math.round(left + (width - badgeW) / 2);
  const badgeY = Math.round(yEntry - badgeH / 2);

  ctx.fillStyle = "rgba(22, 27, 34, 0.88)";
  ctx.strokeStyle = "#262932";

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
  } else {
    ctx.rect(badgeX, badgeY, badgeW, badgeH);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#eaecef";
  ctx.textBaseline = "middle";
  ctx.fillText(badgeText, badgeX + 5, yEntry);

  // Price tags on right with percentages
  const tpTag = `TP ${fmtPrice(d.targetPrice)} (${fmtSigned(targetPct, 2)}%)`;
  const slTag = `SL ${fmtPrice(d.stopPrice)} (${fmtSigned(stopPct, 2)}%)`;

  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = targetColor;
  ctx.fillText(tpTag, left + width + 6, yTarget);
  ctx.fillStyle = stopColor;
  ctx.fillText(slTag, left + width + 6, yStop);

  ctx.restore();
}
