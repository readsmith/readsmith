import { describe, expect, it } from "vitest";
import { cursorInstallUrl, renderContextMenu, vscodeInstallUrl } from "../src/shell/contextual.js";

const base = {
  mdUrl: "/docs/md/guide",
  prompt: encodeURIComponent('Read https://x.dev/docs/md/guide about the "Guide" page.'),
  serverName: "acme-docs",
  mcpUrl: "https://x.dev/docs/mcp",
};

describe("renderContextMenu", () => {
  it("always offers Copy page URL, and Copy/View markdown for copy+view", () => {
    const html = renderContextMenu({ ...base, options: ["copy", "view"] });
    expect(html).toContain("data-rs-copy-url");
    expect(html).toContain("Copy as Markdown");
    expect(html).toContain('data-rs-md-url="/docs/md/guide"');
    expect(html).toContain("View as Markdown");
  });

  it("renders each AI provider with its verified deep-link and the preloaded prompt", () => {
    const html = renderContextMenu({ ...base, options: ["chatgpt", "claude", "perplexity"] });
    expect(html).toContain(`https://chatgpt.com/?q=${base.prompt}`);
    expect(html).toContain(`https://claude.ai/new?q=${base.prompt}`);
    expect(html).toContain(`https://www.perplexity.ai/search?q=${base.prompt}`);
    expect(html).toContain("Open in Perplexity");
  });

  it("honors option order within the AI group", () => {
    const html = renderContextMenu({ ...base, options: ["claude", "chatgpt"] });
    expect(html.indexOf("claude.ai")).toBeLessThan(html.indexOf("chatgpt.com"));
  });

  it("shows the MCP connect group only when an mcpUrl is present", () => {
    const withMcp = renderContextMenu({ ...base, options: ["cursor", "vscode", "mcp"] });
    expect(withMcp).toContain("Add to Cursor");
    expect(withMcp).toContain("Add to VS Code");
    expect(withMcp).toContain("data-rs-copy-mcp");
    expect(withMcp).toContain('data-rs-mcp-url="https://x.dev/docs/mcp"');

    const { mcpUrl, ...noMcp } = base;
    const html = renderContextMenu({ ...noMcp, options: ["cursor", "vscode", "mcp"] });
    expect(html).not.toContain("Add to Cursor");
    expect(html).not.toContain("data-rs-copy-mcp");
  });

  it("separates the page / AI / connect groups with a rule, omitting empty groups", () => {
    const full = renderContextMenu({
      ...base,
      options: ["copy", "view", "chatgpt", "cursor"],
    });
    expect(full.match(/rs-menu__sep/g)?.length).toBe(2); // page | ai | connect

    const pageOnly = renderContextMenu({ ...base, options: ["copy"] });
    expect(pageOnly).not.toContain("rs-menu__sep"); // one group, no rule
  });

  it("escapes the ampersands in the Cursor deep link for the HTML attribute", () => {
    const html = renderContextMenu({ ...base, options: ["cursor"] });
    expect(html).toContain("&amp;config="); // raw & would break the attribute
  });
});

describe("MCP install deep links", () => {
  it("cursor: base64-encoded {url} config in the documented deeplink path", () => {
    const url = cursorInstallUrl("acme-docs", "https://x.dev/docs/mcp");
    expect(
      url.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=acme-docs&config="),
    ).toBe(true);
    const config = new URL(url).searchParams.get("config") ?? "";
    expect(JSON.parse(atob(config))).toEqual({ url: "https://x.dev/docs/mcp" });
  });

  it("vscode: url-encoded {name,type:http,url} JSON on the vscode:mcp/install scheme", () => {
    const url = vscodeInstallUrl("acme-docs", "https://x.dev/docs/mcp");
    expect(url.startsWith("vscode:mcp/install?")).toBe(true);
    const json = decodeURIComponent(url.slice("vscode:mcp/install?".length));
    expect(JSON.parse(json)).toEqual({
      name: "acme-docs",
      type: "http",
      url: "https://x.dev/docs/mcp",
    });
  });
});
