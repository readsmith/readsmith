/**
 * Page-level reading-shell behaviours: theme toggle, mobile navigation,
 * scroll-spy for the on-this-page TOC, the command palette (search plus Ask-AI),
 * and the page contextual menu. Each is wired only if its markup is present, so
 * the same runtime serves a bare page and a full shell. All motion is CSS and
 * respects reduced-motion; nothing here blocks reading.
 */

/**
 * Where the JSON API is mounted. Mirrors `API_BASE_PATH` in `@readsmith/api`.
 * Not `/api`: that would shadow a docs page called `api.md`, which a
 * documentation site is unusually likely to have.
 */
// The site may be mounted under a subpath; the shell stamps it on <html> as
// data-rs-base (spec subpath-hosting SP-5). Resolved lazily: this module is
// also imported server-side, where `document` does not exist.
function api(): string {
  return `${document.documentElement.dataset.rsBase ?? ""}/_readsmith/api`;
}

export function initShell(root: ParentNode = document): void {
  // One lazy capabilities probe per hydrate, shared by the palette and console.
  // Lazy (fetched on first open) so it always reads the live rung and never
  // fires on a page nobody searches.
  const getCaps = makeCapabilities();
  initTheme(root);
  initMobileNav(root);
  initScrollSpy(root);
  initPalette(root, getCaps);
  initContextMenu(root);
  initFeedback(root);
  initAsk(root, getCaps);
}

type GetCapabilities = () => Promise<Capabilities>;

function makeCapabilities(): GetCapabilities {
  let pending: Promise<Capabilities> | null = null;
  return () => {
    if (!pending) {
      pending = fetch(`${api()}/ai/capabilities`)
        .then((r) =>
          r.ok ? (r.json() as Promise<Partial<Capabilities>>) : ({} as Partial<Capabilities>),
        )
        .then((c) => ({ search: Boolean(c.search), askAi: Boolean(c.askAi) }))
        .catch(() => ({ search: false, askAi: false }));
    }
    return pending;
  };
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
  /** HTTP method (API-reference links), e.g. "GET". */
  method?: string;
  /** The method's color modifier, e.g. "get" (for rs-method--get). */
  methodClass?: string;
  /** A one-line excerpt (server search results). */
  snippet?: string;
}

interface Capabilities {
  search: boolean;
  askAi: boolean;
}

/** The Ask-AI sparkle (inlined; the island does not import the server icon set). */
const SPARKLE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2l1.7 6.1a3 3 0 0 0 2.2 2.2L22 12l-6.1 1.7a3 3 0 0 0-2.2 2.2L12 22l-1.7-6.1a3 3 0 0 0-2.2-2.2L2 12l6.1-1.7a3 3 0 0 0 2.2-2.2z"/></svg>';

/** The hallmark stamp that marks a cited source (the signature). */
const HALLMARK =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3l7 4v6.5c0 3.6-3 6-7 7.5-4-1.5-7-3.9-7-7.5V7z"/><path d="M9.2 12l2 2 3.6-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

interface AskSource {
  ref: number;
  id: string;
  title: string;
  url: string;
}

/**
 * Runtime degradation, told plainly. `degraded` means the site has an embedding
 * key but the provider failed this request, so these are keyword hits. A 429 is
 * our own limiter, which the reader should be told apart from an outage: one asks
 * them to wait, the other asks them to give up.
 */
const SEARCH_DEGRADED = "Showing keyword results. Semantic search is unavailable.";
const SEARCH_THROTTLED = "You are searching too quickly. Showing page matches.";
const ASK_THROTTLED = "You are asking too quickly. Try again in a moment.";
const ASK_UNAVAILABLE = "Ask AI is not available right now. Please try again.";

