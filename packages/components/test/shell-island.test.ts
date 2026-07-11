// @vitest-environment happy-dom
import type { FinalNavNode } from "@readsmith/mdx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrate } from "../src/islands/index.js";
import { type ShellPage, type ShellSite, renderShellBody } from "../src/shell/index.js";

const nav: FinalNavNode[] = [
  { type: "page", slug: "", url: "/", title: "Introduction" },
  { type: "page", slug: "setup", url: "/setup", title: "Setup guide" },
];
const site: ShellSite = { name: "Readsmith", nav };
const page: ShellPage = {
  title: "Setup",
  url: "/setup",
  slug: "setup",
  html: '<h1>Setup</h1><h2 id="install">Install</h2><p>x</p>',
  toc: [{ text: "Install", anchor: "install", depth: 2, children: [] }],
  breadcrumbs: [{ label: "Setup" }],
};

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = renderShellBody(site, page);
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  hydrate();
});

describe("theme toggle", () => {
  it("flips and persists the theme", () => {
    document.querySelector<HTMLElement>("[data-rs-theme-toggle]")?.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("rs-theme")).toBe("dark");
  });
});

function typeQuery(value: string): HTMLElement | null {
  const input = document.querySelector<HTMLInputElement>("[data-rs-palette-input]");
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return document.querySelector<HTMLElement>("[data-rs-palette-results]");
}

describe("command palette", () => {
  it("loads capabilities, searches the server, and offers Ask AI", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/ai/capabilities")) {
        return { ok: true, json: async () => ({ search: true, askAi: true }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          hits: [
            { title: "Setup guide", url: "/setup", snippet: "how to set up", method: null },
            { title: "List pets", url: "/api-reference#listPets", method: "GET" },
          ],
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    document.querySelector<HTMLElement>("[data-rs-palette-open]")?.click();
    const results = typeQuery("pets");
    await vi.waitFor(() => expect(results?.textContent).toContain("List pets"));
    expect(results?.querySelector(".is-ask")).toBeTruthy();
    expect(results?.querySelector(".rs-method")?.textContent).toBe("GET");

    const asked = vi.fn();
    addEventListener("rs:ask", asked as EventListener);
    results?.querySelector<HTMLElement>(".is-ask")?.click();
    expect(asked).toHaveBeenCalled();
    removeEventListener("rs:ask", asked as EventListener);
    vi.unstubAllGlobals();
  });

  it("falls back to the static nav filter when search is unavailable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    document.querySelector<HTMLElement>("[data-rs-palette-open]")?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const results = typeQuery("setup");
    await vi.waitFor(() => expect(results?.textContent).toContain("Setup guide"));
    expect(results?.querySelector(".is-ask")).toBeFalsy(); // no Ask row without the capability
    vi.unstubAllGlobals();
  });
});

function sseResponse(events: unknown[]): Response {
  const enc = new TextEncoder();
  const chunks = events.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response;
}

describe("Ask-AI console", () => {
  it("streams a cited answer and records feedback", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/ai/capabilities")) {
        return { ok: true, json: async () => ({ search: true, askAi: true }) } as Response;
      }
      if (url.includes("/api/ask")) {
        return sseResponse([
          { type: "text", delta: "Use a bearer token" },
          { type: "text", delta: " in the header [1]." },
          {
            type: "sources",
            sources: [{ ref: 1, id: "s1", title: "Authentication", url: "/g#auth" }],
          },
          { type: "done", id: "q-123" },
        ]);
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    dispatchEvent(new CustomEvent("rs:ask", { detail: { query: "how do I auth?" } }));
    const scroll = document.querySelector<HTMLElement>("[data-rs-ask-scroll]");
    await vi.waitFor(() => expect(scroll?.querySelector(".rs-ask__src")).toBeTruthy());

    expect(scroll?.textContent).toContain("Use a bearer token");
    expect(scroll?.querySelector(".rs-cite a")?.getAttribute("href")).toBe("#src-1");
    expect(scroll?.querySelector(".rs-ask__src")?.textContent).toContain("Authentication");
    expect(document.body.classList.contains("is-asking")).toBe(true);

    scroll?.querySelector<HTMLElement>('[data-fb="1"]')?.click();
    // The JSON API is mounted under /_readsmith so a docs page may own /api.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/_readsmith/api/ai/feedback",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    vi.unstubAllGlobals();
  });

  it("renders model markdown safely (no raw HTML or script)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/ai/capabilities")) {
        return { ok: true, json: async () => ({ search: false, askAi: true }) } as Response;
      }
      return sseResponse([
        { type: "text", delta: "Safe **bold** but <script>alert(1)</script> and " },
        { type: "text", delta: "[link](javascript:alert(2))." },
        { type: "done", id: "q-2" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    dispatchEvent(new CustomEvent("rs:ask", { detail: { query: "xss?" } }));
    const scroll = document.querySelector<HTMLElement>("[data-rs-ask-scroll]");
    await vi.waitFor(() => expect(scroll?.textContent).toContain("alert(1)"));

    expect(scroll?.querySelector("script")).toBeNull(); // escaped, not executed
    expect(scroll?.querySelector(".rs-ask__a strong")?.textContent).toBe("bold");
    // javascript: link is neutralised to plain text, no anchor with that href
    expect(scroll?.innerHTML).not.toContain("javascript:");
    vi.unstubAllGlobals();
  });
});

describe("contextual menu", () => {
  it("opens and copies the page URL", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    document.querySelector<HTMLElement>("[data-rs-menu-toggle]")?.click();
    const menu = document.querySelector<HTMLElement>("[data-rs-menu]");
    expect(menu?.hidden).toBe(false);

    document.querySelector<HTMLElement>("[data-rs-copy-url]")?.click();
    expect(writeText).toHaveBeenCalledWith(location.href);
  });
});

describe("mobile nav", () => {
  it("opens the nav column and shows the scrim", () => {
    document.querySelector<HTMLElement>("[data-rs-nav-toggle]")?.click();
    expect(document.querySelector("[data-rs-navcol]")?.classList.contains("is-open")).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-rs-scrim]")?.hidden).toBe(false);
  });
});

describe("Ask-AI header toggle", () => {
  it("opens on first click, closes on the second, and tracks aria-expanded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ search: false, askAi: false }) })),
    );
    const btn = document.querySelector<HTMLElement>("[data-rs-ask-open]");
    const panel = document.querySelector<HTMLElement>("[data-rs-ask]");
    expect(panel?.hidden).toBe(true);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");

    btn?.click();
    expect(panel?.hidden).toBe(false);
    expect(document.body.classList.contains("is-asking")).toBe(true);
    expect(btn?.getAttribute("aria-expanded")).toBe("true");

    btn?.click();
    expect(panel?.hidden).toBe(true);
    expect(document.body.classList.contains("is-asking")).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
  });
});
