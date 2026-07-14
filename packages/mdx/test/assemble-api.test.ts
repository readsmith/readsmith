import type { OperationContext } from "@readsmith/api-reference";
import { h } from "hastscript";
import { describe, expect, it } from "vitest";
import { type AssembleInput, type SiteConfig, assembleSite } from "../src/assemble.js";
import type { ComponentRegistry } from "../src/render.js";

/*
 * Hybrid authoring, assembly level (spec HA-1..5, HA-17, HA-21..25): the
 * `openapi:` frontmatter binds a page to an operation, sets kind and fallbacks,
 * and appends the markdown projection to rawMd and the search chunks. The
 * generated-HTML composition is the serving layer's job (slice 3), so html here
 * stays the authored body alone.
 */

const registry: ComponentRegistry = {
  Callout: { render: ({ children }) => h("aside", { className: ["callout"] }, children) },
};

/** A minimal hand-built spec context: two operations, one referenced schema. */
function specContext(): OperationContext {
  return {
    operations: [
      {
        id: "listPets",
        method: "get",
        path: "/pets",
        summary: "List pets",
        description: "Returns a page of pets. Newest first.",
        deprecated: false,
        tags: ["Pets"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Page size.",
            schema: { type: ["integer"], maximum: 100 },
          },
        ],
        responses: [{ status: "200", description: "A page of pets." }],
      },
      {
        id: "createPet",
        method: "post",
        path: "/pets",
        deprecated: true,
        tags: ["Pets"],
        parameters: [],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { ref: "Pet" } } },
        },
        responses: [{ status: "201", description: "Created." }],
      },
    ],
    schemas: {
      Pet: {
        type: ["object"],
        required: ["name"],
        properties: { name: { type: ["string"], minLength: 1 } },
      },
    },
    securitySchemes: {},
  };
}

interface Fixture {
  config: SiteConfig;
  files: Record<string, string>;
}

function fixture(files: Record<string, string>): Fixture {
  const pages = Object.keys(files).map((path) => ({
    path,
    slug: path.replace(/\.mdx?$/, ""),
  }));
  return {
    config: {
      site: { name: "Docs" },
      pages,
      nav: pages.map((p) => ({ type: "page", slug: p.slug }) as const),
    },
    files,
  };
}

function inputOf(f: Fixture, extra: Partial<AssembleInput> = {}): AssembleInput {
  return {
    config: f.config,
    readPage: (p) => {
      const src = f.files[p];
      if (src === undefined) throw new Error(`no file ${p}`);
      return src;
    },
    registry,
    apiReference: { spec: specContext(), source: "openapi.json" },
    ...extra,
  };
}

