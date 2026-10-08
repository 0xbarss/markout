export function initMobileDrawer(): void {
  const toolsBtn = document.getElementById("mobile-tools-btn");
  const toolsAside = document.querySelector(".tools");
  const backdrop = document.getElementById("drawer-backdrop");
  const sheetHandle = document.getElementById("sheet-handle");
  const ledger = document.querySelector(".ledger");

  const closeTools = () => {
    toolsAside?.classList.remove("open");
    if (backdrop) backdrop.hidden = true;
  };

  const openTools = () => {
    toolsAside?.classList.add("open");
    if (backdrop) backdrop.hidden = false;
  };

  toolsBtn?.addEventListener("click", () => {
    if (toolsAside?.classList.contains("open")) {
      closeTools();
    } else {
      openTools();
    }
  });

  backdrop?.addEventListener("click", () => {
    closeTools();
  });

  toolsAside?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON") {
      closeTools();
    }
  });

  if (sheetHandle && ledger) {
    sheetHandle.setAttribute("tabindex", "0");
    sheetHandle.addEventListener("click", () => {
      ledger.classList.toggle("expanded");
    });
    sheetHandle.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ledger.classList.toggle("expanded");
      }
    });

    let touchStartY = 0;
    sheetHandle.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sheetHandle.addEventListener("touchend", (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const diffY = touchEndY - touchStartY;
      if (diffY < -30) {
        ledger.classList.add("expanded");
      } else if (diffY > 30) {
        ledger.classList.remove("expanded");
      }
    }, { passive: true });
  }
}
