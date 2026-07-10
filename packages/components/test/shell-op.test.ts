import type { FinalNavNode } from "@readsmith/mdx";
import type { NormalizedSpec } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { type ShellPage, type ShellSite, renderNav, renderShellBody } from "../src/shell/index.js";

/*
 * Hybrid operation pages in the reading shell (spec HA-4, HA-6, HA-7, HA-19):
 * the console rail replaces the TOC, the composition follows title -> method
 * bar -> description -> authored prose -> generated sections, and an unresolved
 * binding degrades to a danger callout without eating the authored page.
 */

const spec: NormalizedSpec = {
  specId: "s1",
  siteId: "default",
  version: 1,
  sourceHash: "h",
  info: { title: "Pets", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  securitySchemes: {},
  tags: [{ name: "Pets" }],
  operations: [
    {
      id: "createPet",
      method: "post",
      path: "/pets",
      summary: "Create a pet",
      description: "Registers a pet, returning its record.",
      deprecated: false,
      tags: ["Pets"],
      parameters: [
        { name: "dry_run", in: "query", required: false, schema: { type: ["boolean"] } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: ["object"],
              required: ["name"],
              properties: { name: { type: ["string"] } },
            },
          },
        },
      },
      responses: [{ status: "201", description: "Created." }],
    },
  ],
  schemas: {},
};

const site: ShellSite = { name: "Readsmith", nav: [] };

const opPage: ShellPage = {
  title: "Create a pet",
  url: "/api/create-pet",
  slug: "api/create-pet",
  html: "<p>Authored guidance about creating pets.</p>",
  toc: [],
  breadcrumbs: [],
  kind: "api-operation",
  api: { ref: "POST /pets", operationId: "createPet", deprecated: false, tag: "Pets" },
};

describe("renderShellBody for api-operation pages", () => {
  it("swaps the TOC for the console rail and lifts the measure", () => {
    const html = renderShellBody(site, opPage, { apiSpec: spec });
    expect(html).toContain("rs-shell--op");
    expect(html).toContain("rs-main--op");
    expect(html).toContain("rs-op__console");
    expect(html).not.toContain("rs-toc__list");
  });

  it("composes in the spec order: title, bar, description, prose, sections", () => {
    const html = renderShellBody(site, opPage, { apiSpec: spec });
    const order = [
      '<h1 class="rs-op__title">Create a pet</h1>',
      'class="rs-op__id"',
      "Registers a pet, returning its record.",
      "Authored guidance about creating pets.",
      "query parameters",
      "Request body",
      "rs-op__console",
    ].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("uses the operation tag as the eyebrow when breadcrumbs are empty", () => {
    const html = renderShellBody(site, opPage, { apiSpec: spec });
    expect(html).toContain(
      '<nav class="rs-breadcrumbs" aria-label="Breadcrumb"><span>Pets</span></nav>',
    );
  });

  it("degrades an unresolved binding to a danger callout, keeping the prose", () => {
    const broken: ShellPage = {
      ...opPage,
      api: { ref: "POST /pets", operationId: null, deprecated: false },
    };
    const html = renderShellBody(site, broken, { apiSpec: spec });
    expect(html).toContain("rs-callout--danger");
    expect(html).toContain("POST /pets");
    expect(html).toContain("Authored guidance about creating pets.");
    expect(html).not.toContain("rs-op__console");
  });

  it("renders a doc page exactly as before (no op classes, TOC present)", () => {
    const doc: ShellPage = {
      title: "Setup",
      url: "/setup",
      slug: "setup",
      html: "<p>Body.</p>",
      toc: [{ text: "Install", anchor: "install", depth: 2, children: [] }],
      breadcrumbs: [],
    };
    const html = renderShellBody(site, doc);
    expect(html).not.toContain("rs-shell--op");
    expect(html).toContain("rs-toc__list");
  });
});

describe("renderNav method badges", () => {
  it("renders the apinav badge grammar for nav rows that carry a method", () => {
    const nav: FinalNavNode[] = [
      {
        type: "page",
        slug: "api/create-pet",
        url: "/api/create-pet",
        title: "Create a pet",
        method: "POST",
      },
      { type: "page", slug: "setup", url: "/setup", title: "Setup" },
    ];
    const html = renderNav(nav, "api/create-pet");
    expect(html).toContain("rs-nav__link--api");
    expect(html).toContain("rs-method--post");
    expect(html).toContain('<span class="rs-apinav__label">Create a pet</span>');
    // Plain pages keep the plain grammar.
    expect(html).toContain(">Setup</a>");
  });
});
