import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NormalizedSpec, SearchFilters } from "@readsmith/model";
import { z } from "zod";
import { type SearchDeps, hybridSearch } from "./retrieval.js";

/**
 * The MCP server: a projection of the same indexes the UI uses (HLD §8), served
 * over the Streamable-HTTP transport by the host. Read tools: `search_docs`
 * (hybrid retrieval), `list_docs` + `get_page` (the docs filesystem), and
 * per-endpoint tools from the normalized spec. The one write is `submit_feedback`
 * (non-destructive: it records a feedback row, path-validated and comment-capped).
 * No execute tools (that needs the exec primitive); an agent can read and flag,
 * never run.
 */

/** One file of an agent skill (structural mirror of the bundle's Skill type). */
export interface McpSkillFile {
  path: string;
  content: string;
}

/** An agent skill exposed as MCP resources (spec agent-skills SK-20). */
export interface McpSkill {
  name: string;
  description: string;
  /** `files[0]` is SKILL.md. */
  files: McpSkillFile[];
}

/** A documentation page exposed to agents via list_docs / get_page. */
export interface McpPage {
  title: string;
  /** The page's serving path (agents pass this to get_page / submit_feedback). */
  path: string;
  description?: string;
  /** The page's Markdown, returned by get_page. */
  markdown: string;
}

export interface McpDeps {
  search: SearchDeps;
  siteId: string;
  /** Default version/locale scope for search. */
  filters: SearchFilters;
  /** The ingested API reference, or null when there is none (endpoint tools omitted). */
  spec?: Pick<NormalizedSpec, "operations"> | null;
  /** The site's agent skills; each file becomes a readable MCP resource. */
  skills?: McpSkill[];
  /** Public pages for list_docs / get_page; absent -> those tools are omitted. */
  pages?: McpPage[];
  /** Feedback sink for submit_feedback; absent -> the write tool is omitted. */
  feedback?: (input: { path: string; helpful: boolean; comment: string }) => Promise<void>;
  /** Canonical site URL; resource URIs mirror the HTTP discovery paths. */
  siteUrl?: string;
  serverName?: string;
  version?: string;
}

