import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NormalizedSpec } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import {
  type McpDeps,
  type McpPage,
  type RetrievalStore,
  type RetrievedChunk,
  createMcpServer,
  createMockProvider,
} from "../src/index.js";

const samplePages: McpPage[] = [
  { title: "Setup", path: "/setup", description: "Get started", markdown: "# Setup\n\nDo this." },
  { title: "API", path: "/api/intro", markdown: "# API\n\nIntro." },
];
const text0 = (res: unknown): string =>
  (res as { content?: { text?: string }[] }).content?.[0]?.text ?? "";

const hit: RetrievedChunk = {
  id: "s1",
  kind: "doc",
  pageId: "p1",
  path: "/setup",
  headerPath: ["Guide", "Setup"],
  anchor: "s",
  method: null,
  text: "Set the API key in your environment before running.",
};

const store: RetrievalStore = {
  async vectorSearch() {
    return [];
  },
  async ftsSearch() {
    return [hit];
  },
};

const oneOp: Pick<NormalizedSpec, "operations"> = {
  operations: [
    {
      id: "listUsers",
      method: "get",
      path: "/users",
      summary: "List users",
      deprecated: false,
      tags: ["Users"],
      parameters: [],
      responses: [],
    },
  ],
};

function connect(deps: McpDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  return Promise.all([server.connect(serverTransport), client.connect(clientTransport)]).then(
    () => client,
  );
}

const baseDeps = (over: Partial<McpDeps> = {}): McpDeps => ({
  search: { store, provider: createMockProvider({ hasEmbedding: false }) },
  siteId: "default",
  filters: { version: "current", locale: "en" },
  ...over,
});

