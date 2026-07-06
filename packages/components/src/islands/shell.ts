/**
 * Page-level reading-shell behaviours: theme toggle, mobile navigation,
 * scroll-spy for the on-this-page TOC, the command palette (search plus Ask-AI),
 * and the page contextual menu. Each is wired only if its markup is present, so
 * the same runtime serves a bare page and a full shell. All motion is CSS and
 * respects reduced-motion; nothing here blocks reading.
 */
export function initShell(root: ParentNode = document): void {
  initTheme(root);
  initProgress(root);
  initMobileNav(root);
  initScrollSpy(root);
  initPalette(root);
  initContextMenu(root);
  initFeedback(root);
}

function initProgress(root: ParentNode): void {
  const bar = root.querySelector<HTMLElement>("[data-rs-progress]");
  if (!bar) return;
  const update = (): void => {
    const el = document.documentElement;
    const max = el.scrollHeight - el.clientHeight;
    bar.style.setProperty("--rs-p", (max > 0 ? el.scrollTop / max : 0).toFixed(4));
  };
  addEventListener("scroll", update, { passive: true });
  update();
}

function initTheme(root: ParentNode): void {
  const toggle = root.querySelector<HTMLElement>("[data-rs-theme-toggle]");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const el = document.documentElement;
    const dark =
      el.getAttribute("data-theme") === "dark" ||
      (!el.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    el.setAttribute("data-theme", next);
    try {
      localStorage.setItem("rs-theme", next);
    } catch {
      // persistence is best-effort
    }
  });
}

function initMobileNav(root: ParentNode): void {
  const toggle = root.querySelector<HTMLElement>("[data-rs-nav-toggle]");
  const col = root.querySelector<HTMLElement>("[data-rs-navcol]");
  const scrim = root.querySelector<HTMLElement>("[data-rs-scrim]");
  if (!toggle || !col || !scrim) return;

  const open = (on: boolean): void => {
    col.classList.toggle("is-open", on);
    scrim.hidden = !on;
    toggle.setAttribute("aria-expanded", on ? "true" : "false");
  };
  toggle.addEventListener("click", () => open(!col.classList.contains("is-open")));
  scrim.addEventListener("click", () => open(false));
  for (const link of col.querySelectorAll(".rs-nav__link")) {
    link.addEventListener("click", () => open(false));
  }
}