describe("openapi frontmatter binding", () => {
  it("binds a page to its operation with title and description fallbacks", async () => {
    const f = fixture({
      "api/list-pets.mdx": '---\nopenapi: "GET /pets"\n---\n\nAuthored prose about listing.\n',
    });
    const build = await assembleSite(inputOf(f));
    const page = build.pages[0];
    expect(page?.kind).toBe("api-operation");
    expect(page?.api).toMatchObject({
      ref: "GET /pets",
      operationId: "listPets",
      method: "GET",
      path: "/pets",
      tag: "Pets",
      deprecated: false,
    });
    // HA-3: no frontmatter title, so the operation summary names the page.
    expect(page?.title).toBe("List pets");
    expect(page?.description).toBe("Returns a page of pets.");
    // The authored body stays the page html; the projection rides rawMd.
    expect(page?.html).toContain("Authored prose about listing.");
    expect(page?.html).not.toContain("Query parameters");
    expect(page?.rawMd).toContain("Authored prose about listing.");
    expect(page?.rawMd).toContain("`GET /pets`");
    expect(page?.rawMd).toContain("- `limit` integer · optional · maximum: 100 — Page size.");
    expect(build.diagnostics).toHaveLength(0);
  });

  it("accepts the docs.json file-token form and warns on a mismatch", async () => {
    const ok = await assembleSite(
      inputOf(fixture({ "a.mdx": '---\nopenapi: "openapi.json GET /pets"\n---\n\nBody.\n' })),
    );
    expect(ok.pages[0]?.api?.operationId).toBe("listPets");
    expect(ok.diagnostics).toHaveLength(0);

    const mismatch = await assembleSite(
      inputOf(fixture({ "a.mdx": '---\nopenapi: "other.yaml GET /pets"\n---\n\nBody.\n' })),
    );
    // Still resolves; the token is diagnosed and ignored.
    expect(mismatch.pages[0]?.api?.operationId).toBe("listPets");
    expect(mismatch.diagnostics).toMatchObject([
      { severity: "warning", code: "openapi-file-mismatch" },
    ]);
  });

  it("feeds the projection into the agent outputs and search chunks", async () => {
    const f = fixture({
      "api/create-pet.mdx":
        '---\ntitle: Create a pet\nopenapi: "POST /pets"\n---\n\nHow to create.\n',
    });
    const build = await assembleSite(inputOf(f));
    const page = build.pages[0];
    // The referenced Pet schema's field reaches llms-full and the chunks.
    expect(build.llmsFullTxt).toContain("- `name` string · required · min length: 1");
    const apiChunk = page?.chunks.at(-1);
    expect(apiChunk?.text).toContain("`POST /pets`");
    expect(apiChunk?.path).toBe("/api/create-pet");
    expect(build.searchChunks.some((c) => c.text.includes("`POST /pets`"))).toBe(true);
    // The operation is deprecated in the spec; the binding carries it.
    expect(page?.api?.deprecated).toBe(true);
  });

  it("diagnoses unknown operations and leaves the binding unresolved", async () => {
    const f = fixture({ "a.mdx": '---\nopenapi: "DELETE /pets"\n---\n\nBody.\n' });
    const build = await assembleSite(inputOf(f));
    const page = build.pages[0];
    expect(page?.kind).toBe("api-operation");
    expect(page?.api?.operationId).toBeNull();
    expect(build.diagnostics).toMatchObject([{ severity: "error", code: "unknown-operation" }]);
  });

  it("diagnoses duplicate claims; the first page in discovery order wins", async () => {
    const f = fixture({
      "first.mdx": '---\nopenapi: "GET /pets"\n---\n\nFirst.\n',
      "second.mdx": '---\nopenapi: "GET /pets"\n---\n\nSecond.\n',
    });
    const build = await assembleSite(inputOf(f));
    expect(build.pages[0]?.api?.operationId).toBe("listPets");
    expect(build.pages[1]?.api?.operationId).toBeNull();
    expect(build.diagnostics).toMatchObject([
      { severity: "error", code: "duplicate-operation-page", source: "second.mdx" },
    ]);
  });

  it("diagnoses a missing spec, malformed refs, and ignored version keys", async () => {
    const noSpec = await assembleSite(
      inputOf(fixture({ "a.mdx": '---\nopenapi: "GET /pets"\n---\n\nBody.\n' }), {
        apiReference: null,
      }),
    );
    expect(noSpec.diagnostics).toMatchObject([
      { severity: "error", code: "openapi-not-configured" },
    ]);
    expect(noSpec.pages[0]?.kind).toBe("api-operation");

    const malformed = await assembleSite(
      inputOf(fixture({ "a.mdx": '---\nopenapi: "FETCH pets"\n---\n\nBody.\n' })),
    );
    expect(malformed.diagnostics).toMatchObject([
      { severity: "error", code: "invalid-openapi-ref" },
    ]);
    expect(malformed.pages[0]?.kind).toBe("doc");

    const versioned = await assembleSite(
      inputOf(fixture({ "a.mdx": '---\nopenapi: "GET /pets"\nversion: "1.0"\n---\n\nBody.\n' })),
    );
    expect(versioned.diagnostics).toMatchObject([
      { severity: "info", code: "openapi-version-ignored" },
    ]);
    expect(versioned.pages[0]?.api?.operationId).toBe("listPets");
  });

  it("is deterministic: two identical builds agree byte for byte", async () => {
    const files = {
      "api/list-pets.mdx": '---\nopenapi: "GET /pets"\n---\n\nProse.\n',
      "api/create-pet.mdx": '---\nopenapi: "POST /pets"\n---\n\nMore prose.\n',
    };
    const a = await assembleSite(inputOf(fixture(files)));
    const b = await assembleSite(inputOf(fixture(files)));
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(JSON.stringify(a.pages)).toBe(JSON.stringify(b.pages));
    expect(a.llmsFullTxt).toBe(b.llmsFullTxt);
  });
});

describe("links into the externally served reference", () => {
  it("validates reference links against operation ids instead of flagging them", async () => {
    const f = fixture({
      "a.mdx":
        '---\nopenapi: "GET /pets"\n---\n\nSee [create](/api-reference#createPet) and [bad](/api-reference#nope).\n',
    });
    const build = await assembleSite(
      inputOf(f, {
        apiReference: { spec: specContext(), source: "openapi.json", path: "/api-reference" },
      }),
    );
    const codes = build.diagnostics.map((d) => d.code);
    expect(codes).not.toContain("broken-link");
    expect(codes).toContain("broken-anchor");
  });
});

