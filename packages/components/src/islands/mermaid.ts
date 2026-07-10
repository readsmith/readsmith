/**
 * Render Mermaid diagrams. Deterministic build-time SVG needs a headless browser
 * (a heavy dependency for a self-host build), so M1 renders diagrams in the
 * browser and lazy-loads Mermaid only on pages that actually contain one, so
 * pages without diagrams pay nothing. Rendered diagrams get pan-and-zoom controls
 * (grab to pan, wheel or buttons to zoom), a fullscreen modal, and re-render when
 * the theme changes.
 *
 * The pipeline emits `<div class="rs-mermaid" data-rs-mermaid>SOURCE</div>`; this
 * stashes the source, renders it to SVG, and swaps it in.
 */
const ICON_IN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_OUT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 12h14"/></svg>';
const ICON_RESET =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"/></svg>';
const ICON_FULLSCREEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const CTRL_IN = `<button type="button" data-rs-zoom-in aria-label="Zoom in">${ICON_IN}</button>`;
const CTRL_OUT = `<button type="button" data-rs-zoom-out aria-label="Zoom out">${ICON_OUT}</button>`;
const CTRL_RESET = `<button type="button" data-rs-zoom-reset aria-label="Reset view">${ICON_RESET}</button>`;
const CTRL_FS = `<button type="button" data-rs-fullscreen aria-label="Open fullscreen">${ICON_FULLSCREEN}</button>`;
const CONTROLS = `<div class="rs-mermaid__controls">${CTRL_IN}${CTRL_OUT}${CTRL_RESET}${CTRL_FS}</div>`;
const CONTROLS_MODAL = `<div class="rs-mermaid__controls">${CTRL_IN}${CTRL_OUT}${CTRL_RESET}</div>`;

export async function initMermaid(root: ParentNode = document): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>(".rs-mermaid")];
  if (nodes.length === 0) return;

  for (const node of nodes) {
    if (!node.dataset.src) node.dataset.src = (node.textContent ?? "").trim();
  }

  const mermaid = (await import("mermaid")).default;
  let counter = 0;

  const renderNode = async (node: HTMLElement): Promise<void> => {
    const source = node.dataset.src ?? "";
    if (!source) return;
    try {
      const { svg } = await mermaid.render(`rs-mmd-${counter++}`, source);
      node.innerHTML = `<div class="rs-mermaid__viewport"><div class="rs-mermaid__canvas">${svg}</div></div>${CONTROLS}`;
      node.classList.add("is-rendered");
      node.classList.remove("is-error");
      setupPanZoom(node);
    } catch {
      node.classList.add("is-error");
    }
  };

  const renderAll = async (): Promise<void> => {
    mermaid.initialize({
      startOnLoad: false,
      // The "base" theme takes every color from us, so diagrams are set in the
      // page's own tokens (and re-render on toggle) instead of Mermaid's
      // default palette clashing with the design system.
      theme: "base",
      themeVariables: themeVariables(),
      securityLevel: "strict",
    });
    for (const node of nodes) await renderNode(node);
  };

  await renderAll();

  new MutationObserver(() => {
    void renderAll();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/**
 * Grab-to-pan and wheel/button zoom over the rendered SVG. Zoom resizes the SVG
 * element itself (a vector, so it re-renders crisply at any size, no blur) and
 * panning uses a translate only. Inline, it fits to width and sizes its height to
 * the diagram (capped); `contain` (used in the fullscreen modal) fits the whole
 * diagram inside a fixed viewport instead.
 */
function setupPanZoom(container: HTMLElement, options: { contain?: boolean } = {}): void {
  const viewport = container.querySelector<HTMLElement>(".rs-mermaid__viewport");
  const canvas = container.querySelector<HTMLElement>(".rs-mermaid__canvas");
  const svg = canvas?.querySelector<SVGSVGElement>("svg");
  if (!viewport || !canvas || !svg) return;

  const box = svg.viewBox?.baseVal;
  const naturalW = box?.width ? box.width : svg.getBoundingClientRect().width || 640;
  const naturalH = box?.height ? box.height : svg.getBoundingClientRect().height || 360;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";

  let scale = 1;
  let x = 0;
  let y = 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const apply = (): void => {
    svg.style.width = `${naturalW * scale}px`;
    svg.style.height = `${naturalH * scale}px`;
    canvas.style.transform = `translate(${x}px, ${y}px)`;
  };

  const fit = (): void => {
    const vw = viewport.clientWidth || naturalW;
    if (options.contain) {
      const vh = viewport.clientHeight || naturalH;
      scale = clamp(Math.min(vw / naturalW, vh / naturalH), 0.1, 4);
      x = (vw - naturalW * scale) / 2;
      y = (vh - naturalH * scale) / 2;
    } else {
      scale = clamp(Math.min(vw / naturalW, 1), 0.2, 4);
      const maxHeight = Math.min(window.innerHeight * 0.75, 640);
      viewport.style.height = `${Math.min(naturalH * scale, maxHeight)}px`;
      x = Math.max((vw - naturalW * scale) / 2, 0);
      y = 0;
    }
    apply();
  };

  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const next = clamp(scale * factor, 0.15, 8);
    x = cx - ((cx - x) / scale) * next;
    y = cy - ((cy - y) / scale) * next;
    scale = next;
    apply();
  };

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
    },
    { passive: false },
  );

  let dragging = false;
  let px = 0;
  let py = 0;
  viewport.addEventListener("pointerdown", (event) => {
    dragging = true;
    px = event.clientX;
    py = event.clientY;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-grabbing");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    x += event.clientX - px;
    y += event.clientY - py;
    px = event.clientX;
    py = event.clientY;
    canvas.style.transform = `translate(${x}px, ${y}px)`;
  });
  const end = (): void => {
    dragging = false;
    viewport.classList.remove("is-grabbing");
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);

  const zoomButton = (selector: string, factor: number): void => {
    container.querySelector<HTMLElement>(selector)?.addEventListener("click", () => {
      const rect = viewport.getBoundingClientRect();
      zoomAt(rect.width / 2, rect.height / 2, factor);
    });
  };
  zoomButton("[data-rs-zoom-in]", 1.25);
  zoomButton("[data-rs-zoom-out]", 0.8);
  container.querySelector<HTMLElement>("[data-rs-zoom-reset]")?.addEventListener("click", fit);
  container.querySelector<HTMLElement>("[data-rs-fullscreen]")?.addEventListener("click", () => {
    openModal(svg);
  });

  requestAnimationFrame(fit);
}

