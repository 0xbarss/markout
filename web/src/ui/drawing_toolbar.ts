import { h } from "../dom.ts";
import type { DrawingManager } from "../drawings/manager.ts";
import {
  formatRgba,
  getDrawingColor,
  getDrawingLineStyle,
  getDrawingWidth,
  parseColor,
  setDrawingColor,
  setDrawingLineStyle,
  setDrawingWidth,
} from "../drawings/style_utils.ts";
import type { Drawing, FibonacciDrawing, LineStyleType } from "../drawings/types.ts";
import { openDrawingSettingsDialog, PRESET_COLORS } from "./drawing_dialog.ts";

export class DrawingFloatingToolbar {
  private el: HTMLElement;
  private manager: DrawingManager;
  private container: HTMLElement;
  private currentDrawing: Drawing | null = null;
  private colorPopup: HTMLElement | null = null;
  private widthPopup: HTMLElement | null = null;
  private stylePopup: HTMLElement | null = null;

  constructor(container: HTMLElement, manager: DrawingManager) {
    this.container = container;
    this.manager = manager;

    this.el = h("div", "drawing-floating-toolbar");
    this.el.style.display = "none";
    this.el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    this.container.appendChild(this.el);

    this.manager.onSelect((selected) => {
      this.currentDrawing = selected;
      if (!selected) {
        this.hide();
      } else {
        this.render();
        this.updatePosition();
      }
    });

    // Listen to updates/renders from manager
    this.manager.onChange(() => {
      if (this.currentDrawing) {
        this.updatePosition();
      }
    });

    // Close popups on click outside
    document.addEventListener("pointerdown", (e) => {
      if (!this.el.contains(e.target as Node)) {
        this.closeAllPopups();
      }
    });
  }

  public hide(): void {
    this.closeAllPopups();
    this.el.style.display = "none";
  }

  public show(): void {
    this.el.style.display = "flex";
    this.updatePosition();
  }

  private closeAllPopups(): void {
    if (this.colorPopup) { this.colorPopup.remove(); this.colorPopup = null; }
    if (this.widthPopup) { this.widthPopup.remove(); this.widthPopup = null; }
    if (this.stylePopup) { this.stylePopup.remove(); this.stylePopup = null; }
  }

  public updatePosition(): void {
    if (!this.currentDrawing || this.el.style.display === "none") return;

    const bounds = this.manager.getDrawingPixelBounds(this.currentDrawing);
    if (!bounds) {
      this.el.style.display = "none";
      return;
    }

    this.el.style.display = "flex";

    // Place toolbar slightly above the drawing's top edge
    const toolbarWidth = this.el.offsetWidth || 180;
    const toolbarHeight = this.el.offsetHeight || 34;

    const containerRect = this.container.getBoundingClientRect();
    const centerX = bounds.minX + (bounds.maxX - bounds.minX) / 2;

    let left = centerX - toolbarWidth / 2;
    let top = bounds.minY - toolbarHeight - 12;

    // If too close to the top, position below
    if (top < 10) {
      top = bounds.maxY + 12;
    }

    // Clamp inside container
    left = Math.max(10, Math.min(containerRect.width - toolbarWidth - 10, left));
    top = Math.max(10, Math.min(containerRect.height - toolbarHeight - 10, top));

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private render(): void {
    this.closeAllPopups();
    this.el.replaceChildren();

    if (!this.currentDrawing) return;
    const d = this.currentDrawing;

    // Drag handle icon
    const grip = h("div", "floating-grip", "⋮⋮");
    this.el.append(grip);

    // Color button
    const colorBtn = h("button", "floating-btn color-btn") as HTMLButtonElement;
    colorBtn.type = "button";
    colorBtn.title = "Change Color";
    const colorSwatch = h("span", "floating-color-indicator");
    const activeColor = getDrawingColor(d);
    colorSwatch.style.backgroundColor = activeColor;
    colorBtn.append(colorSwatch);

    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleColorPopup(colorBtn);
    });
    this.el.append(colorBtn);

