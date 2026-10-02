import { h } from "../dom.ts";
import type { DrawingManager } from "../drawings/manager.ts";
import { formatRgba, parseColor } from "../drawings/style_utils.ts";
import type { Drawing, LineStyleType, Point } from "../drawings/types.ts";
import { showDialog } from "./dialog.ts";

export const PRESET_COLORS = [
  "#f7a600", // Yellow / Gold
  "#0ecb81", // Green
  "#f6465d", // Red
  "#29b6f6", // Light Blue
  "#ab47bc", // Purple
  "#ffffff", // White
  "#848e9c", // Gray
  "#ff9800", // Orange
  "#00d2d3", // Cyan
  "#e040fb", // Pink
];

function timestampToDateLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yr = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hr = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yr}-${mo}-${da}T${hr}:${mi}`;
}

function dateLocalToTimestamp(str: string): number | null {
  if (!str) return null;
  const d = new Date(str);
  const t = d.getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

function createColorPicker(initialColor: string, onChange: (col: string) => void): HTMLElement {
  const parsed = parseColor(initialColor);
  let currentHex = parsed.hex;
  let currentAlpha = parsed.alpha;

  const container = h("div", "color-picker-box");
  const topRow = h("div", "color-picker-wrap");

  // Checkerboard background wrapper for transparency visualization
  const swatchWrap = h("div", "color-preview-swatch-wrap");
  const preview = h("span", "color-preview-swatch");
  swatchWrap.append(preview);

  const input = h("input", "color-native-input") as HTMLInputElement;
  input.type = "color";
  input.value = currentHex;

  // Clicking swatch opens native color dialog
  swatchWrap.title = "Click to pick custom color";
  swatchWrap.addEventListener("click", () => {
    input.click();
  });

  const swatches = h("div", "color-presets");

  const notifyChange = () => {
    const formatted = formatRgba(currentHex, currentAlpha);
    preview.style.backgroundColor = formatted;
    input.value = currentHex;
    alphaSlider.value = String(Math.round(currentAlpha * 100));
    alphaValText.textContent = `${Math.round(currentAlpha * 100)}%`;
    onChange(formatted);
  };

  input.addEventListener("input", () => {
    currentHex = input.value;
    notifyChange();
  });

  for (const c of PRESET_COLORS) {
    const sw = h("button", "color-preset-btn") as HTMLButtonElement;
    sw.type = "button";
    sw.style.backgroundColor = c;
    sw.title = c;
    sw.addEventListener("click", () => {
      currentHex = c;
      notifyChange();
    });
    swatches.append(sw);
  }

  // Native color trigger button
  const customBtn = h("button", "color-custom-btn", "🎨") as HTMLButtonElement;
  customBtn.type = "button";
  customBtn.title = "Custom Color";
  customBtn.addEventListener("click", () => input.click());

  topRow.append(swatchWrap, input, swatches, customBtn);

  // Opacity Row
  const opacityRow = h("div", "color-opacity-row");
  const opacityTop = h("div", "color-opacity-top");
  const opacityLabel = h("span", "color-opacity-label", "Opacity");
  const alphaValText = h("span", "color-opacity-val", `${Math.round(currentAlpha * 100)}%`);

  const chipsWrap = h("div", "color-opacity-presets");
  for (const pct of [15, 30, 60, 100]) {
    const chip = h("button", "color-opacity-chip", `${pct}%`) as HTMLButtonElement;
    chip.type = "button";
    chip.addEventListener("click", () => {
      currentAlpha = pct / 100;
      notifyChange();
    });
    chipsWrap.append(chip);
  }

  opacityTop.append(opacityLabel, alphaValText, chipsWrap);

  const alphaSlider = h("input", "color-opacity-slider") as HTMLInputElement;
  alphaSlider.type = "range";
  alphaSlider.min = "0";
  alphaSlider.max = "100";
  alphaSlider.value = String(Math.round(currentAlpha * 100));

  alphaSlider.addEventListener("input", () => {
    currentAlpha = parseInt(alphaSlider.value, 10) / 100;
    notifyChange();
  });

  opacityRow.append(opacityTop, alphaSlider);

  // Initial style apply
  preview.style.backgroundColor = formatRgba(currentHex, currentAlpha);

  container.append(topRow, opacityRow);
  return container;
}

function createLineWidthSelect(current: number, onChange: (w: number) => void): HTMLElement {
  const wrap = h("div", "line-width-selector");
  const widths = [1, 2, 3, 4];
  for (const w of widths) {
    const btn = h("button", w === current ? "line-width-btn active" : "line-width-btn") as HTMLButtonElement;
    btn.type = "button";
    const line = h("span", "line-width-preview");
    line.style.height = `${w}px`;
    btn.append(line);
    btn.title = `${w}px`;
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".line-width-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(w);
    });
    wrap.append(btn);
  }
  return wrap;
}

function createLineStyleSelect(current: LineStyleType, onChange: (s: LineStyleType) => void): HTMLElement {
  const wrap = h("div", "line-style-selector");
  const styles: { id: LineStyleType; label: string; dash: string }[] = [
    { id: "solid", label: "Solid", dash: "none" },
    { id: "dashed", label: "Dashed", dash: "4px 4px" },
    { id: "dotted", label: "Dotted", dash: "2px 2px" },
  ];
  for (const s of styles) {
    const btn = h("button", s.id === current ? "line-style-btn active" : "line-style-btn", s.label) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".line-style-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(s.id);
    });
    wrap.append(btn);
  }
  return wrap;
}

function createFormRow(label: string, control: HTMLElement): HTMLElement {
  const row = h("div", "dialog-form-row");
  const lbl = h("label", "dialog-form-label", label);
  row.append(lbl, control);
  return row;
}

export function openDrawingSettingsDialog(drawing: Drawing, manager: DrawingManager): void {
  // Deep clone initial state in case of cancel
  const original = JSON.parse(JSON.stringify(drawing)) as Drawing;
  const draft = JSON.parse(JSON.stringify(drawing)) as Drawing;

  const updatePreview = () => {
    manager.updateDrawing(draft, false);
  };

  // Build Style Tab
  const styleContent = h("div", "dialog-tab-content");

  // Title formatter
  const titleName = drawing.type.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // General Line / Stroke styling (if applicable)
  if ("color" in draft || !("color" in draft)) {
    const curColor = (draft as any).color ?? ("type" in draft && draft.type === "horizontal" ? "#848e9c" : "#f7a600");
    const picker = createColorPicker(curColor, (c) => {
      (draft as any).color = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Color", picker));
  }

  if (draft.type !== "text") {
    const curWidth = (draft as any).lineWidth ?? (draft.type === "arrow" ? 2 : 1.5);
    const widthSelect = createLineWidthSelect(curWidth, (w) => {
      (draft as any).lineWidth = w;
      updatePreview();
    });
    styleContent.append(createFormRow("Line Width", widthSelect));

    const curStyle = (draft as any).lineStyle ?? (draft.type === "horizontal" || draft.type === "vertical" ? "dashed" : "solid");
    const styleSelect = createLineStyleSelect(curStyle, (s) => {
      (draft as any).lineStyle = s;
      updatePreview();
    });
    styleContent.append(createFormRow("Line Style", styleSelect));
  }

  // Type specific style controls
  if (draft.type === "trendline") {
    const rayWrap = h("label", "dialog-checkbox-wrap");
    const rayChk = h("input") as HTMLInputElement;
    rayChk.type = "checkbox";
    rayChk.checked = !!draft.ray;
    rayChk.addEventListener("change", () => {
      draft.ray = rayChk.checked;
      updatePreview();
    });
    rayWrap.append(rayChk, h("span", "", "Extend Right (Ray)"));
    styleContent.append(createFormRow("Extension", rayWrap));

    const leftWrap = h("label", "dialog-checkbox-wrap");
    const leftChk = h("input") as HTMLInputElement;
    leftChk.type = "checkbox";
    leftChk.checked = !!draft.extendLeft;
    leftChk.addEventListener("change", () => {
      draft.extendLeft = leftChk.checked;
      updatePreview();
    });
    leftWrap.append(leftChk, h("span", "", "Extend Left"));
    styleContent.append(createFormRow("Extend Left", leftWrap));
  }

  if (draft.type === "horizontal") {
    const tagWrap = h("label", "dialog-checkbox-wrap");
    const tagChk = h("input") as HTMLInputElement;
    tagChk.type = "checkbox";
    tagChk.checked = draft.showPrice !== false;
    tagChk.addEventListener("change", () => {
      draft.showPrice = tagChk.checked;
      updatePreview();
    });
    tagWrap.append(tagChk, h("span", "", "Show Price Callout"));
    styleContent.append(createFormRow("Price Tag", tagWrap));
  }

  if (draft.type === "vertical") {
    const timeWrap = h("label", "dialog-checkbox-wrap");
    const timeChk = h("input") as HTMLInputElement;
    timeChk.type = "checkbox";
    timeChk.checked = draft.showTime !== false;
    timeChk.addEventListener("change", () => {
      draft.showTime = timeChk.checked;
      updatePreview();
    });
    timeWrap.append(timeChk, h("span", "", "Show Time Callout"));
    styleContent.append(createFormRow("Time Tag", timeWrap));
  }

  if (draft.type === "box_zone") {
    const labelInput = h("input", "modal-input") as HTMLInputElement;
    labelInput.type = "text";
    labelInput.placeholder = "Optional label";
    labelInput.value = draft.label ?? "";
    labelInput.addEventListener("input", () => {
      draft.label = labelInput.value;
      updatePreview();
    });
    styleContent.append(createFormRow("Label", labelInput));

    const fillPicker = createColorPicker(draft.fillColor ?? "rgba(41, 182, 246, 0.12)", (c) => {
      draft.fillColor = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Background Fill", fillPicker));
  }

  if (draft.type === "text") {
    const textInput = h("textarea", "modal-textarea") as HTMLTextAreaElement;
    textInput.value = draft.text;
    textInput.rows = 3;
    textInput.addEventListener("input", () => {
      draft.text = textInput.value;
      updatePreview();
    });
    styleContent.append(createFormRow("Text", textInput));

    const sizeInput = h("select", "modal-select") as HTMLSelectElement;
    for (const sz of [10, 12, 14, 16, 20, 24]) {
      const opt = h("option", "", `${sz}px`) as HTMLOptionElement;
      opt.value = String(sz);
      if ((draft.fontSize ?? 12) === sz) opt.selected = true;
      sizeInput.append(opt);
    }
    sizeInput.addEventListener("change", () => {
      draft.fontSize = Number(sizeInput.value);
      updatePreview();
    });
    styleContent.append(createFormRow("Font Size", sizeInput));

    const bgPicker = createColorPicker(draft.backgroundColor ?? "rgba(22, 27, 34, 0.9)", (c) => {
      draft.backgroundColor = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Background", bgPicker));

    const borderPicker = createColorPicker(draft.borderColor ?? "#f7a600", (c) => {
      draft.borderColor = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Border", borderPicker));
  }

  if (draft.type === "position") {
    const sideWrap = h("div", "position-side-selector");
    const longBtn = h("button", draft.side === "long" ? "side-btn active up" : "side-btn", "Long") as HTMLButtonElement;
    const shortBtn = h("button", draft.side === "short" ? "side-btn active down" : "side-btn", "Short") as HTMLButtonElement;
    longBtn.type = "button";
    shortBtn.type = "button";
    longBtn.addEventListener("click", () => {
      draft.side = "long";
      longBtn.className = "side-btn active up";
      shortBtn.className = "side-btn";
      updatePreview();
    });
    shortBtn.addEventListener("click", () => {
      draft.side = "short";
      shortBtn.className = "side-btn active down";
      longBtn.className = "side-btn";
      updatePreview();
    });
    sideWrap.append(longBtn, shortBtn);
    styleContent.append(createFormRow("Side", sideWrap));

    const tpPicker = createColorPicker(draft.targetColor ?? "#0ecb81", (c) => {
      draft.targetColor = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Take Profit Color", tpPicker));

    const slPicker = createColorPicker(draft.stopColor ?? "#f6465d", (c) => {
      draft.stopColor = c;
      updatePreview();
    });
    styleContent.append(createFormRow("Stop Loss Color", slPicker));
  }

  if (draft.type === "fibonacci") {
    const rightWrap = h("label", "dialog-checkbox-wrap");
    const rightChk = h("input") as HTMLInputElement;
    rightChk.type = "checkbox";
    rightChk.checked = !!draft.extendRight;
    rightChk.addEventListener("change", () => {
      draft.extendRight = rightChk.checked;
      updatePreview();
    });
    rightWrap.append(rightChk, h("span", "", "Extend Lines Right"));
    styleContent.append(createFormRow("Extend Right", rightWrap));

    const leftWrap = h("label", "dialog-checkbox-wrap");
    const leftChk = h("input") as HTMLInputElement;
    leftChk.type = "checkbox";
    leftChk.checked = !!draft.extendLeft;
    leftChk.addEventListener("change", () => {
      draft.extendLeft = leftChk.checked;
      updatePreview();
    });
    leftWrap.append(leftChk, h("span", "", "Extend Lines Left"));
    styleContent.append(createFormRow("Extend Left", leftWrap));
  }

  // Build Coordinates Tab
  const coordContent = h("div", "dialog-tab-content");

  const addPointControls = (name: string, pt: Point, onPointChange: (p: Point) => void) => {
    const group = h("div", "coord-group");
    group.append(h("div", "coord-group-title", name));

    const priceInput = h("input", "modal-input") as HTMLInputElement;
    priceInput.type = "number";
    priceInput.step = "any";
    priceInput.value = String(pt.price);
    priceInput.addEventListener("input", () => {
      const val = parseFloat(priceInput.value);
      if (!isNaN(val)) {
        pt.price = val;
        onPointChange(pt);
        updatePreview();
      }
    });

    const timeInput = h("input", "modal-input") as HTMLInputElement;
    timeInput.type = "datetime-local";
    timeInput.value = timestampToDateLocal(pt.time);
    timeInput.addEventListener("change", () => {
      const ts = dateLocalToTimestamp(timeInput.value);
      if (ts !== null) {
        pt.time = ts;
        onPointChange(pt);
        updatePreview();
      }
    });

    group.append(createFormRow("Price", priceInput));
    group.append(createFormRow("Date / Time", timeInput));
    coordContent.append(group);
  };

  if ("p1" in draft && "p2" in draft) {
    addPointControls("Point 1", draft.p1, (p) => { draft.p1 = p; });
    addPointControls("Point 2", draft.p2, (p) => { draft.p2 = p; });
  } else if (draft.type === "horizontal") {
    const priceInput = h("input", "modal-input") as HTMLInputElement;
    priceInput.type = "number";
    priceInput.step = "any";
    priceInput.value = String(draft.price);
    priceInput.addEventListener("input", () => {
      const val = parseFloat(priceInput.value);
      if (!isNaN(val)) {
        draft.price = val;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Price Level", priceInput));
  } else if (draft.type === "vertical") {
    const timeInput = h("input", "modal-input") as HTMLInputElement;
    timeInput.type = "datetime-local";
    timeInput.value = timestampToDateLocal(draft.time);
    timeInput.addEventListener("change", () => {
      const ts = dateLocalToTimestamp(timeInput.value);
      if (ts !== null) {
        draft.time = ts;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Date / Time", timeInput));
  } else if (draft.type === "text") {
    addPointControls("Anchor Point", draft.p1, (p) => { draft.p1 = p; });
  } else if (draft.type === "position") {
    const entryPrice = h("input", "modal-input") as HTMLInputElement;
    entryPrice.type = "number";
    entryPrice.step = "any";
    entryPrice.value = String(draft.entry.price);
    entryPrice.addEventListener("input", () => {
      const val = parseFloat(entryPrice.value);
      if (!isNaN(val)) {
        draft.entry.price = val;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Entry Price", entryPrice));

    const tpPrice = h("input", "modal-input") as HTMLInputElement;
    tpPrice.type = "number";
    tpPrice.step = "any";
    tpPrice.value = String(draft.targetPrice);
    tpPrice.addEventListener("input", () => {
      const val = parseFloat(tpPrice.value);
      if (!isNaN(val)) {
        draft.targetPrice = val;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Profit Target", tpPrice));

    const slPrice = h("input", "modal-input") as HTMLInputElement;
    slPrice.type = "number";
    slPrice.step = "any";
    slPrice.value = String(draft.stopPrice);
    slPrice.addEventListener("input", () => {
      const val = parseFloat(slPrice.value);
      if (!isNaN(val)) {
        draft.stopPrice = val;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Stop Loss", slPrice));

    const entryTime = h("input", "modal-input") as HTMLInputElement;
    entryTime.type = "datetime-local";
    entryTime.value = timestampToDateLocal(draft.entry.time);
    entryTime.addEventListener("change", () => {
      const ts = dateLocalToTimestamp(entryTime.value);
      if (ts !== null) {
        draft.entry.time = ts;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("Entry Time", entryTime));

    const endTime = h("input", "modal-input") as HTMLInputElement;
    endTime.type = "datetime-local";
    endTime.value = timestampToDateLocal(draft.endTime);
    endTime.addEventListener("change", () => {
      const ts = dateLocalToTimestamp(endTime.value);
      if (ts !== null) {
        draft.endTime = ts;
        updatePreview();
      }
    });
    coordContent.append(createFormRow("End Time", endTime));
  }

  let confirmed = false;

  showDialog({
    title: `${titleName} Settings`,
    width: "440px",
    tabs: [
      { id: "style", label: "Style", content: styleContent },
      { id: "coordinates", label: "Coordinates", content: coordContent },
    ],
    actions: [
      {
        label: "Cancel",
        onClick: (d) => {
          manager.updateDrawing(original, false);
          d.close();
        },
      },
      {
        label: "OK",
        primary: true,
        onClick: (d) => {
          confirmed = true;
          manager.updateDrawing(draft, true);
          d.close();
        },
      },
    ],
    onClose: () => {
      if (!confirmed) {
        manager.updateDrawing(original, false);
      }
    },
  });
}
