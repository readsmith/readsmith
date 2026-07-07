import { normalizedSpecSchema } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { normalizeDocument } from "../src/normalize.js";

const src = "openapi.yaml";

describe("normalizeDocument", () => {
  it("normalizes operations, params, responses, and refs", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "Pets", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      tags: [{ name: "Pets" }],
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            tags: ["Pets"],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: { Pet: { type: "object", properties: { id: { type: "integer" } } } },
      },
    };
    const out = normalizeDocument(doc, src);
    expect(out.operations).toHaveLength(1);
    const op = out.operations[0];
    expect(op?.id).toBe("listPets");
    expect(op?.parameters[0]?.name).toBe("limit");
    // Refs are emitted as ref nodes; the component is normalized into schemas.
    expect(op?.responses[0]?.content?.["application/json"]?.schema.ref).toBe("Pet");
    expect(out.schemas.Pet?.type).toEqual(["object"]);
    // The whole thing satisfies the model contract.
    expect(() =>
      normalizedSpecSchema.parse({
        specId: "s",
        siteId: "d",
        version: 1,
        sourceHash: "h",
        ...out,
        diagnostics: undefined,
      }),
    ).not.toThrow();
  });

  it("synthesizes a stable operation id from method+path when operationId is absent", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const a = normalizeDocument(doc, src).operations[0]?.id;
    const b = normalizeDocument(doc, src).operations[0]?.id;
    expect(a).toBeTruthy();
    expect(a).toBe(b); // deterministic
  });

  it("merges allOf into a flat object (NS-1)", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          Dog: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", properties: { bark: { type: "boolean" } }, required: ["bark"] },
            ],
          },
        },
      },
    };
    const dog = normalizeDocument(doc, src).schemas.Dog;
    expect(Object.keys(dog?.properties ?? {}).sort()).toEqual(["bark", "id"]);
    expect(dog?.required?.sort()).toEqual(["bark", "id"]);
  });

  it("flags contradictory allOf constraints as conflicts, not a crash (NS-1, RG-4)", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          Bad: { allOf: [{ type: "string" }, { type: "integer" }] },
        },
      },
    };
    const bad = normalizeDocument(doc, src).schemas.Bad;
    expect(bad?.conflicts?.some((c) => c.keyword === "type")).toBe(true);
  });

  it("tags oneOf variants and resolves the discriminator (NS-2, NS-3)", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          Cat: { type: "object", properties: { petType: { type: "string" } } },
          Dog: { type: "object", properties: { petType: { type: "string" } } },
          Pet: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
            discriminator: {
              propertyName: "petType",
              mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
            },
          },
        },
      },
    };
    const pet = normalizeDocument(doc, src).schemas.Pet;
    expect(pet?.composition?.kind).toBe("oneOf");
    expect(pet?.composition?.variants.map((v) => v.ref)).toEqual(["Cat", "Dog"]);
    expect(pet?.composition?.discriminator?.mapping.cat).toBe("Cat");
  });

  it("marks cycles and does not infinitely expand (NS-4, RG-1)", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          Comment: {
            type: "object",
            properties: {
              text: { type: "string" },
              replies: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
            },
          },
        },
      },
    };
    const comment = normalizeDocument(doc, src).schemas.Comment;
    const itemsRef = comment?.properties?.replies?.items;
    expect(itemsRef?.ref).toBe("Comment");
    expect(itemsRef?.cyclic).toBe(true);
  });

  it("handles mutual recursion A->B->A", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
          B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
        },
      },
    };
    const out = normalizeDocument(doc, src);
    expect(out.schemas.A?.properties?.b?.ref).toBe("B");
    expect(out.schemas.B?.properties?.a?.ref).toBe("A");
    // one direction of the cycle is marked
    const cyclicMarked =
      out.schemas.A?.properties?.b?.cyclic === true ||
      out.schemas.B?.properties?.a?.cyclic === true;
    expect(cyclicMarked).toBe(true);
  });

  it("folds nullability into the type list for 3.0 and 3.1 (NS-5)", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: {
        schemas: {
          A: { type: "string", nullable: true },
          B: { type: ["string", "null"] },
        },
      },
    };
    const out = normalizeDocument(doc, src);
    expect(out.schemas.A?.type).toEqual(["string", "null"]);
    expect(out.schemas.B?.type).toEqual(["string", "null"]);
  });

  it("normalizes 3.0 exclusiveMinimum boolean to a numeric bound", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { schemas: { N: { type: "number", minimum: 5, exclusiveMinimum: true } } },
    };
    const n = normalizeDocument(doc, src).schemas.N;
    expect(n?.exclusiveMinimum).toBe(5);
    expect(n?.minimum).toBeUndefined();
  });

  it("preserves readOnly/writeOnly and passes x-codeSamples through", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            "x-codeSamples": [{ lang: "curl", source: "curl ..." }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { pw: { type: "string", writeOnly: true } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const op = normalizeDocument(doc, src).operations[0];
    expect(op?.codeSamples?.[0]?.lang).toBe("curl");
    const schema = op?.requestBody?.content["application/json"]?.schema;
    expect(schema?.properties?.pw?.writeOnly).toBe(true);
  });
});