describe("MCP server", () => {
  it("exposes search_docs (+ endpoint tools with a spec), and no execute tool", async () => {
    const client = await connect(baseDeps({ spec: oneOp }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_docs");
    expect(names).toContain("list_endpoints");
    expect(names).toContain("get_endpoint");
    expect(names.some((n) => /exec|run|call|write|update|delete/i.test(n))).toBe(false);
    await client.close();
  });

  it("omits endpoint tools when there is no API reference", async () => {
    const client = await connect(baseDeps({ spec: null }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["search_docs"]);
    await client.close();
  });

  it("search_docs returns ranked hits", async () => {
    const client = await connect(baseDeps());
    const res = await client.callTool({ name: "search_docs", arguments: { query: "setup" } });
    const structured = res.structuredContent as { hits: { id: string }[] };
    expect(structured.hits.map((h) => h.id)).toEqual(["s1"]);
    await client.close();
  });

  it("list_endpoints and get_endpoint project the normalized spec", async () => {
    const client = await connect(baseDeps({ spec: oneOp }));
    const list = await client.callTool({ name: "list_endpoints", arguments: {} });
    const endpoints = (list.structuredContent as { endpoints: { operationId: string }[] })
      .endpoints;
    expect(endpoints.map((e) => e.operationId)).toEqual(["listUsers"]);

    const got = await client.callTool({
      name: "get_endpoint",
      arguments: { operationId: "listUsers" },
    });
    const endpoint = (got.structuredContent as { endpoint: { method: string; path: string } })
      .endpoint;
    expect(endpoint.method).toBe("get");
    expect(endpoint.path).toBe("/users");
    await client.close();
  });
});

describe("MCP docs tools (list_docs / get_page / submit_feedback)", () => {
  it("registers the read tools only with pages, and the write tool only with feedback", async () => {
    const none = (await (await connect(baseDeps())).listTools()).tools.map((t) => t.name);
    expect(none).not.toContain("list_docs");
    expect(none).not.toContain("submit_feedback");

    const reads = (await (await connect(baseDeps({ pages: samplePages }))).listTools()).tools.map(
      (t) => t.name,
    );
    expect(reads).toContain("list_docs");
    expect(reads).toContain("get_page");
    expect(reads).not.toContain("submit_feedback");

    const withWrite = (
      await (await connect(baseDeps({ pages: samplePages, feedback: async () => {} }))).listTools()
    ).tools.map((t) => t.name);
    expect(withWrite).toContain("submit_feedback");
  });

  it("list_docs lists every page with its path", async () => {
    const client = await connect(baseDeps({ pages: samplePages }));
    const res = await client.callTool({ name: "list_docs", arguments: {} });
    expect(
      (res.structuredContent as { pages: { path: string }[] }).pages.map((p) => p.path),
    ).toEqual(["/setup", "/api/intro"]);
    expect(text0(res)).toContain("Setup — /setup");
    await client.close();
  });

  it("get_page returns markdown, batches an array, and flags unknown paths", async () => {
    const client = await connect(baseDeps({ pages: samplePages }));
    const one = await client.callTool({ name: "get_page", arguments: { path: "/setup" } });
    expect(text0(one)).toContain("Do this.");

    const many = await client.callTool({
      name: "get_page",
      arguments: { path: ["/setup", "/api/intro", "/nope"] },
    });
    const t = text0(many);
    expect(t).toContain("Do this.");
    expect(t).toContain("Intro.");
    expect(t).toContain("No page found for: /nope");

    const miss = await client.callTool({ name: "get_page", arguments: { path: "/nope" } });
    expect(miss.isError).toBe(true);
    await client.close();
  });

  it("get_page matches by a bare slug", async () => {
    const client = await connect(baseDeps({ pages: samplePages }));
    const res = await client.callTool({ name: "get_page", arguments: { path: "setup" } });
    expect(text0(res)).toContain("Do this.");
    await client.close();
  });

  it("submit_feedback validates the path and records helpful + comment", async () => {
    const calls: { path: string; helpful: boolean; comment: string }[] = [];
    const client = await connect(
      baseDeps({
        pages: samplePages,
        feedback: async (input) => {
          calls.push(input);
        },
      }),
    );
    const bad = await client.callTool({
      name: "submit_feedback",
      arguments: { path: "/nope", helpful: false, comment: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const ok = await client.callTool({
      name: "submit_feedback",
      arguments: { path: "/setup", helpful: false, comment: "This is outdated." },
    });
    expect(ok.isError).toBeFalsy();
    expect(calls).toEqual([{ path: "/setup", helpful: false, comment: "This is outdated." }]);
    await client.close();
  });
});

// Spec agent-skills SK-20 / AC-4: skills ride along as readable resources.
describe("skill resources", () => {
  const skills = [
    {
      name: "pets",
      description: "Use when integrating the Pets API.",
      files: [
        { path: "SKILL.md", content: "# Pets skill\n" },
        { path: "references/extra.md", content: "Extra reference.\n" },
      ],
    },
  ];

  it("lists one resource per skill file with HTTP-mirroring URIs", async () => {
    const client = await connect(baseDeps({ skills, siteUrl: "https://docs.example.com/" }));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([
      "https://docs.example.com/.well-known/skills/pets/SKILL.md",
      "https://docs.example.com/.well-known/skills/pets/references/extra.md",
    ]);
    expect(resources[0]?.description).toBe("Use when integrating the Pets API.");
    expect(resources[0]?.mimeType).toBe("text/markdown");
    await client.close();
  });

  it("reads back the same bytes the HTTP route serves", async () => {
    const client = await connect(baseDeps({ skills, siteUrl: "https://docs.example.com" }));
    const read = await client.readResource({
      uri: "https://docs.example.com/.well-known/skills/pets/SKILL.md",
    });
    expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown", text: "# Pets skill\n" });
    await client.close();
  });

  it("falls back to a readsmith:// scheme when the site has no canonical URL", async () => {
    const client = await connect(baseDeps({ skills }));
    const { resources } = await client.listResources();
    expect(resources[0]?.uri).toBe("readsmith://site/.well-known/skills/pets/SKILL.md");
    await client.close();
  });
});
