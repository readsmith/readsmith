import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";

// deno-lint style helper: gather every node.type in the tree.
function collectTypes(node: unknown, acc: string[] = []): string[] {
  if (node && typeof node === "object" && typeof (node as { type?: unknown }).type === "string") {
    acc.push((node as { type: string }).type);
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) for (const c of children) collectTypes(c, acc);
  }
  return acc;
}

// P1 spec AC-1: frontmatter variants.
describe("frontmatter", () => {
  it("parses present frontmatter", () => {
    const r = parse({ path: "a.mdx", raw: "---\ntitle: Home\n---\n\n# Welcome\n" });
    expect(r.frontmatter.title).toBe("Home");
    expect(r.diagnostics).toEqual([]);
  });

  it("returns {} for absent frontmatter", () => {
    const r = parse({ path: "a.md", raw: "# Hello\n" });
    expect(r.frontmatter).toEqual({});
    expect(r.diagnostics).toEqual([]);
  });

  it("returns {} for empty frontmatter", () => {
    const r = parse({ path: "a.md", raw: "---\n---\n\n# Hello\n" });
    expect(r.frontmatter).toEqual({});
  });

  it("reports malformed frontmatter with a diagnostic, does not throw", () => {
    const r = parse({ path: "a.md", raw: "---\nfoo: [unclosed\n---\n\n# Hello\n" });
    expect(r.diagnostics.some((d) => d.code === "frontmatter-parse")).toBe(true);
  });
});

// P1 spec AC-2: `.mdx` binds JSX; `.md` treats `<` as HTML, not a component.
describe("md vs mdx", () => {
  it("parses JSX as an MDX element in .mdx", () => {
    const r = parse({ path: "a.mdx", raw: "<Note>hi</Note>\n" });
    expect(collectTypes(r.body).some((t) => t.startsWith("mdxJsx"))).toBe(true);
  });

  it("does not produce MDX element nodes in .md", () => {
    const r = parse({ path: "a.md", raw: "<Note>hi</Note>\n" });
    expect(collectTypes(r.body).some((t) => t.startsWith("mdxJsx"))).toBe(false);
    expect(r.diagnostics).toEqual([]);
  });
});

// P1 spec AC-3: AST nodes carry source positions.
describe("positions", () => {
  it("preserves source positions on nodes", () => {
    const r = parse({ path: "a.md", raw: "# Hello\n" });
    const heading = r.body.children[0] as { position?: { start?: { line: number } } };
    expect(heading.position?.start?.line).toBe(1);
  });
});

// P1 spec AC-4: malformed MDX yields a positioned diagnostic and an empty tree,
// never a thrown error.
describe("malformed mdx", () => {
  it("reports unclosed JSX and returns an empty body", () => {
    const r = parse({ path: "a.mdx", raw: "<Note>hello\n" });
    expect(r.diagnostics.some((d) => d.code === "mdx-parse")).toBe(true);
    expect(r.body.children).toHaveLength(0);
  });
});

// P1 spec AC-5: CRLF and BOM normalize to a stable AST.
describe("normalization", () => {
  it("produces identical output for CRLF and LF input", () => {
    const crlf = parse({ path: "a.md", raw: "# A\r\n\r\nB\r\n" });
    const lf = parse({ path: "a.md", raw: "# A\n\nB\n" });
    expect(crlf.body).toEqual(lf.body);
  });

  it("strips a leading BOM", () => {
    const withBom = parse({ path: "a.md", raw: "﻿# Hello\n" });
    const without = parse({ path: "a.md", raw: "# Hello\n" });
    expect(withBom.body).toEqual(without.body);
  });
});

// P1 spec AC-6: oversized input is guarded, not parsed.
describe("size guard", () => {
  it("reports a file that exceeds the parse limit", () => {
    const r = parse({ path: "a.md", raw: "a".repeat(5_000_001) });
    expect(r.diagnostics.some((d) => d.code === "file-too-large")).toBe(true);
    expect(r.body.children).toHaveLength(0);
  });
});

// P1 spec AC-7: determinism.
describe("determinism", () => {
  it("returns identical output for identical input", () => {
    const raw = "---\ntitle: X\n---\n\n# H\n\ntext\n";
    expect(parse({ path: "a.mdx", raw })).toEqual(parse({ path: "a.mdx", raw }));
  });
});