/** The pages-mode spec context: adds tag order, info, and servers. */
function pagesSpec() {
  return {
    ...specContext(),
    tags: [{ name: "Pets", description: "Everything about pets." }],
    info: { title: "Pets API", version: "1.0.0", description: "A tiny API." },
    servers: [{ url: "https://api.example.com/v1" }],
  };
}

describe("pages mode (HA-11/12/13)", () => {
  const pagesRef = {
    spec: pagesSpec(),
    source: "openapi.json",
    path: "/api-reference",
    layout: "pages" as const,
    label: "API Reference",
  };

  it("synthesizes unclaimed operations and a linked overview at the root", async () => {
    const f = fixture({ "index.md": "# Home\n\nWelcome.\n" });
    f.config.tabs = [{ label: "Guides", nav: [{ type: "page", slug: "index" }] }];
    const build = await assembleSite(inputOf(f, { apiReference: pagesRef }));

    const slugs = build.pages.map((p) => p.slug).sort();
    expect(slugs).toEqual([
      "api-reference",
      "api-reference/createpet",
      "api-reference/listpets",
      "index",
    ]);

    const list = build.pages.find((p) => p.slug === "api-reference/listpets");
    expect(list?.kind).toBe("api-operation");
    expect(list?.api?.operationId).toBe("listPets");
    expect(list?.title).toBe("List pets");
    expect(list?.rawMd).toContain("`GET /pets`");

    const overview = build.pages.find((p) => p.slug === "api-reference");
    expect(overview?.title).toBe("Pets API");
    expect(overview?.html).toContain('href="/api-reference/listpets"');
    expect(overview?.html).toContain("A tiny API.");
    expect(build.diagnostics).toHaveLength(0);
  });

  it("adds the reference tab with tag groups, prev/next, and tag breadcrumbs", async () => {
    const f = fixture({ "index.md": "# Home\n" });
    f.config.tabs = [{ label: "Guides", nav: [{ type: "page", slug: "index" }] }];
    const build = await assembleSite(inputOf(f, { apiReference: pagesRef }));

    const tab = build.tabs?.at(-1);
    expect(tab?.label).toBe("API Reference");
    expect(tab?.url).toBe("/api-reference");
    expect(tab?.nav[0]).toMatchObject({ type: "page", slug: "api-reference" });
    const group = tab?.nav[1];
    expect(group).toMatchObject({ type: "group", label: "Pets" });
    if (group?.type !== "group") return;
    expect(group.children.map((c) => (c.type === "page" ? c.method : ""))).toEqual(["GET", "POST"]);

    const overview = build.pages.find((p) => p.slug === "api-reference");
    const list = build.pages.find((p) => p.slug === "api-reference/listpets");
    const create = build.pages.find((p) => p.slug === "api-reference/createpet");
    expect(overview?.next?.slug).toBe("api-reference/listpets");
    expect(list?.prev?.slug).toBe("api-reference");
    expect(list?.next?.slug).toBe("api-reference/createpet");
    expect(create?.prev?.slug).toBe("api-reference/listpets");
    expect(list?.breadcrumbs.map((b) => b.label)).toEqual(["Pets", "List pets"]);
  });

  it("mirrors explicitly placed pages into the reference catalog without moving their home", async () => {
    const f = fixture({
      "index.md": "# Home\n",
      "api/create-pet.mdx": '---\nopenapi: "POST /pets"\n---\n\nAuthored.\n',
    });
    f.config.tabs = [
      {
        label: "Guides",
        nav: [
          { type: "page", slug: "index" },
          { type: "page", slug: "api/create-pet" },
        ],
      },
    ];
    const build = await assembleSite(inputOf(f, { apiReference: pagesRef }));

    // createPet is claimed AND explicitly placed: the catalog row is a MIRROR
    // at the reference slug, so opening it never leaves the reference tab.
    const mirror = build.pages.find((p) => p.slug === "api-reference/createpet");
    expect(mirror?.canonicalOf).toBe("/api/create-pet");
    expect(mirror?.html).toContain("Authored.");
    const tab = build.tabs?.at(-1);
    const group = tab?.nav.find((n) => n.type === "group");
    if (group?.type !== "group") throw new Error("no group");
    expect(group.children.map((c) => (c.type === "page" ? c.slug : ""))).toEqual([
      "api-reference/listpets",
      "api-reference/createpet",
    ]);
    // The authored page's HOME stays where the nav put it: Guides relations.
    const authored = build.pages.find((p) => p.slug === "api/create-pet");
    expect(authored?.prev?.slug).toBe("index");
    expect(authored?.breadcrumbs.at(-1)?.url).toBe("/api/create-pet");
    // The mirror owns the reference chain and breadcrumbs.
    expect(mirror?.prev?.slug).toBe("api-reference/listpets");
    expect(mirror?.breadcrumbs.at(-1)?.url).toBe("/api-reference/createpet");
    const list = build.pages.find((p) => p.slug === "api-reference/listpets");
    expect(list?.next?.slug).toBe("api-reference/createpet");
    // The overview links to the mirror: reference context stays reference.
    const overview = build.pages.find((p) => p.slug === "api-reference");
    expect(overview?.html).toContain('href="/api-reference/createpet"');
    // Listing surfaces show the page ONCE, as the authored original.
    expect(build.sitemap).toContain("/api/create-pet");
    expect(build.sitemap).not.toContain("/api-reference/createpet");
    expect(build.llmsTxt).not.toContain("/api-reference/createpet");
    expect(mirror?.chunks).toHaveLength(0);
    expect(mirror?.jsonLd).toBeNull();
  });

  it("appends the reference nav to the main sidebar on a tabless site", async () => {
    const f = fixture({ "index.md": "# Home\n" });
    const build = await assembleSite(inputOf(f, { apiReference: pagesRef }));
    expect(build.tabs).toBeUndefined();
    const group = build.nav.find((n) => n.type === "group");
    expect(group).toMatchObject({ label: "Pets" });
    const list = build.pages.find((p) => p.slug === "api-reference/listpets");
    expect(list?.breadcrumbs.length).toBeGreaterThan(0);
  });

  it("diagnoses operation slug collisions and keeps distinct URLs", async () => {
    const spec = pagesSpec();
    spec.operations = spec.operations.map((op, i) => ({
      ...op,
      id: i === 0 ? "listPets" : "listpets",
      method: op.method,
    }));
    const f = fixture({ "index.md": "# Home\n" });
    const build = await assembleSite(inputOf(f, { apiReference: { ...pagesRef, spec } }));
    const slugs = build.pages.map((p) => p.slug).filter((s) => s.startsWith("api-reference/"));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(build.diagnostics).toMatchObject([
      { severity: "error", code: "operation-slug-collision" },
    ]);
  });

  it("keeps the full catalog nav and one prefix under a subpath site.url", async () => {
    const f = fixture({
      "index.md": "# Home\n",
      "api/create-pet.mdx": '---\nopenapi: "POST /pets"\n---\n\nAuthored.\n',
    });
    f.config.site = { name: "Docs", url: "https://readsmith.dev/docs" };
    f.config.tabs = [
      {
        label: "Guides",
        nav: [
          { type: "page", slug: "index" },
          { type: "page", slug: "api/create-pet" },
        ],
      },
    ];
    const build = await assembleSite(inputOf(f, { apiReference: pagesRef }));

    // The reference tab carries the prefix exactly once and keeps EVERY
    // operation row: nav nodes address pages by slug, and slugs never carry
    // the base path (the regression was slugs derived from prefixed urls,
    // which silently dropped all catalog rows at nav finalization).
    const tab = build.tabs?.at(-1);
    expect(tab?.url).toBe("/docs/api-reference");
    const group = tab?.nav.find((n) => n.type === "group");
    if (group?.type !== "group") throw new Error("no group");
    expect(group.children.map((c) => (c.type === "page" ? c.slug : ""))).toEqual([
      "api-reference/listpets",
      "api-reference/createpet",
    ]);

    const list = build.pages.find((p) => p.slug === "api-reference/listpets");
    expect(list?.url).toBe("/docs/api-reference/listpets");
    const mirror = build.pages.find((p) => p.slug === "api-reference/createpet");
    expect(mirror?.url).toBe("/docs/api-reference/createpet");
    expect(mirror?.canonicalOf).toBe("/docs/api/create-pet");
    const overview = build.pages.find((p) => p.slug === "api-reference");
    expect(overview?.html).toContain('href="/docs/api-reference/listpets"');
    expect(build.diagnostics).toHaveLength(0);
  });

  it("is deterministic in pages mode", async () => {
    const f = () => {
      const x = fixture({ "index.md": "# Home\n" });
      x.config.tabs = [{ label: "Guides", nav: [{ type: "page", slug: "index" }] }];
      return x;
    };
    const a = await assembleSite(inputOf(f(), { apiReference: pagesRef }));
    const b = await assembleSite(inputOf(f(), { apiReference: pagesRef }));
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(JSON.stringify(a.pages)).toBe(JSON.stringify(b.pages));
  });
});

