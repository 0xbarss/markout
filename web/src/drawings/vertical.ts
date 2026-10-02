import type { CoordinateConverter, VerticalDrawing } from "./types.ts";

export function drawVertical(
  ctx: CanvasRenderingContext2D,
  d: VerticalDrawing,
  conv: CoordinateConverter,
  height: number,
): void {
  const x = conv.timeToX(d.time);
  if (x === null) return;

  ctx.save();
  ctx.strokeStyle = "#f7a600";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);

  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  // Label tag at bottom
  const dateStr = new Date(d.time * 1000).toISOString().replace("T", " ").substring(0, 16);
  ctx.font = "10px monospace";
  const tw = ctx.measureText(dateStr).width;
  ctx.fillStyle = "rgba(22, 27, 34, 0.85)";
  ctx.fillRect(x - tw / 2 - 4, height - 20, tw + 8, 16);
  ctx.strokeStyle = "#f7a600";
  ctx.setLineDash([]);
  ctx.strokeRect(x - tw / 2 - 4, height - 20, tw + 8, 16);
  ctx.fillStyle = "#f7a600";
  ctx.fillText(dateStr, x - tw / 2, height - 8);

  ctx.restore();
}
