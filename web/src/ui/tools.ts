import type { DrawingManager } from "../drawings/manager.ts";
import type { DrawingTool } from "../drawings/types.ts";

export function mountDrawingTools(manager: DrawingManager): void {
  const tools: [string, DrawingTool][] = [
    ["tool-cursor", "cursor"],
    ["tool-trendline", "trendline"],
    ["tool-ray", "ray"],
    ["tool-horizontal", "horizontal"],
    ["tool-vertical", "vertical"],
    ["tool-arrow", "arrow"],
    ["tool-box", "box_zone"],
    ["tool-fibonacci", "fibonacci"],
    ["tool-position", "position"],
    ["tool-measure", "measure"],
    ["tool-text", "text"],
  ];

  for (const [id, tool] of tools) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      manager.setTool(manager.getActiveTool() === tool ? "cursor" : tool);
    });
  }

  const undoBtn = document.getElementById("tool-undo");
  if (undoBtn) {
    undoBtn.addEventListener("click", () => {
      manager.undo();
    });
  }

  const deleteBtn = document.getElementById("tool-delete") as HTMLButtonElement | null;
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      manager.deleteSelected();
    });
    manager.onSelect((selected) => {
      deleteBtn.disabled = selected === null;
    });
  }

  const saveBtn = document.getElementById("tool-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      manager.save();
      const origText = saveBtn.textContent;
      saveBtn.textContent = "✓";
      saveBtn.classList.add("active");
      setTimeout(() => {
        saveBtn.textContent = origText;
        saveBtn.classList.remove("active");
      }, 1000);
    });
  }

  const clearBtn = document.getElementById("tool-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      manager.clear();
    });
  }

  manager.onToolChange((active) => {
    for (const [id, tool] of tools) {
      const el = document.getElementById(id);
      if (el) {
        if (tool === active) {
          el.classList.add("active");
        } else {
          el.classList.remove("active");
        }
      }
    }
  });
}