function initScrollSpy(root: ParentNode): void {
  if (typeof IntersectionObserver === "undefined") return;
  const links = [...root.querySelectorAll<HTMLAnchorElement>(".rs-toc__link")];
  const marker = root.querySelector<HTMLElement>(".rs-toc__marker");
  if (links.length === 0) return;

  const byId = new Map<string, HTMLAnchorElement>();
  for (const link of links) {
    const id = decodeURIComponent((link.getAttribute("href") ?? "").replace(/^#/, ""));
    if (id) byId.set(id, link);
  }
  const headings = [...root.querySelectorAll<HTMLElement>(".rs-prose :is(h2, h3)[id]")];
  if (headings.length === 0) return;

  const setActive = (id: string): void => {
    const link = byId.get(id);
    if (!link) return;
    for (const l of links) l.classList.toggle("is-active", l === link);
    if (marker) {
      marker.style.opacity = "1";
      marker.style.setProperty("--rs-ty", `${link.offsetTop}px`);
    }
  };

  const headerH = 60;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
    },
    { rootMargin: `-${headerH + 12}px 0px -68% 0px`, threshold: 0 },
  );
  for (const heading of headings) observer.observe(heading);
  for (const link of links) {
    link.addEventListener("click", () => {
      const id = decodeURIComponent((link.getAttribute("href") ?? "").replace(/^#/, ""));
      if (id) setActive(id);
    });
  }
}

interface Hit {
  title: string;
  url: string;
}

function initPalette(root: ParentNode): void {
  const palette = root.querySelector<HTMLElement>("[data-rs-palette]");
  const opener = root.querySelector<HTMLElement>("[data-rs-palette-open]");
  const input = palette?.querySelector<HTMLInputElement>("[data-rs-palette-input]");
  const results = palette?.querySelector<HTMLElement>("[data-rs-palette-results]");
  if (!palette || !input || !results) return;

  const index: Hit[] = [...root.querySelectorAll<HTMLAnchorElement>(".rs-nav__link")].map((a) => ({
    title: (a.textContent ?? "").trim(),
    url: a.getAttribute("href") ?? "#",
  }));

  let rows: HTMLElement[] = [];
  let cursor = 0;
  let lastFocus: HTMLElement | null = null;

  const paintCursor = (): void => {
    rows.forEach((row, i) => row.classList.toggle("is-cursor", i === cursor));
  };

  const render = (query: string): void => {
    const q = query.trim().toLowerCase();
    const matches = index.filter((hit) => !q || hit.title.toLowerCase().includes(q));
    let html = "";
    if (q) {
      html += `<button class="rs-palette__row is-ask" data-ask="1"><span class="rs-palette__ic">💬</span>Ask AI: “${escapeHtml(
        q,
      )}”<span class="rs-palette__sub">SSE</span></button>`;
    }
    if (matches.length > 0) {
      html += '<div class="rs-palette__group">Pages</div>';
      for (const hit of matches) {
        html += `<button class="rs-palette__row" data-url="${escapeAttr(hit.url)}">${escapeHtml(
          hit.title,
        )}</button>`;
      }
    }
    results.innerHTML = html;
    rows = [...results.querySelectorAll<HTMLElement>(".rs-palette__row")];
    cursor = 0;
    paintCursor();
  };

  const open = (): void => {
    lastFocus = document.activeElement as HTMLElement;
    palette.hidden = false;
    input.value = "";
    render("");
    input.focus();
  };
  const close = (): void => {
    palette.hidden = true;
    input.placeholder = "Search docs, or ask a question";
    lastFocus?.focus();
  };
  const activate = (row: HTMLElement | undefined): void => {
    if (!row) return;
    if (row.dataset.ask) {
      input.placeholder = "Streaming a cited answer here (demo)";
      return;
    }
    if (row.dataset.url) location.assign(row.dataset.url);
    close();
  };

  opener?.addEventListener("click", open);
  input.addEventListener("input", () => render(input.value));
  results.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".rs-palette__row");
    if (row) activate(row);
  });
  palette.addEventListener("click", (event) => {
    if (event.target === palette) close();
  });
  addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      palette.hidden ? open() : close();
      return;
    }
    if (palette.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(cursor + 1, rows.length - 1);
      paintCursor();
      rows[cursor]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      paintCursor();
      rows[cursor]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(rows[cursor]);
    }
  });
}

function initContextMenu(root: ParentNode): void {
  const toggle = root.querySelector<HTMLElement>("[data-rs-menu-toggle]");
  const menu = root.querySelector<HTMLElement>("[data-rs-menu]");
  if (!toggle || !menu) return;

  const close = (): void => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) menu.querySelector<HTMLElement>("button")?.focus();
  });
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target as Node) && event.target !== toggle) close();
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) close();
  });

  const copyMd = menu.querySelector<HTMLElement>("[data-rs-copy-md]");
  copyMd?.addEventListener("click", () => {
    const prose = root.querySelector<HTMLElement>(".rs-prose");
    void writeClipboard(prose?.innerText ?? "");
    flash(copyMd, "Copied Markdown", close);
  });
  const copyUrl = menu.querySelector<HTMLElement>("[data-rs-copy-url]");
  copyUrl?.addEventListener("click", () => {
    void writeClipboard(location.href);
    flash(copyUrl, "Copied URL", close);
  });
}

function initFeedback(root: ParentNode): void {
  const buttons = [...root.querySelectorAll<HTMLElement>("[data-rs-feedback]")];
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.classList.toggle("is-selected", other === button);
    });
  }
}

function flash(button: HTMLElement, label: string, done: () => void): void {
  const original = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
    done();
  }, 1000);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // clipboard may be unavailable
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