describe("openapi-schema pages (HA-15)", () => {
  it("binds a data-model page with fallbacks and the field projection", async () => {
    const f = fixture({
      "m.mdx": '---\nopenapi-schema: "Pet"\n---\n\nAuthored notes about the model.\n',
    });
    const build = await assembleSite(inputOf(f));
    const page = build.pages[0];
    expect(page?.kind).toBe("api-schema");
    expect(page?.apiSchema).toEqual({ ref: "Pet", name: "Pet" });
    // No frontmatter title and no schema title: the name names the page.
    expect(page?.title).toBe("Pet");
    expect(page?.html).toContain("Authored notes about the model.");
    expect(page?.rawMd).toContain("- `name` string · required · min length: 1");
    expect(build.llmsFullTxt).toContain("- `name` string · required · min length: 1");
    expect(build.diagnostics).toHaveLength(0);
  });

  it("accepts the file-token form and diagnoses unknown or duplicate schemas", async () => {
    const ok = await assembleSite(
      inputOf(fixture({ "m.mdx": '---\nopenapi-schema: "openapi.json Pet"\n---\n\nB.\n' })),
    );
    expect(ok.pages[0]?.apiSchema?.name).toBe("Pet");
    expect(ok.diagnostics).toHaveLength(0);

    const unknown = await assembleSite(
      inputOf(fixture({ "m.mdx": '---\nopenapi-schema: "Ghost"\n---\n\nB.\n' })),
    );
    expect(unknown.pages[0]?.kind).toBe("api-schema");
    expect(unknown.pages[0]?.apiSchema?.name).toBeNull();
    expect(unknown.diagnostics).toMatchObject([{ severity: "error", code: "unknown-schema" }]);

    const dup = await assembleSite(
      inputOf(
        fixture({
          "a.mdx": '---\nopenapi-schema: "Pet"\n---\n\nA.\n',
          "b.mdx": '---\nopenapi-schema: "Pet"\n---\n\nB.\n',
        }),
      ),
    );
    expect(dup.pages[1]?.apiSchema?.name).toBeNull();
    expect(dup.diagnostics).toMatchObject([
      { severity: "error", code: "duplicate-schema-page", source: "b.mdx" },
    ]);
  });

  it("lets the operation win when a page carries both keys", async () => {
    const f = fixture({
      "m.mdx": '---\nopenapi: "GET /pets"\nopenapi-schema: "Pet"\n---\n\nB.\n',
    });
    const build = await assembleSite(inputOf(f));
    expect(build.pages[0]?.kind).toBe("api-operation");
    expect(build.pages[0]?.api?.operationId).toBe("listPets");
    expect(build.pages[0]?.apiSchema).toBeUndefined();
    expect(build.diagnostics).toMatchObject([
      { severity: "warning", code: "openapi-schema-conflict" },
    ]);
  });
});

