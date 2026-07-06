import { describe, expect, it } from "vitest";
import { highlightCode, parseLineHighlights } from "../src/highlight.js";

// P5 spec AC-1 / HG-1: highlight to dual-theme HTML with escaped content.
describe("highlightCode", () => {
  it("highlights a known language into dual-theme HTML", async () => {
    const r = await highlightCode({ code: "const x = 1;", lang: "js" });
    expect(r.html).toContain("shiki");
    expect(r.html).toContain("--shiki-dark");
    expect(r.lang).toBe("js");
    expect(r.diagnostics).toEqual([]);
  });

  it("escapes code content so markup cannot inject", async () => {
    const r = await highlightCode({ code: "</script><b>x</b>", lang: "text" });
    expect(r.html).not.toContain("<b>");
    expect(r.html).not.toContain("</script>");
    expect(/&lt;|&#x3c;/i.test(r.html)).toBe(true);
  });

  it("falls back to plain text for an unknown language", async () => {
    const r = await highlightCode({ code: "whatever", lang: "not-a-real-lang" });
    expect(r.lang).toBe("text");
    expect(r.diagnostics.some((d) => d.code === "unknown-language")).toBe(true);
  });

  it("marks highlighted lines from the meta range", async () => {
    const r = await highlightCode({ code: "a\nb\nc", lang: "text", meta: "{2}" });
    expect(r.html).toContain("highlighted");
  });

  it("reports an invalid line range", async () => {
    const r = await highlightCode({ code: "a\nb", lang: "text", meta: "{9-2}" });
    expect(r.diagnostics.some((d) => d.code === "invalid-line-range")).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await highlightCode({ code: "const x = 1;", lang: "js" });
    const b = await highlightCode({ code: "const x = 1;", lang: "js" });
    expect(a.html).toBe(b.html);
  });
});

// P5 spec HG-4: line-range parsing.
describe("parseLineHighlights", () => {
  it("parses single lines and ranges", () => {
    const { lines } = parseLineHighlights("{1,3-5}");
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 3, 4, 5]);
  });

  it("collects invalid tokens", () => {
    const { invalid } = parseLineHighlights("{5-2,abc}");
    expect(invalid).toContain("5-2");
    expect(invalid).toContain("abc");
  });

  it("returns nothing for absent meta", () => {
    expect(parseLineHighlights(undefined).lines.size).toBe(0);
  });
});
