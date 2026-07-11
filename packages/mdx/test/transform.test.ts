import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { assignHeadingSlugs, transform } from "../src/transform.js";

function headingId(body: unknown, index: number): unknown {
  const children = (body as { children: unknown[] }).children;
  return (children[index] as { data?: { id?: unknown } }).data?.id;
}

// P2 spec AC-2 / TG-1: deterministic, page-unique heading slugs.
describe("assignHeadingSlugs", () => {
  it("slugs headings and disambiguates duplicates", () => {
    const { body } = parse({ path: "a.md", raw: "# Hello World\n\n## Hello World\n" });
    assignHeadingSlugs(body);
    expect(headingId(body, 0)).toBe("hello-world");
    expect(headingId(body, 1)).toBe("hello-world-1");
  });

  it("is deterministic", () => {
    const a = parse({ path: "a.md", raw: "# A\n\n# A\n" });
    const b = parse({ path: "a.md", raw: "# A\n\n# A\n" });
    assignHeadingSlugs(a.body);
    assignHeadingSlugs(b.body);
    expect(a.body).toEqual(b.body);
  });
});

// GitHub-flavored alerts become callouts: one source renders natively on
// github.com AND as a first-class callout here (the dual-render contract).
describe("resolveGitHubAlerts", () => {
  const alertNode = (body: unknown): { type: string; name?: string; attributes?: unknown[] } => {
    const node = (body as { children: { type: string; name?: string; attributes?: unknown[] }[] })
      .children[0];
    if (!node) throw new Error("empty document body");
    return node;
  };

  it("converts every alert kind in plain .md, mapping to callout types", () => {
    const cases: Array<[string, string]> = [
      ["NOTE", "note"],
      ["TIP", "tip"],
      ["IMPORTANT", "info"],
      ["WARNING", "warning"],
      ["CAUTION", "danger"],
    ];
    for (const [marker, kind] of cases) {
      const { body } = parse({ path: "a.md", raw: `> [!${marker}]\n> The body text.\n` });
      transform(body, { path: "a.md" });
      const node = alertNode(body);
      expect(node.type).toBe("mdxJsxFlowElement");
      expect(node.name).toBe("Callout");
      expect(node.attributes).toMatchObject([{ name: "type", value: kind }]);
    }
  });

  it("keeps multi-block bodies and strips only the marker line", () => {
    const raw = "> [!WARNING]\n> First line.\n>\n> Second paragraph with `code`.\n";
    const { body } = parse({ path: "a.md", raw });
    transform(body, { path: "a.md" });
    const node = alertNode(body) as unknown as { children: { type: string }[] };
    expect(node.children).toHaveLength(2);
    expect(node.children.every((c) => c.type === "paragraph")).toBe(true);
  });

  it("leaves ordinary blockquotes and lookalikes alone", () => {
    const plain = parse({ path: "a.md", raw: "> Just a quote.\n" });
    transform(plain.body, { path: "a.md" });
    expect(plain.body.children[0]?.type).toBe("blockquote");

    const unknown = parse({ path: "a.md", raw: "> [!DANGER]\n> Not a GitHub marker.\n" });
    transform(unknown.body, { path: "a.md" });
    expect(unknown.body.children[0]?.type).toBe("blockquote");

    const inlinePrefix = parse({ path: "a.md", raw: "> [!NOTE] same-line text\n" });
    transform(inlinePrefix.body, { path: "a.md" });
    expect(inlinePrefix.body.children[0]?.type).toBe("blockquote");
  });

  it("works in .mdx too", () => {
    const { body } = parse({ path: "a.mdx", raw: "> [!TIP]\n> Try the CLI.\n" });
    transform(body, { path: "a.mdx" });
    expect(alertNode(body).name).toBe("Callout");
  });
});

// P2 spec AC-3 / TG-2 / TG-4: internal link resolution and broken-link reporting.
describe("resolveLinks", () => {
  const resolvePage = (target: string): string | null => {
    const known: Record<string, string> = { intro: "intro", "guide/other": "guide/other" };
    return known[target] ?? null;
  };

  it("resolves a relative link to a canonical page URL", () => {
    const { body } = parse({ path: "guide/setup.mdx", raw: "[Intro](../intro.md)\n" });
    const { diagnostics } = transform(body, { path: "guide/setup.mdx", resolvePage });
    const link = firstLink(body);
    expect(link.url).toBe("/intro");
    expect(diagnostics).toEqual([]);
  });

  it("preserves an anchor when resolving", () => {
    const { body } = parse({ path: "guide/setup.mdx", raw: "[Intro](../intro.md#usage)\n" });
    transform(body, { path: "guide/setup.mdx", resolvePage });
    expect(firstLink(body).url).toBe("/intro#usage");
  });

  it("reports a relative link that resolves to no page", () => {
    const { body } = parse({ path: "guide/setup.mdx", raw: "[Missing](./missing.md)\n" });
    const { diagnostics } = transform(body, { path: "guide/setup.mdx", resolvePage });
    expect(diagnostics.some((d) => d.code === "broken-link")).toBe(true);
  });

  it("leaves external, absolute, and mailto links untouched", () => {
    for (const url of ["https://example.com", "/already/absolute", "mailto:x@y.com"]) {
      const { body } = parse({ path: "a.md", raw: `[x](${url})\n` });
      const { diagnostics } = transform(body, { path: "a.md", resolvePage });
      expect(firstLink(body).url).toBe(url);
      expect(diagnostics).toEqual([]);
    }
  });
});

// P2 spec FR-1: GFM works in both .md and .mdx.
describe("gfm", () => {
  it("parses a table in .mdx", () => {
    const { body } = parse({ path: "a.mdx", raw: "| a | b |\n| - | - |\n| 1 | 2 |\n" });
    expect(body.children.some((n) => n.type === "table")).toBe(true);
  });
});

function firstLink(body: unknown): { url: string } {
  let found: { url: string } | undefined;
  const walk = (node: unknown): void => {
    if (found) return;
    if (node && typeof node === "object") {
      if ((node as { type?: string }).type === "link") {
        found = node as { url: string };
        return;
      }
      const children = (node as { children?: unknown[] }).children;
      if (Array.isArray(children)) for (const c of children) walk(c);
    }
  };
  walk(body);
  if (!found) throw new Error("no link node found");
  return found;
}