function initPalette(root: ParentNode, getCaps: GetCapabilities): void {
  const palette = root.querySelector<HTMLElement>("[data-rs-palette]");
  const opener = root.querySelector<HTMLElement>("[data-rs-palette-open]");
  const input = palette?.querySelector<HTMLInputElement>("[data-rs-palette-input]");
  const results = palette?.querySelector<HTMLElement>("[data-rs-palette-results]");
  if (!palette || !input || !results) return;

  const index: Hit[] = [...root.querySelectorAll<HTMLAnchorElement>(".rs-nav__link")].map((a) => {
    const url = a.getAttribute("href") ?? "#";
    // API-reference links carry a method badge and a separate label; keep them
    // apart so the result shows a spaced, coloured method instead of "GETList pets".
    const methodEl = a.querySelector<HTMLElement>(".rs-method");
    const labelEl = a.querySelector<HTMLElement>(".rs-apinav__label");
    if (methodEl && labelEl) {
      const methodClass = [...methodEl.classList]
        .find((c) => c.startsWith("rs-method--") && c !== "rs-method--sm")
        ?.replace("rs-method--", "");
      return {
        title: (labelEl.textContent ?? "").trim(),
        url,
        method: (methodEl.textContent ?? "").trim(),
        ...(methodClass ? { methodClass } : {}),
      };
    }
    return { title: (a.textContent ?? "").trim(), url };
  });

  let rows: HTMLElement[] = [];
  let cursor = 0;
  let lastFocus: HTMLElement | null = null;
  let caps: Capabilities = { search: false, askAi: false };
  let searchAbort: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const paintCursor = (): void => {
    rows.forEach((row, i) => row.classList.toggle("is-cursor", i === cursor));
  };

  const rowHtml = (hit: Hit): string => {
    const verb = hit.method
      ? `<span class="rs-method rs-method--sm rs-method--${escapeAttr(hit.methodClass ?? "")}">${escapeHtml(hit.method)}</span>`
      : "";
    const snip = hit.snippet
      ? `<span class="rs-palette__snip">${escapeHtml(hit.snippet)}</span>`
      : "";
    return `<button class="rs-palette__row" data-url="${escapeAttr(hit.url)}">${verb}<span class="rs-palette__title">${escapeHtml(hit.title)}</span>${snip}</button>`;
  };

  const paint = (query: string, hits: Hit[], notice: string | null = null): void => {
    const q = query.trim();
    let html = "";
    if (q && caps.askAi) {
      html += `<button class="rs-palette__row is-ask" data-ask="1"><span class="rs-palette__ic">${SPARKLE}</span><span class="rs-palette__title">Ask AI<span class="rs-palette__q"> &mdash; &ldquo;${escapeHtml(q)}&rdquo;</span></span><span class="rs-palette__arrow">&rarr;</span></button>`;
    }
    if (hits.length > 0) {
      html += `<div class="rs-palette__group">${caps.search ? "Results" : "Pages"}</div>${hits.map(rowHtml).join("")}`;
    } else if (q) {
      html += `<div class="rs-palette__empty">No matches${caps.askAi ? " &mdash; try Ask AI" : ""}.</div>`;
    }
    // Say when the results are worse than usual. Silently serving keyword hits from
    // a site that advertises semantic search erodes trust more than one honest line.
    if (notice) html += `<div class="rs-palette__notice">${escapeHtml(notice)}</div>`;
    results.innerHTML = html;
    rows = [...results.querySelectorAll<HTMLElement>(".rs-palette__row")];
    cursor = 0;
    paintCursor();
  };

  const staticMatches = (query: string): Hit[] => {
    const q = query.trim().toLowerCase();
    return index.filter((hit) => !q || hit.title.toLowerCase().includes(q));
  };

  const mapHits = (raw: unknown): Hit[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((h: Record<string, unknown>) => {
      const method = typeof h.method === "string" ? h.method : undefined;
      return {
        title: String(h.title ?? ""),
        url: String(h.url ?? "#"),
        ...(method ? { method, methodClass: method.toLowerCase() } : {}),
        ...(typeof h.snippet === "string" ? { snippet: h.snippet } : {}),
      };
    });
  };

  const run = (query: string): void => {
    if (!caps.search) {
      paint(query, staticMatches(query));
      return;
    }
    const q = query.trim();
    if (!q) {
      paint(query, []);
      return;
    }
    paint(query, []); // keep the Ask row responsive while the request is in flight
    const mine = ++seq;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      searchAbort?.abort();
      const controller = new AbortController();
      searchAbort = controller;
      try {
        const res = await fetch(`${api()}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
          signal: controller.signal,
        });
        if (mine !== seq) return;
        if (res.status === 429) {
          paint(query, staticMatches(query), SEARCH_THROTTLED);
          return;
        }
        if (!res.ok) {
          paint(query, staticMatches(query));
          return;
        }
        const body = (await res.json()) as { hits?: unknown; degraded?: unknown };
        const hits = mapHits(body.hits);
        if (mine === seq) paint(query, hits, body.degraded === true ? SEARCH_DEGRADED : null);
      } catch (err) {
        if ((err as Error).name !== "AbortError" && mine === seq) {
          paint(query, staticMatches(query));
        }
      }
    }, 160);
  };

  const escalate = (query: string): void => {
    const q = query.trim();
    if (!q || !caps.askAi) return;
    close();
    dispatchEvent(new CustomEvent("rs:ask", { detail: { query: q } }));
  };

  const open = (): void => {
    lastFocus = document.activeElement as HTMLElement;
    palette.hidden = false;
    input.value = "";
    input.focus();
    paint("", []);
    void getCaps().then((c) => {
      caps = c;
      run(input.value);
    });
  };
  const close = (): void => {
    palette.hidden = true;
    lastFocus?.focus();
  };
  const activate = (row: HTMLElement | undefined): void => {
    if (!row) return;
    if (row.dataset.ask) {
      escalate(input.value);
      return;
    }
    if (row.dataset.url) location.assign(row.dataset.url);
    close();
  };

  opener?.addEventListener("click", open);
  input.addEventListener("input", () => run(input.value));
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
      if (event.altKey) escalate(input.value);
      else activate(rows[cursor]);
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
    const mdUrl = copyMd.dataset.rsMdUrl;
    const proseText = (): string => root.querySelector<HTMLElement>(".rs-prose")?.innerText ?? "";
    if (mdUrl) {
      fetch(mdUrl)
        .then((response) => response.text())
        .then((text) => writeClipboard(text))
        .catch(() => writeClipboard(proseText()));
    } else {
      void writeClipboard(proseText());
    }
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
  let sent = false;
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.classList.toggle("is-selected", other === button);
      // Persist once per page load; acknowledge optimistically and never
      // surface a failure - the reader's gesture is a gift, not a transaction.
      if (sent) return;
      sent = true;
      void fetch(`${api()}/page-feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: location.pathname,
          helpful: button.dataset.rsFeedback === "yes",
        }),
      }).catch(() => {});
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

