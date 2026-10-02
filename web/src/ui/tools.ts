import { $ } from "../dom.ts";
import type { DrawingManager } from "../drawings/manager.ts";
import type { DrawingTool } from "../drawings/types.ts";

export function mountDrawingTools(manager: DrawingManager): void {
  const tools: [string, DrawingTool][] = [
    ["tool-cursor", "cursor"],
    ["tool-trendline", "trendline"],
    ["tool-horizontal", "horizontal"],
    ["tool-box", "box_zone"],
    ["tool-fibonacci", "fibonacci"],
    ["tool-position", "position"],
    ["tool-measure", "measure"],
  ];

  for (const [id, tool] of tools) {
    const btn = $(id);
    btn.addEventListener("click", () => {
      manager.setTool(manager.getActiveTool() === tool ? "cursor" : tool);
    });
  }

  const clearBtn = $("tool-clear");
  clearBtn.addEventListener("click", () => {
    manager.clear();
  });

  manager.onToolChange((active) => {
    for (const [id, tool] of tools) {
      if (tool === active) {
        $(id).classList.add("active");
      } else {
        $(id).classList.remove("active");
      }
    }
  });
}
