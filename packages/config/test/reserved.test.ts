import { describe, expect, it } from "vitest";
import {
  MCP_CANONICAL_PATH,
  RESERVED_PATHS,
  mcpAlias,
  reservedPathConflicts,
} from "../src/reserved.js";
import type { PageRef } from "../src/schema.js";

const page = (path: string, slug: string): PageRef => ({ path, slug });

/**
 * A docs page that lands on a URL the app serves is unreachable, and in Next the
 * collision breaks the shadowed route too: the router finds a static page and a
 * route handler for one path and throws "Dynamic server usage". Nothing warned.
 */
describe("reservedPathConflicts", () => {
  it("says nothing about ordinary pages", () => {
    expect(reservedPathConflicts([page("cli.md", "cli"), page("../README.md", "")])).toEqual([]);
  });

  it("does NOT reserve /api: that is the whole point of the /_readsmith prefix", () => {
    expect(RESERVED_PATHS).not.toContain("/api");
    expect(reservedPathConflicts([page("api.md", "api")])).toEqual([]);
    expect(reservedPathConflicts([page("api/auth.md", "api/auth")])).toEqual([]);
  });

  it("errors on a page that claims a hard-reserved path", () => {
    const [d] = reservedPathConflicts([page("md.md", "md")]);
    expect(d?.severity).toBe("error");
    expect(d?.code).toBe("reserved-path");
    expect(d?.message).toContain('"/md"');
  });

  it("errors on a page nested beneath a reserved path", () => {
    expect(reservedPathConflicts([page("md/x.md", "md/x")])).toHaveLength(1);
    expect(reservedPathConflicts([page("api-reference/x.md", "api-reference/x")])).toHaveLength(1);
  });

  it("errors on the generated text files", () => {
    for (const slug of ["llms.txt", "sitemap.xml", "robots.txt", "skill.md", "rss.xml"]) {
      expect(reservedPathConflicts([page(`${slug}.md`, slug)]), slug).toHaveLength(1);
    }
  });

  it("errors on pages under .well-known (agent-skills discovery)", () => {
    expect(reservedPathConflicts([page(".well-known/x.md", ".well-known/x")])).toHaveLength(1);
  });

  it("warns, not errors, when a page takes /mcp: the page wins and nothing breaks", () => {
    const [d] = reservedPathConflicts([page("mcp.md", "mcp")]);
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain(MCP_CANONICAL_PATH);
  });
});

describe("mcpAlias", () => {
  it("offers /mcp when no page claims it", () => {
    expect(mcpAlias([page("cli.md", "cli")])).toBe("/mcp");
  });

  it("yields /mcp to a docs page", () => {
    expect(mcpAlias([page("mcp.md", "mcp")])).toBeNull();
  });

  it("honors a configured override", () => {
    expect(mcpAlias([page("mcp.md", "mcp")], "/mcp-server")).toBe("/mcp-server");
  });

  it("yields a configured override that a page also claims", () => {
    expect(mcpAlias([page("mcp-server.md", "mcp-server")], "/mcp-server")).toBeNull();
  });
});
