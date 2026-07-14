import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NormalizedSpec, SearchFilters } from "@readsmith/model";
import { z } from "zod";
import { type SearchDeps, hybridSearch } from "./retrieval.js";

/**
 * The MCP server: a read-only projection of the same indexes the UI uses (HLD
 * §8), served over the Streamable-HTTP transport by the host. Two tool classes:
 * `search_docs` (hybrid retrieval) and per-endpoint tools derived from the
 * normalized spec. No execute/write tools in v1 (that needs the exec primitive,
 * v1.1) - which is also the prompt-injection ceiling: an agent can only read.
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

export interface McpDeps {
  search: SearchDeps;
  siteId: string;
  /** Default version/locale scope for search. */
  filters: SearchFilters;
  /** The ingested API reference, or null when there is none (endpoint tools omitted). */
  spec?: Pick<NormalizedSpec, "operations"> | null;
  /** The site's agent skills; each file becomes a readable MCP resource. */
  skills?: McpSkill[];
  /** Canonical site URL; resource URIs mirror the HTTP discovery paths. */
  siteUrl?: string;
  serverName?: string;
  version?: string;
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
