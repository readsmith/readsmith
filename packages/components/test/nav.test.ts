import type { FinalNavNode } from "@readsmith/mdx";
import { describe, expect, it } from "vitest";
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
});
