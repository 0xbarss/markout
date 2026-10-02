import { h } from "../dom.ts";

export interface DialogTab {
  id: string;
  label: string;
  content: HTMLElement;
}

export interface DialogAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  onClick: (dialog: DialogInstance) => void;
}

export interface DialogOptions {
  title: string;
  subtitle?: string;
  width?: string;
  tabs?: DialogTab[];
  content?: HTMLElement;
  actions?: DialogAction[];
  onClose?: () => void;
  closeOnBackdrop?: boolean;
}

export interface DialogInstance {
  close(): void;
  getElement(): HTMLElement;
  setActiveTab(id: string): void;
}

export function showDialog(opts: DialogOptions): DialogInstance {
  // Backdrop overlay
  const overlay = h("div", "modal-backdrop");
  const modal = h("div", "modal-dialog");
  if (opts.width) {
    modal.style.width = opts.width;
    modal.style.maxWidth = "calc(100vw - 32px)";
  }

  // Header
  const header = h("div", "modal-header");
  const titleGroup = h("div", "modal-title-group");
  const title = h("h3", "modal-title", opts.title);
  titleGroup.append(title);
  if (opts.subtitle) {
    const subtitle = h("div", "modal-subtitle", opts.subtitle);
    titleGroup.append(subtitle);
  }

  const closeBtn = h("button", "modal-close-btn", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close");
  header.append(titleGroup, closeBtn);
  modal.append(header);

  // Tabs (if provided)
  const tabPanes = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();

  let tabNav: HTMLElement | null = null;
  if (opts.tabs && opts.tabs.length > 1) {
    tabNav = h("div", "modal-tabs");
    for (let i = 0; i < opts.tabs.length; i++) {
      const tab = opts.tabs[i];
      const btn = h("button", i === 0 ? "modal-tab active" : "modal-tab", tab.label) as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.tabId = tab.id;
      tabButtons.set(tab.id, btn);
      btn.addEventListener("click", () => {
        instance.setActiveTab(tab.id);
      });
      tabNav.append(btn);
    }
    modal.append(tabNav);
  }

  // Body
  const body = h("div", "modal-body");
  if (opts.tabs && opts.tabs.length > 0) {
    for (let i = 0; i < opts.tabs.length; i++) {
      const tab = opts.tabs[i];
      const pane = h("div", i === 0 ? "modal-tab-pane active" : "modal-tab-pane");
      pane.dataset.tabPane = tab.id;
      pane.append(tab.content);
      tabPanes.set(tab.id, pane);
      body.append(pane);
    }
  } else if (opts.content) {
    body.append(opts.content);
  }
  modal.append(body);

  // Footer (if actions provided)
  if (opts.actions && opts.actions.length > 0) {
    const footer = h("div", "modal-footer");
    for (const act of opts.actions) {
      const btnCls = ["modal-action-btn"];
      if (act.primary) btnCls.push("primary");
      if (act.danger) btnCls.push("danger");
      const btn = h("button", btnCls.join(" "), act.label) as HTMLButtonElement;
      btn.type = "button";
      btn.addEventListener("click", () => {
        act.onClick(instance);
      });
      footer.append(btn);
    }
    modal.append(footer);
  }

  overlay.append(modal);
  document.body.append(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKeyDown);
    overlay.classList.add("closing");
    setTimeout(() => {
      overlay.remove();
      opts.onClose?.();
    }, 150);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  closeBtn.addEventListener("click", close);

  if (opts.closeOnBackdrop !== false) {
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) {
        close();
      }
    });
  }

  // Auto focus first interactive element
  requestAnimationFrame(() => {
    const focusable = modal.querySelector<HTMLElement>("input, textarea, select, button.primary");
    if (focusable) {
      focusable.focus();
    }
  });

  const instance: DialogInstance = {
    close,
    getElement: () => modal,
    setActiveTab: (tabId: string) => {
      for (const [id, btn] of tabButtons) {
        btn.classList.toggle("active", id === tabId);
      }
      for (const [id, pane] of tabPanes) {
        pane.classList.toggle("active", id === tabId);
      }
    },
  };

  return instance;
}

export function promptDialog(options: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", "modal-input") as HTMLInputElement;
    input.type = "text";
    input.value = options.defaultValue ?? "";
    if (options.placeholder) input.placeholder = options.placeholder;

    const content = h("div", "modal-prompt-content");
    if (options.message) {
      content.append(h("p", "modal-prompt-msg", options.message));
    }
    content.append(input);

    let resolved = false;

    const dlg = showDialog({
      title: options.title,
      content,
      width: "380px",
      actions: [
        {
          label: options.cancelText ?? "Cancel",
          onClick: (d) => {
            if (!resolved) {
              resolved = true;
              resolve(null);
            }
            d.close();
          },
        },
        {
          label: options.confirmText ?? "OK",
          primary: true,
          onClick: (d) => {
            if (!resolved) {
              resolved = true;
              resolve(input.value);
            }
            d.close();
          },
        },
      ],
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!resolved) {
          resolved = true;
          resolve(input.value);
        }
        dlg.close();
      }
    });

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const content = h("div", "modal-confirm-content");
    content.append(h("p", "modal-confirm-msg", options.message));

    let resolved = false;

    showDialog({
      title: options.title,
      content,
      width: "380px",
      actions: [
        {
          label: options.cancelText ?? "Cancel",
          onClick: (d) => {
            if (!resolved) {
              resolved = true;
              resolve(false);
            }
            d.close();
          },
        },
        {
          label: options.confirmText ?? "Confirm",
          primary: !options.danger,
          danger: !!options.danger,
          onClick: (d) => {
            if (!resolved) {
              resolved = true;
              resolve(true);
            }
            d.close();
          },
        },
      ],
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      },
    });
  });
}

export function alertDialog(options: {
  title: string;
  message: string;
  okText?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    const content = h("div", "modal-alert-content");
    content.append(h("p", "modal-alert-msg", options.message));

    showDialog({
      title: options.title,
      content,
      width: "360px",
      actions: [
        {
          label: options.okText ?? "OK",
          primary: true,
          onClick: (d) => {
            d.close();
            resolve();
          },
        },
      ],
      onClose: () => {
        resolve();
      },
    });
  });
}