/** Match a page by exact path, a URL suffix, or its trailing slug. */
function findPage(pages: McpPage[], wanted: string): McpPage | undefined {
  const w = wanted.trim();
  return pages.find(
    (p) =>
      p.path === w || p.path.endsWith(w) || p.path.replace(/^.*\//, "") === w.replace(/^.*\//, ""),
  );
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({
    name: deps.serverName ?? "readsmith-docs",
    version: deps.version ?? "1.0.0",
  });

  server.registerTool(
    "search_docs",
    {
      title: "Search the documentation",
      description:
        "Search the documentation and API reference. Returns ranked passages with source links.",
      inputSchema: {
        query: z.string().describe("The search query."),
        version: z.string().optional().describe("Docs version to scope to (default: current)."),
        locale: z.string().optional().describe("Locale to scope to (default: en)."),
      },
    },
    async ({ query, version, locale }) => {
      const { hits } = await hybridSearch(deps.search, {
        siteId: deps.siteId,
        query,
        filters: {
          version: version ?? deps.filters.version,
          locale: locale ?? deps.filters.locale,
        },
        topK: 8,
        // An agent reasons over the content: give it the whole chunk, not the
        // 200-character preview the command palette renders.
        includeText: true,
      });
      const text = hits.length
        ? hits
            .map(
              (h, i) =>
                `${i + 1}. ${h.title}${h.method ? ` (${h.method} ${h.path})` : ""}\n   ${h.url}\n   ${h.text ?? h.snippet}`,
            )
            .join("\n\n")
        : "No matching documentation found.";
      return { content: [{ type: "text", text }], structuredContent: { hits } };
    },
  );

  const spec = deps.spec;
  if (spec) {
    server.registerTool(
      "list_endpoints",
      {
        title: "List API endpoints",
        description: "List the API operations, optionally filtered by tag.",
        inputSchema: { tag: z.string().optional().describe("Only endpoints carrying this tag.") },
      },
      async ({ tag }) => {
        const endpoints = spec.operations
          .filter((op) => !tag || op.tags.includes(tag))
          .map((op) => ({
            operationId: op.id,
            method: op.method,
            path: op.path,
            summary: op.summary ?? null,
            tags: op.tags,
          }));
        const text =
          endpoints
            .map(
              (e) => `${e.method} ${e.path}  ${e.operationId}${e.summary ? ` - ${e.summary}` : ""}`,
            )
            .join("\n") || "No endpoints.";
        return { content: [{ type: "text", text }], structuredContent: { endpoints } };
      },
    );

    server.registerTool(
      "get_endpoint",
      {
        title: "Get an API endpoint",
        description:
          "Get one API operation in full (method, path, parameters, request and response schemas) by operationId.",
        inputSchema: {
          operationId: z.string().describe("The operation id, as returned by list_endpoints."),
        },
      },
      async ({ operationId }) => {
        const op = spec.operations.find((o) => o.id === operationId);
        if (!op) {
          return {
            content: [{ type: "text", text: `No endpoint with operationId "${operationId}".` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `${op.method} ${op.path}\n${op.summary ?? ""}` }],
          structuredContent: { endpoint: op },
        };
      },
    );
  }

  const pages = deps.pages;
  if (pages) {
    server.registerTool(
      "list_docs",
      {
        title: "List the documentation pages",
        description:
          "List every documentation page with its path and description. Fetch a page's full Markdown with get_page.",
        inputSchema: {
          version: z.string().optional().describe("Docs version to scope to (default: current)."),
          locale: z.string().optional().describe("Locale to scope to (default: en)."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const text = pages.length
          ? pages
              .map((p) => `${p.title} — ${p.path}${p.description ? `\n   ${p.description}` : ""}`)
              .join("\n")
          : "No pages.";
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            pages: pages.map((p) => ({ title: p.title, path: p.path, description: p.description })),
          },
        };
      },
    );

    server.registerTool(
      "get_page",
      {
        title: "Read documentation pages",
        description:
          "Fetch one or more documentation pages as Markdown by their path (from list_docs). Pass an array to read several at once.",
        inputSchema: {
          path: z
            .union([z.string(), z.array(z.string())])
            .describe("A page path, or an array of page paths."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ path }) => {
        const wanted = Array.isArray(path) ? path : [path];
        const found: McpPage[] = [];
        const missing: string[] = [];
        for (const p of wanted) {
          const page = findPage(pages, p);
          if (page) found.push(page);
          else missing.push(p);
        }
        const body = found
          .map((p) => `# ${p.title}\n<${p.path}>\n\n${p.markdown}`)
          .join("\n\n---\n\n");
        const note = missing.length ? `\n\n(No page found for: ${missing.join(", ")})` : "";
        return {
          content: [{ type: "text", text: (body + note).trim() || "No page found." }],
          structuredContent: {
            pages: found.map((p) => ({ title: p.title, path: p.path, markdown: p.markdown })),
          },
          ...(found.length === 0 ? { isError: true } : {}),
        };
      },
    );
  }

  const feedback = deps.feedback;
  if (feedback) {
    server.registerTool(
      "submit_feedback",
      {
        title: "Report a documentation problem",
        description:
          "Report that a documentation page is incorrect, outdated, confusing, or incomplete, so the maintainers can fix it.",
        inputSchema: {
          path: z.string().describe("The page path the feedback is about (from list_docs)."),
          helpful: z
            .boolean()
            .describe("Whether the page was helpful; report a problem with false."),
          comment: z.string().max(2000).describe("What is wrong or could be improved."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ path, helpful, comment }) => {
        const page = deps.pages ? findPage(deps.pages, path) : undefined;
        if (!page) {
          return {
            content: [
              { type: "text", text: `No page found for "${path}". Use list_docs for valid paths.` },
            ],
            isError: true,
          };
        }
        try {
          await feedback({ path: page.path, helpful, comment: comment.slice(0, 2000) });
        } catch (err) {
          return {
            content: [
              { type: "text", text: `Could not record feedback: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "Thanks — your feedback was recorded." }],
          structuredContent: { ok: true },
        };
      },
    );
  }

  // Agent skills as resources: a connected client discovers and reads them
  // without installing anything (the common pattern). URIs mirror the HTTP
  // discovery paths when the site has a canonical URL, so the same string works
  // in a browser; a URL-less self-host gets a readsmith:// scheme instead.
  const base = deps.siteUrl?.replace(/\/+$/, "") || "readsmith://site";
  for (const skill of deps.skills ?? []) {
    for (const file of skill.files) {
      const uri = `${base}/.well-known/skills/${skill.name}/${file.path}`;
      const isSkillMd = file.path === "SKILL.md";
      server.registerResource(
        `${skill.name}/${file.path}`,
        uri,
        {
          title: isSkillMd ? skill.name : `${skill.name}: ${file.path}`,
          ...(isSkillMd ? { description: skill.description } : {}),
          mimeType: file.path.endsWith(".md") ? "text/markdown" : "text/plain",
        },
        async () => ({
          contents: [
            {
              uri,
              mimeType: file.path.endsWith(".md") ? "text/markdown" : "text/plain",
              text: file.content,
            },
          ],
        }),
      );
    }
  }

  return server;
}
