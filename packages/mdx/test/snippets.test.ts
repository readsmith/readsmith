import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { type SnippetVarContext, expandSnippetsAndVariables } from "../src/snippets.js";

function text(raw: string, ctx: Partial<SnippetVarContext> = {}, kind: "md" | "mdx" = "md") {
  const { body } = parse({ path: `a.${kind}`, raw });
  const r = expandSnippetsAndVariables(body, { path: `a.${kind}`, ...ctx });
  return { text: mdastToString(r.body), diagnostics: r.diagnostics, body: r.body };
}

// Snippets that use {{var}} are authored as .md, where {{...}} is text.
// In .mdx, {{...}} is an MDX expression (a known M1 limitation).
function snippetResolver(sources: Record<string, string>) {
  return (name: string): Root | null =>
    name in sources ? parse({ path: `${name}.md`, raw: sources[name] as string }).body : null;
}

// P3 spec AC-4 / FR-3: variable interpolation and scoping.
describe("variables", () => {
  it("interpolates a page variable", () => {
    expect(text("Hello {{name}}!", { page: { name: "World" } }).text).toBe("Hello World!");
  });

  it("lets a page variable override a global", () => {
    expect(text("{{n}}", { global: { n: "G" }, page: { n: "P" } }).text).toBe("P");
  });

  it("reports an unknown variable and renders empty", () => {
    const r = text("Hi {{unknown}}.");
    expect(r.diagnostics.some((d) => d.code === "missing-variable")).toBe(true);
    expect(r.text).toBe("Hi .");
  });

  it("leaves {{...}} inside a code block literal", () => {
    const r = text("```\n{{name}}\n```\n", { page: { name: "X" } });
    expect(r.text).toContain("{{name}}");
  });
});

// P3 spec AC-1 / AC-2 / FR-1 / FR-2: snippet inclusion and props.
describe("snippets", () => {
  const resolveSnippet = snippetResolver({
    note: "Reusable note.",
    greet: "Hello {{who}}.",
    outer: '<Snippet file="note" />',
  });

  it("inlines a snippet in .mdx", () => {
    expect(text('<Snippet file="note" />', { resolveSnippet }, "mdx").text).toContain(
      "Reusable note.",
    );
  });

  it("inlines a snippet in .md", () => {
    expect(text('<Snippet file="note" />', { resolveSnippet }, "md").text).toContain(
      "Reusable note.",
    );
  });

  it("passes props as variables into the snippet scope", () => {
    expect(text('<Snippet file="greet" who="Team" />', { resolveSnippet }, "mdx").text).toContain(
      "Hello Team.",
    );
  });

  it("inlines nested snippets", () => {
    expect(text('<Snippet file="outer" />', { resolveSnippet }, "mdx").text).toContain(
      "Reusable note.",
    );
  });

  it("reports a missing snippet", () => {
    const r = text('<Snippet file="nope" />', { resolveSnippet }, "mdx");
    expect(r.diagnostics.some((d) => d.code === "snippet-missing")).toBe(true);
  });
});

// P3 spec SG-1 / SG-2: cycles and depth are reported, never looped.
describe("cycles and depth", () => {
  it("detects a self-referential cycle without looping", () => {
    const resolveSnippet = snippetResolver({ a: '<Snippet file="a" />' });
    const r = text('<Snippet file="a" />', { resolveSnippet }, "mdx");
    expect(r.diagnostics.some((d) => d.code === "snippet-cycle")).toBe(true);
  });

  it("stops an infinite distinct-name chain at the depth limit", () => {
    const resolveSnippet = (name: string): Root | null =>
      parse({ path: `${name}.mdx`, raw: `<Snippet file="${name}x" />` }).body;
    const r = text('<Snippet file="s" />', { resolveSnippet }, "mdx");
    expect(r.diagnostics.some((d) => d.code === "snippet-depth")).toBe(true);
  });
});

// P3 spec: determinism.
describe("determinism", () => {
  it("returns identical output for identical input", () => {
    const resolveSnippet = snippetResolver({ note: "Note {{x}}." });
    const a = text('<Snippet file="note" x="1" />', { resolveSnippet }, "mdx");
    const b = text('<Snippet file="note" x="1" />', { resolveSnippet }, "mdx");
    expect(a.body).toEqual(b.body);
  });
});
