import type { DrawingManager } from "../drawings/manager.ts";
import type { DrawingTool } from "../drawings/types.ts";
import { confirmDialog, promptDialog } from "./dialog.ts";
import { openDrawingSettingsDialog } from "./drawing_dialog.ts";

export function mountDrawingTools(manager: DrawingManager): void {
  // Connect text prompt with custom dialog (zero toast / prompt messages)
  manager.setTextPromptHandler((initial) => {
    return promptDialog({
      title: "Text Annotation",
      message: "Enter annotation note:",
      defaultValue: initial,
      placeholder: "Note...",
      confirmText: "Add Note",
    });
  });

  // Connect double-click / context menu edit with custom Drawing Settings dialog
  manager.onEdit((drawing) => {
    openDrawingSettingsDialog(drawing, manager);
  });

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

  const magnetBtn = document.getElementById("tool-magnet");
  if (magnetBtn) {
    magnetBtn.addEventListener("click", () => {
      manager.toggleMagnet();
    });
    manager.onMagnetChange((enabled) => {
      magnetBtn.classList.toggle("active", enabled);
    });
  }

  const undoBtn = document.getElementById("tool-undo");
  if (undoBtn) {
    undoBtn.addEventListener("click", () => {
      manager.undo();
    });
  }

  const settingsBtn = document.getElementById("tool-settings") as HTMLButtonElement | null;
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      const selected = manager.getSelectedDrawing();
      if (selected) {
        openDrawingSettingsDialog(selected, manager);
      }
    });
    manager.onSelect((selected) => {
      settingsBtn.disabled = selected === null;
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
      saveBtn.classList.add("active");
      const origTitle = saveBtn.title;
      saveBtn.title = "Drawings saved!";
      setTimeout(() => {
        saveBtn.classList.remove("active");
        saveBtn.title = origTitle;
      }, 1000);
    });
  }

  const clearBtn = document.getElementById("tool-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (manager.getDrawings().length === 0) return;
      const confirmed = await confirmDialog({
        title: "Clear All Drawings",
        message: "Are you sure you want to remove all drawings on this chart?",
        confirmText: "Clear All",
        cancelText: "Keep",
        danger: true,
      });
      if (confirmed) {
        manager.clear();
      }
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