/** The Ask-AI console: a dark instrument docked right, streamed + cited answers. */
function initAsk(root: ParentNode, getCaps: GetCapabilities): void {
  const panel = root.querySelector<HTMLElement>("[data-rs-ask]");
  const scroll = panel?.querySelector<HTMLElement>("[data-rs-ask-scroll]");
  const form = panel?.querySelector<HTMLFormElement>("[data-rs-ask-form]");
  const input = panel?.querySelector<HTMLTextAreaElement>("[data-rs-ask-input]");
  if (!panel || !scroll || !form || !input) return;

  const openBtn = root.querySelector<HTMLElement>("[data-rs-ask-open]");
  const body = document.body;
  let streaming = false;
  let caps: Capabilities = { search: false, askAi: false };

  const scrollDown = (): void => {
    scroll.scrollTop = scroll.scrollHeight;
  };

  const suggestions = (): string => {
    // Owner-configured starter questions (stamped on <html> by the host) win;
    // each chip asks that exact question. Otherwise derive up to three from the
    // nav titles ("Tell me about X").
    let items: { ask: string; label: string }[] = [];
    try {
      const raw = document.documentElement.dataset.rsStarters;
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        items = parsed
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .slice(0, 4)
          .map((q) => ({ ask: q.trim(), label: q.trim() }));
      }
    } catch {
      /* malformed config falls through to the nav-derived defaults */
    }
    if (items.length === 0) {
      items = [...root.querySelectorAll<HTMLElement>(".rs-nav__link")]
        .map((a) => (a.querySelector(".rs-apinav__label") ?? a).textContent?.trim() ?? "")
        .filter((t, i, all) => t.length > 2 && all.indexOf(t) === i)
        .slice(0, 3)
        .map((t) => ({ ask: `Tell me about ${t}`, label: t }));
    }
    if (items.length === 0) return "";
    return `<div class="rs-ask__chips">${items
      .map(
        (it) =>
          `<button class="rs-ask__chip" type="button" data-ask-suggest="${escapeAttr(it.ask)}">${escapeHtml(it.label)}</button>`,
      )
      .join("")}</div>`;
  };

  const resetView = (): void => {
    const title = document.documentElement.dataset.rsGreetingTitle?.trim() || "Ask the docs.";
    const intro =
      document.documentElement.dataset.rsGreetingBody?.trim() ||
      "Answers are drawn only from these docs and cite their sources.";
    scroll.innerHTML = caps.askAi
      ? `<div class="rs-ask__empty"><span class="rs-ask__mark">${SPARKLE}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(intro)}</p>${suggestions()}</div>`
      : `<div class="rs-ask__empty"><span class="rs-ask__mark">${SPARKLE}</span><h2>Ask AI isn&rsquo;t enabled.</h2><p>The maintainer can add an AI provider key to turn on cited answers over these docs.</p></div>`;
  };

  const submit = async (query: string): Promise<void> => {
    const q = query.trim();
    if (!q || streaming || !caps.askAi) return;
    scroll.querySelector(".rs-ask__empty")?.remove();
    const turn = document.createElement("div");
    turn.className = "rs-ask__turn";
    turn.innerHTML = `<div class="rs-ask__q">${escapeHtml(q)}</div><div class="rs-ask__a" data-ask-answer></div>`;
    scroll.appendChild(turn);
    const answer = turn.querySelector<HTMLElement>("[data-ask-answer]");
    if (!answer) return;
    input.value = "";
    autoGrow(input);
    streaming = true;
    scrollDown();

    let raw = "";
    let sources: AskSource[] = [];
    let queryId: string | null = null;
    let throttled = false;
    const paint = (): void => {
      answer.innerHTML =
        renderMarkdown(raw, sources) + (streaming ? '<span class="rs-ask__caret"></span>' : "");
      scrollDown();
    };
    paint();

    try {
      const res = await fetch(`${api()}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (res.status === 429) {
        throttled = true;
        throw new Error("throttled");
      }
      if (!res.ok || !res.body) throw new Error("unavailable");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n\n");
          if (nl < 0) break;
          const payload = buffer.slice(0, nl).replace(/^data:\s?/, "");
          buffer = buffer.slice(nl + 2);
          if (!payload) continue;
          let evt: { type?: string; delta?: string; sources?: AskSource[]; id?: string };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "text" && evt.delta) {
            raw += evt.delta;
            paint();
          } else if (evt.type === "sources") {
            sources = evt.sources ?? [];
          } else if (evt.type === "done") {
            queryId = evt.id ?? null;
          } else if (evt.type === "error" && !raw) {
            raw = "Sorry, I could not complete that answer.";
          }
        }
      }
    } catch {
      if (!raw) raw = throttled ? ASK_THROTTLED : ASK_UNAVAILABLE;
    }
    streaming = false;
    paint();
    if (sources.length > 0) answer.insertAdjacentHTML("afterend", renderSources(sources));
    if (queryId) answer.insertAdjacentHTML("afterend", renderFeedback(queryId));
    scrollDown();
  };

  const openPanel = (query?: string): void => {
    panel.hidden = false;
    body.classList.add("is-asking");
    openBtn?.setAttribute("aria-expanded", "true");
    if (!scroll.innerHTML.trim()) scroll.innerHTML = '<div class="rs-ask__empty"></div>';
    input.focus();
    void getCaps().then((c) => {
      caps = c;
      if (!scroll.querySelector(".rs-ask__turn")) resetView();
      if (query && c.askAi) void submit(query);
    });
  };
  const closePanel = (): void => {
    panel.hidden = true;
    body.classList.remove("is-asking");
    openBtn?.setAttribute("aria-expanded", "false");
    openBtn?.focus();
  };

  // The header button is a toggle: a second click closes the panel. Closing
  // mid-stream is safe (the panel only hides; a running answer keeps writing
  // and is there on reopen).
  openBtn?.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });
  addEventListener("rs:ask", (event) => {
    if (!panel.isConnected) return; // ignore a listener left over from a stale mount
    openPanel((event as CustomEvent<{ query: string }>).detail?.query);
  });
  panel.querySelector("[data-rs-ask-close]")?.addEventListener("click", closePanel);
  panel.querySelector("[data-rs-ask-new]")?.addEventListener("click", () => {
    if (!streaming) resetView();
  });
  panel.querySelector("[data-rs-ask-expand]")?.addEventListener("click", () => {
    body.classList.toggle("is-asking-wide");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(input.value);
  });
  input.addEventListener("input", () => autoGrow(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(input.value);
    }
  });
  scroll.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-ask-suggest]");
    if (chip) {
      void submit(chip.dataset.askSuggest ?? "");
      return;
    }
    const fb = target.closest<HTMLElement>("[data-fb]");
    const wrap = fb?.closest<HTMLElement>("[data-ask-fb]");
    if (fb && wrap?.dataset.askFb) {
      void fetch(`${api()}/ai/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: wrap.dataset.askFb, value: Number(fb.dataset.fb) }),
      }).catch(() => {});
      for (const b of wrap.querySelectorAll("button")) b.classList.remove("is-on");
      fb.classList.add("is-on");
    }
  });
  addEventListener("keydown", (event) => {
    if (!panel.isConnected) return;
    if (event.key === "Escape" && !panel.hidden && !streaming) closePanel();
  });
  initAskResize(panel, body);
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
}

