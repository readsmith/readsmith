import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { buildChunks, buildToc, project, toRawMarkdown } from "../src/projections.js";
import { assignHeadingSlugs } from "../src/transform.js";

function prepared(raw: string, kind: "md" | "mdx" = "md") {
  const { body } = parse({ path: `a.${kind}`, raw });
  assignHeadingSlugs(body); // P2 must run before P4
  return body;
}

// P4 spec AC-1 / AC-5 / JG-1: TOC structure with anchors that match P2 slugs.
describe("buildToc", () => {
  it("nests headings and reads anchors from P2 slugs", () => {
    const body = prepared("# Title\n\n## Setup\n\n### Detail\n\n## Usage\n");
    const toc = buildToc(body);
    expect(toc.map((n) => n.anchor)).toEqual(["setup", "usage"]);
    expect(toc[0]?.children.map((n) => n.anchor)).toEqual(["detail"]);
  });

  it("uses the exact slug P2 assigned to the heading node", () => {
    const body = prepared("## Hello World\n");
    const heading = body.children[0] as { data?: { id?: string } };
    expect(buildToc(body)[0]?.anchor).toBe(heading.data?.id);
  });
});

// P4 spec AC-2 / JG-2: raw Markdown unwraps components.
describe("toRawMarkdown", () => {
  it("unwraps MDX components to their content and keeps prose", () => {
    const body = prepared("<Note>Heads up</Note>\n\n# Title\n\nBody text.\n", "mdx");
    const md = toRawMarkdown(body);
    expect(md).toContain("Heads up");
    expect(md).toContain("# Title");
    expect(md).toContain("Body text.");
    expect(md).not.toContain("<Note>");
  });

  it("preserves code blocks", () => {
    const body = prepared("```js\nconst x = 1;\n```\n");
    expect(toRawMarkdown(body)).toContain("const x = 1;");
  });
});

// P4 spec AC-3 / AC-4 / JG-3 / JG-5: header-aligned chunks with citation metadata.
describe("buildChunks", () => {
  it("produces a chunk per section with anchor and header path", () => {
    const body = prepared("# Guide\n\n## Setup\n\nInstall it.\n\n## Usage\n\nUse it.\n");
    const chunks = buildChunks(body, { path: "guide.md" });
    const setup = chunks.find((c) => c.anchor === "setup");
    expect(setup).toBeDefined();
    expect(setup?.text).toContain("Install it.");
    expect(setup?.header_path).toContain("Setup");
    expect(setup?.page_id).toBe("guide.md");
  });

  it("keeps a code block whole in a single chunk", () => {
    const body = prepared("## Example\n\n```js\nlongline();\n```\n");
    const chunks = buildChunks(body, { path: "a.md" });
    expect(chunks.some((c) => c.text.includes("longline();"))).toBe(true);
  });
});

// P4 spec JG-1: TOC anchor, heading slug, and chunk anchor all agree.
describe("anchor consistency", () => {
  it("agrees across TOC, heading node, and chunks", () => {
    const body = prepared("## Configuration\n\ntext\n");
    const heading = body.children[0] as { data?: { id?: string } };
    const toc = buildToc(body);
    const chunks = buildChunks(body, { path: "a.md" });
    expect(toc[0]?.anchor).toBe(heading.data?.id);
    expect(chunks[0]?.anchor).toBe(heading.data?.id);
  });
});

// P4 spec JG-6: determinism.
describe("determinism", () => {
  it("returns identical projections for identical input", () => {
    const a = project(prepared("## A\n\nx\n"), { path: "a.md" });
    const b = project(prepared("## A\n\nx\n"), { path: "a.md" });
    expect(a).toEqual(b);
  });
});

/**
 * Search deep-links are `baseUrl + chunk.path + #anchor`, so `path` must be the
 * page URL. It used to be the source file path, which produced links like
 * `example.com../README.md#perf` once a home page lived above the content root.
 */
describe("chunk.path is a URL, not a source path", () => {
  it("uses the supplied url and keeps the source path as page_id", () => {
    const body = parse({ path: "../README.md", raw: "# Home\n\nText.\n" }).body;
    const { chunks } = project(body, { path: "../README.md", url: "/" });
    expect(chunks[0]?.path).toBe("/");
    expect(chunks[0]?.page_id).toBe("../README.md");
  });

  it("falls back to the source path when no url is given", () => {
    const body = parse({ path: "a.md", raw: "# A\n\nText.\n" }).body;
    expect(project(body, { path: "a.md" }).chunks[0]?.path).toBe("a.md");
  });
});

/**
 * A heading and the paragraph under it must not fuse. Flattening a whole chunk at
 * once produced "Quick startcrucible is a Linux daemon", which corrupts the
 * embedding and reads as a typo to any model.
 */
describe("chunk text keeps blocks apart", () => {
  it("separates a heading from its body", () => {
    const body = parse({ path: "a.md", raw: "## Quick start\n\ncrucible is a daemon.\n" }).body;
    assignHeadingSlugs(body);
    const { chunks } = project(body, { path: "a.md", url: "/a" });
    expect(chunks[0]?.text).toBe("Quick start\n\ncrucible is a daemon.");
    expect(chunks[0]?.text).not.toContain("startcrucible");
  });

  it("separates consecutive blocks, including code", () => {
    const raw = "## Install\n\nRun it:\n\n```bash\ncurl x | sh\n```\n";
    const body = parse({ path: "a.md", raw }).body;
    assignHeadingSlugs(body);
    const text = project(body, { path: "a.md", url: "/a" }).chunks[0]?.text ?? "";
    expect(text.split("\n\n")).toEqual(["Install", "Run it:", "curl x | sh"]);
  });
});
