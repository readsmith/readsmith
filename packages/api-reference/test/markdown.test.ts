import { describe, expect, it } from "vitest";
import { findOperation, operationToMarkdown } from "../src/markdown.js";
import { normalizeDocument } from "../src/normalize.js";

const src = "openapi.yaml";

/** A petstore-flavored fixture exercising params, body, responses, auth, refs. */
function fixture() {
  return normalizeDocument(
    {
      openapi: "3.0.0",
      info: { title: "Pets", version: "1.0.0" },
      servers: [{ url: "https://api.example.com/v1" }],
      tags: [{ name: "Pets" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
        schemas: {
          Pet: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string", readOnly: true, description: "Server-assigned id." },
              name: { type: "string", minLength: 1 },
              species: { type: "string", enum: ["dog", "cat"], default: "dog" },
              friend: { $ref: "#/components/schemas/Pet" },
              owner: { $ref: "#/components/schemas/Owner" },
            },
          },
          Owner: {
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } },
          },
        },
      },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            description: "Returns a page of pets, newest first.",
            tags: ["Pets"],
            parameters: [
              {
                name: "limit",
                in: "query",
                description: "Page size.",
                schema: { type: "integer", maximum: 100, default: 20 },
              },
            ],
            responses: {
              "200": {
                description: "A page of pets.",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
                  },
                },
              },
            },
          },
          post: {
            operationId: "createPet",
            summary: "Create a pet",
            tags: ["Pets"],
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
              },
            },
            responses: { "201": { description: "Created." } },
          },
        },
      },
    },
    src,
  );
}

describe("findOperation", () => {
  it("matches by case-insensitive method and exact path", () => {
    const spec = fixture();
    expect(findOperation(spec, "GET", "/pets")?.id).toBe("listPets");
    expect(findOperation(spec, "post", "/pets")?.id).toBe("createPet");
    expect(findOperation(spec, " Get ", " /pets ")?.id).toBe("listPets");
  });

  it("returns undefined for a miss (wrong path or method)", () => {
    const spec = fixture();
    expect(findOperation(spec, "get", "/pets/{id}")).toBeUndefined();
    expect(findOperation(spec, "delete", "/pets")).toBeUndefined();
  });
});

describe("operationToMarkdown", () => {
  it("projects method, description, params with constraints, and responses", () => {
    const spec = fixture();
    const op = findOperation(spec, "get", "/pets");
    expect(op).toBeDefined();
    if (!op) return;
    const md = operationToMarkdown(op, spec);

    expect(md).toContain("`GET /pets`");
    expect(md).toContain("Returns a page of pets, newest first.");
    expect(md).toContain("### Query parameters");
    expect(md).toContain(
      "- `limit` integer · optional · default: `20` · maximum: 100 — Page size.",
    );
    expect(md).toContain("### Responses");
    expect(md).toContain("**200** — A page of pets.");
    // The array response expands the referenced Pet's fields.
    expect(md).toContain("- `id` string · required · read-only — Server-assigned id.");
    expect(md).toContain("- `name` string · required · min length: 1");
  });

  it("projects the request body through refs, enums, and nested objects", () => {
    const spec = fixture();
    const op = findOperation(spec, "post", "/pets");
    expect(op).toBeDefined();
    if (!op) return;
    const md = operationToMarkdown(op, spec);

    expect(md).toContain("### Request body");
    expect(md).toContain("`application/json` · required");
    expect(md).toContain(
      '- `species` string · optional · default: `"dog"` · options: `"dog"`, `"cat"`',
    );
    // The nested Owner ref expands one level down, indented.
    expect(md).toContain("- `owner` Owner · optional");
    expect(md).toContain("  - `email` string (email) · required");
    // Auth falls back to the spec-level schemes.
    expect(md).toContain("### Authorizations");
    expect(md).toContain("- `bearerAuth` — HTTP bearer (JWT).");
  });

  it("marks cycles instead of recursing forever", () => {
    const spec = fixture();
    const op = findOperation(spec, "post", "/pets");
    if (!op) return;
    const md = operationToMarkdown(op, spec);
    // Pet.friend refers back to Pet: the walk stops with a marker.
    expect(md).toContain("- `friend` Pet · optional");
    expect(md).toContain("(recursive)");
  });

  it("is deterministic: same inputs, same bytes", () => {
    const a = fixture();
    const b = fixture();
    const opA = findOperation(a, "post", "/pets");
    const opB = findOperation(b, "post", "/pets");
    if (!opA || !opB) return;
    expect(operationToMarkdown(opA, a)).toBe(operationToMarkdown(opB, b));
  });
});
