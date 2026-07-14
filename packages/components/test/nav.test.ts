import type { FinalNavNode } from "@readsmith/mdx";
import { describe, expect, it } from "vitest";
import { normalizeIconSvg } from "../src/lucide/nav-icon.js";
import { renderNav } from "../src/shell/index.js";

const page = (slug: string, title: string): FinalNavNode => ({
  type: "page",
  slug,
  url: `/${slug}`,
  title,
});

describe("renderNav (group tag + expanded)", () => {
  it("renders a group open by default with no tag", () => {
    const html = renderNav([{ type: "group", label: "Start", children: [page("a", "A")] }], "a");
    expect(html).toContain("<details");
    expect(html).toContain(" open>");
    expect(html).not.toContain("rs-nav__tag");
  });

  it("renders a tag badge beside the group label", () => {
    const html = renderNav(
      [{ type: "group", label: "Start", tag: "NEW", children: [page("a", "A")] }],
      "a",
    );
    expect(html).toContain('<span class="rs-nav__tag">NEW</span>');
  });

  it("starts a group collapsed when expanded is false", () => {
    const html = renderNav(
      [{ type: "group", label: "Advanced", expanded: false, children: [page("a", "A")] }],
      "b",
    );
    expect(html).toContain('<details class="rs-nav__group">'); // no ` open`
    expect(html).not.toContain(" open>");
  });

  it("keeps a group open when expanded is true", () => {
    const html = renderNav(
      [{ type: "group", label: "Start", expanded: true, children: [page("a", "A")] }],
      "a",
    );
    expect(html).toContain(" open>");
  });

  it("escapes the tag text", () => {
    const html = renderNav(
      [{ type: "group", label: "G", tag: "<x>", children: [page("a", "A")] }],
      "a",
    );
    expect(html).toContain("rs-nav__tag");
    expect(html).not.toContain("<x>");
  });

  it("injects a pre-resolved group icon before the label", () => {
    const svg = '<svg class="rs-nav__icon" aria-hidden="true"><path d="M1 1"/></svg>';
    const html = renderNav(
      [{ type: "group", label: "Start", icon: svg, children: [page("a", "A")] }],
      "a",
    );
    expect(html).toContain(svg);
    expect(html.indexOf("rs-nav__icon")).toBeLessThan(html.indexOf("<span>Start"));
  });
});

const RAW_LUCIDE = `<!-- @license lucide-static v1 - ISC -->
<svg
  class="lucide lucide-book"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
><path d="M4 4h16" /></svg>`;

describe("normalizeIconSvg", () => {
  it("strips the license comment and Lucide class, stamps our class + aria-hidden", () => {
    const out = normalizeIconSvg(RAW_LUCIDE);
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("lucide-book");
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).toContain('class="rs-nav__icon"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('stroke="currentColor"'); // inherits color from CSS
    expect(out).toContain('<path d="M4 4h16" />'); // the shapes survive
  });

  it("accepts a custom class name", () => {
    expect(normalizeIconSvg(RAW_LUCIDE, "rs-tab__icon")).toContain('class="rs-tab__icon"');
  });
});