/** Open the diagram large in a modal: a fresh clone with its own pan/zoom. */
function openModal(sourceSvg: SVGSVGElement): void {
  const previous = document.activeElement as HTMLElement | null;
  const modal = document.createElement("div");
  modal.className = "rs-mermaid-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Diagram");
  modal.innerHTML = `<div class="rs-mermaid-modal__panel"><button type="button" class="rs-mermaid-modal__close" aria-label="Close">${ICON_CLOSE}</button><div class="rs-mermaid__viewport"><div class="rs-mermaid__canvas"></div></div>${CONTROLS_MODAL}</div>`;

  const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
  clone.style.width = "";
  clone.style.height = "";
  clone.style.maxWidth = "none";
  modal.querySelector<HTMLElement>(".rs-mermaid__canvas")?.appendChild(clone);

  document.body.appendChild(modal);
  const panel = modal.querySelector<HTMLElement>(".rs-mermaid-modal__panel");
  if (panel) setupPanZoom(panel, { contain: true });

  const close = (): void => {
    modal.remove();
    document.removeEventListener("keydown", onKey);
    previous?.focus?.();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector<HTMLElement>(".rs-mermaid-modal__close")?.addEventListener("click", close);
  modal.querySelector<HTMLElement>(".rs-mermaid-modal__close")?.focus();
}

function isDark(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) return theme === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Derive Mermaid's palette from the live design tokens. Read at render time so
 * per-site themes and the light/dark toggle are both honored. Alpha values from
 * the tokens are fine: SVG fills composite them over the paper behind. Note
 * surfaces carry the hallmark (marking), never the accent.
 */
function themeVariables(): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;
  const ink = v("--rs-ink", "#16181d");
  const surface = v("--rs-surface-2", "rgba(22, 24, 29, 0.07)");
  const rule = v("--rs-rule-strong", "rgba(22, 24, 29, 0.17)");
  return {
    darkMode: isDark(),
    background: v("--rs-paper", "#fafaf8"),
    fontFamily: v("--rs-font-sans", "system-ui, sans-serif"),
    fontSize: "14px",
    textColor: ink,
    titleColor: ink,
    primaryColor: surface,
    primaryTextColor: ink,
    primaryBorderColor: rule,
    secondaryColor: v("--rs-surface", "rgba(22, 24, 29, 0.04)"),
    secondaryBorderColor: rule,
    tertiaryColor: v("--rs-surface", "rgba(22, 24, 29, 0.04)"),
    tertiaryBorderColor: v("--rs-rule", "rgba(22, 24, 29, 0.1)"),
    lineColor: v("--rs-ink-faint", "#767c84"),
    clusterBkg: v("--rs-surface", "rgba(22, 24, 29, 0.04)"),
    clusterBorder: v("--rs-rule", "rgba(22, 24, 29, 0.1)"),
    edgeLabelBackground: v("--rs-paper", "#fafaf8"),
    noteBkgColor: v("--rs-hallmark-wash", "rgba(184, 135, 58, 0.1)"),
    noteBorderColor: v("--rs-hallmark", "#b8873a"),
    noteTextColor: ink,
    actorBkg: surface,
    actorBorder: rule,
    actorTextColor: ink,
  };
}
