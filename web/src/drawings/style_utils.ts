import type { Drawing, LineStyleType, StyleableDrawing } from "./types.ts";

export function applyLineDash(ctx: CanvasRenderingContext2D, style?: LineStyleType): void {
  if (style === "dashed") {
    ctx.setLineDash([6, 6]);
  } else if (style === "dotted") {
    ctx.setLineDash([2, 4]);
  } else {
    ctx.setLineDash([]);
  }
}

export interface ParsedColor {
  hex: string;
  alpha: number;
}

export function parseColor(colorStr?: string): ParsedColor {
  if (!colorStr) return { hex: "#f7a600", alpha: 1 };
  const s = colorStr.trim();

  if (s.startsWith("rgb")) {
    const match = s.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (match) {
      const r = Math.min(255, parseInt(match[1], 10));
      const g = Math.min(255, parseInt(match[2], 10));
      const b = Math.min(255, parseInt(match[3], 10));
      const a = match[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(match[4]))) : 1;
      const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
      return { hex, alpha: Math.round(a * 100) / 100 };
    }
  }

  if (s.startsWith("#") && s.length === 9) {
    const hex = s.slice(0, 7);
    const a = parseInt(s.slice(7, 9), 16) / 255;
    return { hex, alpha: Math.round(a * 100) / 100 };
  }

  if (s.startsWith("#") && s.length === 7) {
    return { hex: s, alpha: 1 };
  }

  if (s.startsWith("#") && s.length === 4) {
    const r = s[1] + s[1];
    const g = s[2] + s[2];
    const b = s[3] + s[3];
    return { hex: `#${r}${g}${b}`, alpha: 1 };
  }

  return { hex: "#f7a600", alpha: 1 };
}

export function formatRgba(hex: string, alpha: number): string {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const num = parseInt(c, 16);
  if (isNaN(num) || c.length !== 6) return hex;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const clampedA = Math.max(0, Math.min(1, Math.round(alpha * 100) / 100));
  if (clampedA >= 1) {
    return `#${c}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${clampedA})`;
}

export function getDrawingColor(d: Drawing): string {
  const sd = d as StyleableDrawing;
  if (sd.color) return sd.color;
  if (sd.targetColor) return sd.targetColor;
  if (d.type === "horizontal") return "#848e9c";
  return "#f7a600";
}

export function setDrawingColor(d: Drawing, color: string): void {
  const sd = d as StyleableDrawing;
  sd.color = color;
}

export function getDrawingWidth(d: Drawing): number {
  const sd = d as StyleableDrawing;
  if (typeof sd.lineWidth === "number") return sd.lineWidth;
  return d.type === "arrow" ? 2 : 1.5;
}

export function setDrawingWidth(d: Drawing, width: number): void {
  const sd = d as StyleableDrawing;
  sd.lineWidth = width;
}

export function getDrawingLineStyle(d: Drawing): LineStyleType {
  const sd = d as StyleableDrawing;
  if (sd.lineStyle) return sd.lineStyle;
  return d.type === "horizontal" || d.type === "vertical" ? "dashed" : "solid";
}

export function setDrawingLineStyle(d: Drawing, style: LineStyleType): void {
  const sd = d as StyleableDrawing;
  sd.lineStyle = style;
}
