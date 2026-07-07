import type { NormalizedSpec, Operation } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { endpointSearchText } from "../src/derive.js";
import { diffSpecs } from "../src/diff.js";
import { normalizeDocument } from "../src/normalize.js";
import { parseAndBundle } from "../src/parse.js";

const src = "openapi.yaml";

describe("parseAndBundle", () => {
  it("parses YAML and reports an unsupported version as a warning", async () => {
    const out = await parseAndBundle({ raw: "openapi: 2.0.0\ninfo:\n  title: t", source: src });
    expect(out.doc).not.toBeNull();
    expect(out.diagnostics.some((d) => d.code === "unsupported-version")).toBe(true);
  });

  it("returns a parse-error diagnostic (never throws) for malformed input", async () => {
    const out = await parseAndBundle({ raw: "{ not: valid: yaml: :", source: src });
    expect(out.doc).toBeNull();
    expect(out.diagnostics.some((d) => d.code === "parse-error")).toBe(true);
  });

  it("rejects an oversized document with a diagnostic (hardening)", async () => {
    const big = `openapi: 3.0.0\n# ${"x".repeat(5_000_001)}`;
    const out = await parseAndBundle({ raw: big, source: src });
    expect(out.doc).toBeNull();
    expect(out.diagnostics.some((d) => d.code === "spec-too-large")).toBe(true);
  });

  it("passes a single-file spec through with internal refs intact", async () => {
    const raw = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { schemas: { A: { $ref: "#/components/schemas/A" } } },
    });
    const out = await parseAndBundle({ raw, source: src });
    expect(out.version).toBe("3.0.0");
    expect(out.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });
});

describe("derive", () => {
  const op: Operation = {
    id: "listUsers",
    method: "get",
    path: "/users/{id}",
    summary: "Get a user",
    deprecated: false,
    tags: ["Users"],
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: ["string"] } },
      { name: "verbose", in: "query", required: false, schema: { type: ["boolean"] } },
    ],
    responses: [],
  };

  it("builds searchable endpoint text", () => {
    expect(endpointSearchText(op)).toBe("GET /users/{id} Get a user Users");
  });
});

describe("diffSpecs", () => {
  function specWith(ops: NormalizedSpec["operations"]): NormalizedSpec {
    return {
      specId: "s",
      siteId: "d",
      version: 1,
      sourceHash: "h",
      info: { title: "t", version: "1" },
      servers: [],
      securitySchemes: {},
      tags: [],
      operations: ops,
      schemas: {},
    };
  }

  it("detects a removed endpoint and a newly-required parameter as breaking", () => {
    const prev = specWith([
      {
        id: "a",
        method: "get",
        path: "/a",
        deprecated: false,
        tags: [],
        parameters: [{ name: "q", in: "query", required: false, schema: {} }],
        responses: [],
      },
      {
        id: "b",
        method: "get",
        path: "/b",
        deprecated: false,
        tags: [],
        parameters: [],
        responses: [],
      },
    ]);
    const next = specWith([
      {
        id: "a",
        method: "get",
        path: "/a",
        deprecated: false,
        tags: [],
        parameters: [{ name: "q", in: "query", required: true, schema: {} }],
        responses: [],
      },
    ]);
    const changes = diffSpecs(prev, next);
    expect(changes.some((c) => c.kind === "endpoint-removed")).toBe(true);
    expect(changes.some((c) => c.kind === "param-now-required")).toBe(true);
    expect(changes.every((c) => c.breaking)).toBe(true);
  });
});

describe("determinism", () => {
  it("normalizes the same document to identical output", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
      components: { schemas: { A: { type: "object", properties: { x: { type: "string" } } } } },
    };
    const a = JSON.stringify(normalizeDocument(doc, src));
    const b = JSON.stringify(normalizeDocument(structuredClone(doc), src));
    expect(a).toBe(b);
  });
});
