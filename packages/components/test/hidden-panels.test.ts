import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ShellPage, type ShellSite, renderShellBody } from "../src/shell/index.js";

/**
 * Any element the shell renders with a `hidden` attribute is hidden by the
 * user-agent rule `[hidden] { display: none }`. That rule loses to *any* author
 * rule that sets `display` on the same element, because author styles beat the
 * UA stylesheet. So a panel with `.rs-x { display: flex }` and no
 * `.rs-x[hidden]` override is visible from page load, and setting `el.hidden`
 * does nothing: its close button looks broken.
 *
 * The Ask-AI console shipped exactly that way. This test walks the rendered
 * markup instead of enumerating panels by hand, so the next one is caught too.
 */

const css = readFileSync(join(import.meta.dirname, "../styles/shell.css"), "utf8");

const site: ShellSite = { name: "Docs", nav: [] };
const page: ShellPage = {
  title: "Setup",
  url: "/setup",
  slug: "setup",
  html: "<h1>Setup</h1>",
  toc: [],
  breadcrumbs: [],
};

/** Every element rendered with a `hidden` attribute, paired with its first class. */
function hiddenElements(html: string): { tag: string; className: string }[] {
  const out: { tag: string; className: string }[] = [];
  for (const m of html.matchAll(/<([a-z]+)\b([^>]*\bhidden\b[^>]*)>/g)) {
    const tag = m[1] ?? "";
    const attrs = m[2] ?? "";
    const cls = /class="([^"]+)"/.exec(attrs)?.[1]?.split(/\s+/)[0];
    if (cls) out.push({ tag, className: cls });
  }
  return out;
}

/** Does any rule set `display` on this bare class selector? */
function setsDisplay(className: string): boolean {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*\\bdisplay\\s*:`, "s");
  return rule.test(css);
}

function hasHiddenOverride(className: string): boolean {
  return new RegExp(`\\.${className}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, "s").test(css);
}

describe("panels rendered with [hidden] stay hidden", () => {
  const rendered = hiddenElements(renderShellBody(site, page));

  it("the shell actually renders some hidden panels", () => {
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("every hidden panel that sets display also overrides [hidden]", () => {
    const offenders = rendered
      .filter((el) => setsDisplay(el.className))
      .filter((el) => !hasHiddenOverride(el.className))
      .map((el) => `.${el.className}`);
    expect(offenders, "missing a `[hidden] { display: none }` override").toEqual([]);
  });

  it("the Ask-AI console specifically (the one that shipped broken)", () => {
    expect(setsDisplay("rs-ask")).toBe(true);
    expect(hasHiddenOverride("rs-ask")).toBe(true);
  });
});
