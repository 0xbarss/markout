import { $ } from "../dom.ts";
import type { ReplayController } from "../replay/controller.ts";
import type { Bar, Trade } from "../types.ts";
import { locate } from "../overlays/snap.ts";

export interface ReplayBarHandle {
  setTrades(trades: Trade[], bars: Bar[]): void;
}

export function mountReplayBar(controller: ReplayController): ReplayBarHandle {
  const playBtn = $("replay-play") as HTMLButtonElement;
  const prevBtn = $("replay-prev") as HTMLButtonElement;
  const nextBtn = $("replay-next") as HTMLButtonElement;
  const speedBtn = $("replay-speed") as HTMLButtonElement;
  const slider = $("replay-slider") as HTMLInputElement;
  const counter = $("replay-counter");
  const liveBtn = $("replay-live") as HTMLButtonElement;
  const ticksCanvas = document.getElementById("replay-ticks-canvas") as HTMLCanvasElement | null;

  playBtn.addEventListener("click", () => {
    controller.togglePlay();
  });
  prevBtn.addEventListener("click", () => controller.stepBackward());
  nextBtn.addEventListener("click", () => controller.stepForward());
  speedBtn.addEventListener("click", () => controller.cycleSpeed());
  let seekRafId: number | null = null;
  slider.addEventListener("input", () => {
    const val = Number(slider.value);
    if (seekRafId !== null) {
      cancelAnimationFrame(seekRafId);
    }
    seekRafId = requestAnimationFrame(() => {
      seekRafId = null;
      controller.seek(val);
    });
  });
  slider.addEventListener("change", () => {
    if (seekRafId !== null) {
      cancelAnimationFrame(seekRafId);
      seekRafId = null;
    }
    controller.seek(Number(slider.value));
  });
  liveBtn.addEventListener("click", () => controller.jumpToLive());

  // Keyboard shortcuts: Space (play/pause), ArrowLeft (step back), ArrowRight (step forward), R (reset)
  window.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) {
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      controller.togglePlay();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      controller.stepBackward();
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      controller.stepForward();
    } else if (e.code === "KeyR" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      controller.seek(0);
    }
  });

  const pauseSvg = `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" fill="currentColor"></rect></svg>`;
  const playSvg = `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon></svg>`;

  let lastIsPlaying: boolean | null = null;

  controller.onState((state) => {
    const empty = state.total === 0;
    playBtn.disabled = empty;
    prevBtn.disabled = empty || state.cursor <= 0;
    nextBtn.disabled = empty || state.cursor >= state.total - 1;
    speedBtn.disabled = empty;
    slider.disabled = empty;
    liveBtn.disabled = empty;

    if (lastIsPlaying !== state.isPlaying) {
      lastIsPlaying = state.isPlaying;
      const svg = state.isPlaying ? pauseSvg : playSvg;
      playBtn.innerHTML = `${svg}<span>${state.isPlaying ? "Pause" : "Play"}</span>`;
      playBtn.classList.toggle("active", state.isPlaying);
    }

    speedBtn.textContent = `${state.speed}x`;

    slider.max = String(Math.max(0, state.total - 1));
    slider.value = String(state.cursor);

    counter.textContent = empty ? "0 / 0" : `${state.cursor + 1} / ${state.total}`;

    if (state.isLive) {
      liveBtn.textContent = "Live";
      liveBtn.className = "live-btn synced";
    } else {
      liveBtn.textContent = "Jump to Live";
      liveBtn.className = "live-btn behind";
    }
  });

  let currentTrades: Trade[] = [];
  let currentBars: Bar[] = [];

  const drawTicks = () => {
    if (!ticksCanvas || currentBars.length === 0) return;
    const rect = ticksCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ticksCanvas.width = Math.round(rect.width * dpr);
    ticksCanvas.height = Math.round(rect.height * dpr);
    const ctx = ticksCanvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const total = currentBars.length;
    if (total <= 1) return;

    for (const t of currentTrades) {
      const ei = locate(currentBars, t.entry_time);
      if (ei >= 0) {
        const x = (ei / (total - 1)) * rect.width;
        ctx.fillStyle = t.direction === "buy" ? "#0ecb81" : "#f6465d";
        ctx.beginPath();
        ctx.arc(x, rect.height / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (t.exit_time !== null) {
        const xi = locate(currentBars, t.exit_time);
        if (xi >= 0) {
          const x = (xi / (total - 1)) * rect.width;
          ctx.fillStyle = t.pnl >= 0 ? "#0ecb81" : "#f6465d";
          ctx.beginPath();
          ctx.rect(x - 1, 1, 2, rect.height - 2);
          ctx.fill();
        }
      }
    }
  };

  window.addEventListener("resize", drawTicks);

  return {
    setTrades(trades: Trade[], bars: Bar[]) {
      currentTrades = trades;
      currentBars = bars;
      drawTicks();
    },
  };
}
