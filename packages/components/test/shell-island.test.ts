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

describe("command palette", () => {
  it("opens, filters nav entries, and offers Ask AI", () => {
    document.querySelector<HTMLElement>("[data-rs-palette-open]")?.click();
    const palette = document.querySelector<HTMLElement>("[data-rs-palette]");
    expect(palette?.hidden).toBe(false);

    const input = document.querySelector<HTMLInputElement>("[data-rs-palette-input]");
    if (input) {
      input.value = "setup";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const results = document.querySelector<HTMLElement>("[data-rs-palette-results]");
    expect(results?.textContent).toContain("Setup guide");
    expect(results?.querySelector(".is-ask")).toBeTruthy();
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