function renderSources(sources: AskSource[]): string {
  return `<div class="rs-ask__sources"><span class="rs-ask__srchead">Sources</span>${sources
    .map(
      (s) =>
        `<a class="rs-ask__src" id="src-${s.ref}" href="${escapeAttr(safeUrl(s.url))}"><span class="rs-ask__stamp">${HALLMARK}</span><span class="rs-ask__srctitle">${escapeHtml(s.title)}</span></a>`,
    )
    .join("")}</div>`;
}

function renderFeedback(id: string): string {
  return `<div class="rs-ask__fb" data-ask-fb="${escapeAttr(id)}"><span>Was this helpful?</span><button type="button" data-fb="1" aria-label="Helpful">&#128077;</button><button type="button" data-fb="-1" aria-label="Not helpful">&#128078;</button></div>`;
}

/** Allow only http(s), root-relative, in-page, and mailto links; reject the rest. */
function safeUrl(url: string): string {
  const u = url.trim();
  if (/["'<>\s]/.test(u)) return "#";
  return /^(https?:\/\/|\/|#|mailto:)/i.test(u) ? u : "#";
}

/**
 * A minimal, sanitizing Markdown renderer (SEC-6): everything is HTML-escaped
 * first, then a safe subset is re-applied, so no raw HTML, script, or unsafe
 * link can survive a model answer. Citations [n] map to the cited sources.
 */
function renderMarkdown(md: string, sources: AskSource[]): string {
  const blocks: string[] = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) => {
    blocks.push(
      `<pre class="rs-ask__pre"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
    );
    return `@@RSB${blocks.length - 1}@@`;
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const safe = safeUrl(url);
    return safe === "#" ? label : `<a href="${safe}" rel="noopener" target="_blank">${label}</a>`;
  });
  const refs = new Set(sources.map((s) => s.ref));
  text = text.replace(/\[(\d+)\]/g, (_m, n: string) =>
    refs.has(Number(n))
      ? `<sup class="rs-cite"><a href="#src-${Number(n)}">${n}</a></sup>`
      : `[${n}]`,
  );
  const html = blockify(text);
  return html.replace(/@@RSB(\d+)@@/g, (_m, i: string) => blocks[Number(i)] ?? "");
}

function blockify(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const flushPara = (): void => {
    if (para.length > 0) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list.length > 0 && listType) {
      out.push(`<${listType}>${list.map((li) => `<li>${li}</li>`).join("")}</${listType}>`);
    }
    list = [];
    listType = null;
  };
  for (const line of text.split("\n")) {
    if (line.includes("@@RSB")) {
      flushPara();
      flushList();
      out.push(line);
      continue;
    }
    const t = line.trim();
    if (t === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min((heading[1] ?? "").length + 2, 5);
      out.push(`<h${level}>${heading[2] ?? ""}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(t);
    const ol = /^\d+\.\s+(.*)$/.exec(t);
    if (ul) {
      flushPara();
      if (listType !== "ul") flushList();
      listType = "ul";
      list.push(ul[1] ?? "");
      continue;
    }
    if (ol) {
      flushPara();
      if (listType !== "ol") flushList();
      listType = "ol";
      list.push(ol[1] ?? "");
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return out.join("");
}

function initAskResize(panel: HTMLElement, body: HTMLElement): void {
  const handle = panel.querySelector<HTMLElement>("[data-rs-ask-resize]");
  if (!handle) return;
  const KEY = "rs-ask-width";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) body.style.setProperty("--rs-ask-width", `${saved}px`);
  } catch {
    // ignore
  }
  const clamp = (px: number): number => Math.max(320, Math.min(px, Math.round(innerWidth * 0.6)));
  let active = false;
  const move = (event: PointerEvent): void => {
    if (active) body.style.setProperty("--rs-ask-width", `${clamp(innerWidth - event.clientX)}px`);
  };
  const up = (): void => {
    if (!active) return;
    active = false;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    try {
      const w = Number.parseInt(getComputedStyle(body).getPropertyValue("--rs-ask-width"), 10);
      if (w) localStorage.setItem(KEY, String(w));
    } catch {
      // ignore
    }
  };
  handle.addEventListener("pointerdown", (event) => {
    active = true;
    event.preventDefault();
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