    // Line width button (for line-based drawings)
    if (d.type !== "text") {
      const widthBtn = h("button", "floating-btn width-btn") as HTMLButtonElement;
      widthBtn.type = "button";
      widthBtn.title = "Line Thickness";
      const w = getDrawingWidth(d);
      const widthIcon = h("span", "floating-width-indicator");
      widthIcon.style.height = `${Math.min(4, Math.max(1, Math.round(w)))}px`;
      widthBtn.append(widthIcon);

      widthBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleWidthPopup(widthBtn);
      });
      this.el.append(widthBtn);

      // Line style button
      const styleBtn = h("button", "floating-btn style-btn") as HTMLButtonElement;
      styleBtn.type = "button";
      styleBtn.title = "Line Style";
      const curStyle: LineStyleType = getDrawingLineStyle(d);
      const styleIcon = h("span", `floating-style-indicator ${curStyle}`);
      styleBtn.append(styleIcon);

      styleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleStylePopup(styleBtn);
      });
      this.el.append(styleBtn);
    }

    if (d.type === "fibonacci") {
      const isExtLeft = !!d.extendLeft;
      const extLeftBtn = h("button", `floating-btn ${isExtLeft ? "active" : ""}`, "⇤") as HTMLButtonElement;
      extLeftBtn.type = "button";
      extLeftBtn.title = isExtLeft ? "Disable Extend Left" : "Extend Left";
      extLeftBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = JSON.parse(JSON.stringify(d)) as FibonacciDrawing;
        updated.extendLeft = !isExtLeft;
        this.manager.updateDrawing(updated, true);
        this.render();
      });
      this.el.append(extLeftBtn);

      const isExtRight = !!d.extendRight;
      const extRightBtn = h("button", `floating-btn ${isExtRight ? "active" : ""}`, "⇥") as HTMLButtonElement;
      extRightBtn.type = "button";
      extRightBtn.title = isExtRight ? "Disable Extend Right" : "Extend Right";
      extRightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = JSON.parse(JSON.stringify(d)) as FibonacciDrawing;
        updated.extendRight = !isExtRight;
        this.manager.updateDrawing(updated, true);
        this.render();
      });
      this.el.append(extRightBtn);
    }

    const sep = h("div", "floating-sep");
    this.el.append(sep);

    // Settings (gear) button
    const settingsBtn = h("button", "floating-btn", "⚙") as HTMLButtonElement;
    settingsBtn.type = "button";
    settingsBtn.title = "Settings (Double-click drawing)";
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const current = this.currentDrawing ?? this.manager.getSelectedDrawing();
      if (current) {
        openDrawingSettingsDialog(current, this.manager);
      }
    });
    this.el.append(settingsBtn);


    // Clone / Duplicate button
    const cloneBtn = h("button", "floating-btn", "⧉") as HTMLButtonElement;
    cloneBtn.type = "button";
    cloneBtn.title = "Clone Drawing (Ctrl+D)";
    cloneBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const current = this.currentDrawing ?? this.manager.getSelectedDrawing();
      if (current) {
        this.manager.duplicateDrawing(current.id);
      }
    });
    this.el.append(cloneBtn);

    // Delete button
    const deleteBtn = h("button", "floating-btn danger", "🗑") as HTMLButtonElement;
    deleteBtn.type = "button";
    deleteBtn.title = "Delete (Del / Backspace)";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.manager.deleteSelected();
    });
    this.el.append(deleteBtn);


    this.show();
  }

  private toggleColorPopup(btn: HTMLElement): void {
    if (this.colorPopup) {
      this.colorPopup.remove();
      this.colorPopup = null;
      return;
    }
    this.closeAllPopups();

    if (!this.currentDrawing) return;
    const curDrawing = this.currentDrawing;
    const activeColor = getDrawingColor(curDrawing);
    const parsed = parseColor(activeColor);
    let curHex = parsed.hex;
    let curAlpha = parsed.alpha;

    const popup = h("div", "floating-popup color-popup-container");
    popup.style.left = `${btn.offsetLeft}px`;

    const grid = h("div", "color-popup-grid");
    const nativeInput = h("input", "color-native-input") as HTMLInputElement;
    nativeInput.type = "color";
    const opacityHeader = h("div", "floating-opacity-header");
    const alphaValText = h("span", "floating-opacity-val", `${Math.round(curAlpha * 100)}%`);
    opacityHeader.append(
      h("span", "floating-opacity-lbl", "Opacity"),
      alphaValText
    );

    const alphaSlider = h("input", "floating-opacity-slider") as HTMLInputElement;
    alphaSlider.type = "range";
    alphaSlider.min = "0";
    alphaSlider.max = "100";
    alphaSlider.value = String(Math.round(curAlpha * 100));

    const apply = () => {
      if (!this.currentDrawing) return;
      const d = JSON.parse(JSON.stringify(this.currentDrawing)) as Drawing;
      const formatted = formatRgba(curHex, curAlpha);
      setDrawingColor(d, formatted);
      if (d.type === "position") {
        d.color = formatted;
      } else if (d.type === "box_zone") {
        d.color = formatted;
      }
      this.manager.updateDrawing(d, true);
      this.currentDrawing = d;

      const swatch = this.el.querySelector(".floating-color-indicator") as HTMLElement | null;
      if (swatch) {
        swatch.style.backgroundColor = formatted;
      }
      alphaValText.textContent = `${Math.round(curAlpha * 100)}%`;
      alphaSlider.value = String(Math.round(curAlpha * 100));
    };

    nativeInput.addEventListener("input", () => {
      curHex = nativeInput.value;
      apply();
    });

    for (const c of PRESET_COLORS) {
      const sw = h("button", "color-preset-btn") as HTMLButtonElement;
      sw.type = "button";
      sw.style.backgroundColor = c;
      sw.title = c;
      sw.addEventListener("click", () => {
        curHex = c;
        apply();
      });
      grid.append(sw);
    }

    const customBtn = h("button", "color-preset-btn color-custom-trigger", "🎨") as HTMLButtonElement;
    customBtn.type = "button";
    customBtn.title = "Custom color";
    customBtn.addEventListener("click", () => nativeInput.click());
    grid.append(customBtn, nativeInput);

    popup.append(grid);

    // Opacity section
    const sep = h("div", "floating-sep-h");
    popup.append(sep);

    alphaSlider.addEventListener("input", () => {
      curAlpha = parseInt(alphaSlider.value, 10) / 100;
      apply();
    });

    const chipsRow = h("div", "floating-opacity-chips");
    for (const pct of [15, 30, 60, 100]) {
      const chip = h("button", "floating-opacity-chip", `${pct}%`) as HTMLButtonElement;
      chip.type = "button";
      chip.addEventListener("click", () => {
        curAlpha = pct / 100;
        apply();
      });
      chipsRow.append(chip);
    }

    popup.append(opacityHeader, alphaSlider, chipsRow);

    this.el.append(popup);
    this.colorPopup = popup;
  }

  private toggleWidthPopup(btn: HTMLElement): void {
    if (this.widthPopup) {
      this.widthPopup.remove();
      this.widthPopup = null;
      return;
    }
    this.closeAllPopups();

    const popup = h("div", "floating-popup width-popup");
    popup.style.left = `${btn.offsetLeft}px`;
    for (const w of [1, 2, 3, 4]) {
      const b = h("button", "width-opt-btn") as HTMLButtonElement;
      b.type = "button";
      const line = h("span", "width-opt-line");
      line.style.height = `${w}px`;
      b.append(line);
      b.addEventListener("click", () => {
        if (!this.currentDrawing) return;
        const d = JSON.parse(JSON.stringify(this.currentDrawing)) as Drawing;
        setDrawingWidth(d, w);
        this.manager.updateDrawing(d, true);
        this.render();
      });
      popup.append(b);
    }

    this.el.append(popup);
    this.widthPopup = popup;
  }

  private toggleStylePopup(btn: HTMLElement): void {
    if (this.stylePopup) {
      this.stylePopup.remove();
      this.stylePopup = null;
      return;
    }
    this.closeAllPopups();

    const popup = h("div", "floating-popup style-popup");
    popup.style.left = `${btn.offsetLeft}px`;
    const styles: { id: LineStyleType; label: string }[] = [
      { id: "solid", label: "Solid" },
      { id: "dashed", label: "Dashed" },
      { id: "dotted", label: "Dotted" },
    ];
    for (const s of styles) {
      const b = h("button", "style-opt-btn", s.label) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", () => {
        if (!this.currentDrawing) return;
        const d = JSON.parse(JSON.stringify(this.currentDrawing)) as Drawing;
        setDrawingLineStyle(d, s.id);
        this.manager.updateDrawing(d, true);
        this.render();
      });
      popup.append(b);
    }

    this.el.append(popup);
    this.stylePopup = popup;
  }

}
