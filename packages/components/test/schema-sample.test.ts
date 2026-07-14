import type { NormalizedSchema } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { jsoncToJson, sampleBodySkeleton, synthExample } from "../src/api/schema-sample.js";

const s = (schema: NormalizedSchema): NormalizedSchema => schema;

describe("sampleBodySkeleton", () => {
  it("fills required keys and comments optional ones", () => {
    const schema = s({
      type: ["object"],
      required: ["query"],
      properties: {
        query: s({ type: ["string"] }),
        version: s({ type: ["string"] }),
        locale: s({ type: ["string"] }),
      },
    });
    const skeleton = sampleBodySkeleton(schema, {});
    expect(skeleton).toBe(
      [
        "{",
        '  "query": "string",',
        '  // "version": "string",',
        '  // "locale": "string"',
        "}",
      ].join("\n"),
    );
    // The skeleton normalizes to valid JSON carrying only the required key.
    expect(jsoncToJson(skeleton)).toBe('{"query":"string"}');
  });

  it("resolves a top-level $ref to read its properties and required", () => {
    const schemas = {
      ScopedQuery: s({
        type: ["object"],
        required: ["query"],
        properties: { query: s({ type: ["string"] }), locale: s({ type: ["string"] }) },
      }),
    };
    const skeleton = sampleBodySkeleton(s({ ref: "ScopedQuery" }), schemas);
    expect(skeleton).toContain('"query": "string"');
    expect(skeleton).toContain('// "locale": "string"');
  });

  it("omits readOnly (server-assigned) fields from a request body", () => {
    const schema = s({
      type: ["object"],
      required: ["id", "name"],
      properties: {
        id: s({ type: ["string"], readOnly: true }),
        name: s({ type: ["string"] }),
      },
    });
    const skeleton = sampleBodySkeleton(schema, {});
    expect(skeleton).not.toContain('"id"');
    expect(skeleton).toContain('"name": "string"');
  });

  it("uses typed placeholders and enum/format hints", () => {
    const schema = s({
      type: ["object"],
      required: ["count", "active", "when", "kind"],
      properties: {
        count: s({ type: ["integer"] }),
        active: s({ type: ["boolean"] }),
        when: s({ type: ["string"], format: "date-time" }),
        kind: s({ type: ["string"], enum: ["a", "b"] }),
      },
    });
    const json = JSON.parse(jsoncToJson(sampleBodySkeleton(schema, {})));
    expect(json).toEqual({ count: 0, active: false, when: "2026-01-02T15:04:05Z", kind: "a" });
  });

  it("falls back to a plain example when the schema is not an object", () => {
    expect(sampleBodySkeleton(s({ type: ["array"], items: s({ type: ["string"] }) }), {})).toBe(
      '[\n  "string"\n]',
    );
  });
});

describe("jsoncToJson", () => {
  it("strips line and block comments and trailing commas", () => {
    const src = `{
      "a": 1, // trailing
      /* block */ "b": 2,
    }`;
    expect(jsoncToJson(src)).toBe('{"a":1,"b":2}');
  });

  it("preserves a // sequence inside a string value (a URL)", () => {
    expect(jsoncToJson('{"url":"https://example.com/x"}')).toBe('{"url":"https://example.com/x"}');
  });

  it("keeps enabling an optional key once its comment is removed", () => {
    const edited = ["{", '  "query": "hi",', '  "locale": "en"', "}"].join("\n");
    expect(jsoncToJson(edited)).toBe('{"query":"hi","locale":"en"}');
  });

  it("returns comment-stripped text when the result is still invalid JSON", () => {
    expect(jsoncToJson('{ "a": } // x')).toBe('{ "a": }');
  });
});

describe("synthExample direction", () => {
  it("drops writeOnly in responses and readOnly in requests", () => {
    const schema = s({
      type: ["object"],
      properties: {
        password: s({ type: ["string"], writeOnly: true }),
        id: s({ type: ["string"], readOnly: true }),
      },
    });
    expect(synthExample(schema, {}, "response")).toEqual({ id: "string" });
    expect(synthExample(schema, {}, "request")).toEqual({ password: "string" });
  });
});