describe("authored pages outside the tabs (crucible regression)", () => {
  it("homes an unplaced authored page in the reference tab with relations", async () => {
    // The flat config.nav is the auto-discovered FULL tree (it includes the
    // authored page), but tabs are configured and do not place it: the page
    // must still get reference-tab relations, not be treated as explicit.
    const f = fixture({
      "index.md": "# Home\n",
      "api/create-pet.mdx": '---\nopenapi: "POST /pets"\n---\n\nAuthored.\n',
    });
    f.config.tabs = [{ label: "Guides", nav: [{ type: "page", slug: "index" }] }];
    const build = await assembleSite(
      inputOf(f, {
        apiReference: {
          spec: pagesSpec(),
          source: "openapi.json",
          path: "/api-reference",
          layout: "pages",
          label: "API Reference",
        },
      }),
    );

    const authored = build.pages.find((p) => p.slug === "api/create-pet");
    // createPet has no summary in the fixture: the METHOD /path fallback names it.
    expect(authored?.breadcrumbs.map((b) => b.label)).toEqual(["Pets", "POST /pets"]);
    expect(authored?.prev?.slug).toBe("api-reference/listpets");
    const tab = build.tabs?.at(-1);
    const group = tab?.nav.find((n) => n.type === "group");
    if (group?.type !== "group") throw new Error("no group");
    expect(group.children.map((c) => (c.type === "page" ? c.slug : ""))).toEqual([
      "api-reference/listpets",
      "api/create-pet",
    ]);
  });
});
