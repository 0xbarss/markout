export interface ThemeTokens {
  bg: string;
  panel: string;
  border: string;
  border2: string;
  text: string;
  muted: string;
  accent: string;
  up: string;
  down: string;
}

const DEFAULT_TOKENS: ThemeTokens = {
  bg: "#0b0e11",
  panel: "#161b22",
  border: "#1e222d",
  border2: "#262932",
  text: "#eaecef",
  muted: "#848e9c",
  accent: "#f7a600",
  up: "#0ecb81",
  down: "#f6465d",
};

export function getThemeTokens(): ThemeTokens {
  if (typeof window === "undefined" || typeof document === "undefined" || !window.getComputedStyle) {
    return { ...DEFAULT_TOKENS };
  }
  const cs = window.getComputedStyle(document.documentElement);
  return {
    bg: cs.getPropertyValue("--bg").trim() || DEFAULT_TOKENS.bg,
    panel: cs.getPropertyValue("--panel").trim() || DEFAULT_TOKENS.panel,
    border: cs.getPropertyValue("--border").trim() || DEFAULT_TOKENS.border,
    border2: cs.getPropertyValue("--border2").trim() || DEFAULT_TOKENS.border2,
    text: cs.getPropertyValue("--text").trim() || DEFAULT_TOKENS.text,
    muted: cs.getPropertyValue("--muted").trim() || DEFAULT_TOKENS.muted,
    accent: cs.getPropertyValue("--accent").trim() || DEFAULT_TOKENS.accent,
    up: cs.getPropertyValue("--up").trim() || DEFAULT_TOKENS.up,
    down: cs.getPropertyValue("--down").trim() || DEFAULT_TOKENS.down,
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  let c = hex.replace("#", "");
  if (c.length === 3) {
    c = c.split("").map((x) => x + x).join("");
  }
  const num = parseInt(c, 16);
  if (isNaN(num) || c.length !== 6) return hex;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
