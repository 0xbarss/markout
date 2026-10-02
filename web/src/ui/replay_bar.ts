import { $ } from "../dom.ts";
import type { ReplayController } from "../replay/controller.ts";

export function mountReplayBar(controller: ReplayController): void {
  const playBtn = $("replay-play") as HTMLButtonElement;
  const prevBtn = $("replay-prev") as HTMLButtonElement;
  const nextBtn = $("replay-next") as HTMLButtonElement;
  const speedBtn = $("replay-speed") as HTMLButtonElement;
  const slider = $("replay-slider") as HTMLInputElement;
  const counter = $("replay-counter");
  const liveBtn = $("replay-live") as HTMLButtonElement;

  playBtn.addEventListener("click", () => controller.togglePlay());
  prevBtn.addEventListener("click", () => controller.stepBackward());
  nextBtn.addEventListener("click", () => controller.stepForward());
  speedBtn.addEventListener("click", () => controller.cycleSpeed());
  slider.addEventListener("input", () => controller.seek(Number(slider.value)));
  slider.addEventListener("change", () => controller.seek(Number(slider.value)));
  liveBtn.addEventListener("click", () => controller.jumpToLive());

  controller.onState((state) => {
    const empty = state.total === 0;
    playBtn.disabled = empty;
    prevBtn.disabled = empty || state.cursor <= 0;
    nextBtn.disabled = empty || state.cursor >= state.total - 1;
    speedBtn.disabled = empty;
    slider.disabled = empty;
    liveBtn.disabled = empty;

    playBtn.textContent = state.isPlaying ? "❚❚ Pause" : "▶ Play";
    if (state.isPlaying) {
      playBtn.classList.add("active");
    } else {
      playBtn.classList.remove("active");
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
}
