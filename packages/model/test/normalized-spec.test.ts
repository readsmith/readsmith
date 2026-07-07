import { describe, expect, it } from "vitest";
import { toJsonSchema } from "../src/json-schema.js";
import {
  type NormalizedSpec,
  normalizedSchemaSchema,
  normalizedSpecSchema,
} from "../src/normalized-spec.js";

/** A small but representative spec: one tag, one operation, a recursive component. */
function sampleSpec(): NormalizedSpec {
  return {
    specId: "spec-1",
    siteId: "default",
    version: 1,
    sourceHash: "abc123",
    info: { title: "Pets", version: "1.0.0", description: "A pet store." },
    servers: [{ url: "https://api.example.com", variables: {} }],
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    tags: [{ name: "Pets", description: "Pet operations" }],
    operations: [
      {
        id: "listPets",
        method: "get",
        path: "/pets",
        summary: "List pets",
        deprecated: false,
        tags: ["Pets"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: ["integer"], minimum: 1, maximum: 100 },
          },
        ],
        responses: [
          {
            status: "200",
            description: "OK",
            content: {
              "application/json": {
                schema: { type: ["array"], items: { ref: "Pet" } },
              },
            },
          },
        ],
        security: [{ bearer: [] }],
      },
    ],
    schemas: {
      Pet: {
        type: ["object"],
        required: ["id"],
        properties: {
          id: { type: ["integer"] },
          name: { type: ["string", "null"] },
        },
      },
      // A cycle: a comment references itself through its replies.
      Comment: {
        type: ["object"],
        required: ["text"],
        properties: {
          text: { type: ["string"] },
          replies: { type: ["array"], items: { ref: "Comment", cyclic: true } },
        },
      },
    },
  };
}

describe("normalizedSpecSchema", () => {
  it("parses a representative spec", () => {
    const parsed = normalizedSpecSchema.parse(sampleSpec());
    expect(parsed.operations[0]?.id).toBe("listPets");
    expect(parsed.schemas.Pet?.properties?.name?.type).toEqual(["string", "null"]);
  });

  it("accepts a recursive schema marked cyclic without infinite structure", () => {
    const spec = sampleSpec();
    const comment = spec.schemas.Comment;
    const replies = comment?.properties?.replies;
    expect(replies?.items?.ref).toBe("Comment");
    expect(replies?.items?.cyclic).toBe(true);
    // It validates as a NormalizedSchema in its own right.
    expect(() => normalizedSchemaSchema.parse(comment)).not.toThrow();
  });

  it("accepts a discriminated oneOf composition", () => {
    const schema = {
      composition: {
        kind: "oneOf" as const,
        variants: [{ ref: "Cat" }, { ref: "Dog" }],
        discriminator: { propertyName: "petType", mapping: { cat: "Cat", dog: "Dog" } },
      },
    };
    const parsed = normalizedSchemaSchema.parse(schema);
    expect(parsed.composition?.kind).toBe("oneOf");
    expect(parsed.composition?.discriminator?.mapping.cat).toBe("Cat");
  });

  it("carries allOf merge conflicts as markers", () => {
    const schema = {
      type: ["integer" as const],
      conflicts: [{ keyword: "maximum", message: "minimum 5 exceeds maximum 3" }],
    };
    expect(normalizedSchemaSchema.parse(schema).conflicts?.[0]?.keyword).toBe("maximum");
  });

  it("rejects an unknown HTTP method", () => {
    const spec = sampleSpec();
    const bad = { ...spec, operations: [{ ...spec.operations[0], method: "fetch" }] };
    expect(() => normalizedSpecSchema.parse(bad)).toThrow();
  });

  it("rejects an invalid schema type", () => {
    expect(() => normalizedSchemaSchema.parse({ type: ["stringy"] })).toThrow();
  });

  it("emits JSON-Schema for the recursive model without throwing", () => {
    const json = toJsonSchema(normalizedSpecSchema) as Record<string, unknown>;
    expect(json.type).toBe("object");
    expect(json).toHaveProperty("properties");
  });
});
