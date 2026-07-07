import { describe, expect, it } from "vitest";
import { diagnosticSchema } from "../src/common.js";
import { exportAllJsonSchemas, toJsonSchema } from "../src/json-schema.js";

// Model spec AC-5: JSON-Schema is generated for registered schemas.
describe("json-schema export", () => {
  it("emits a JSON-Schema object for a Zod schema", () => {
    const schema = toJsonSchema(diagnosticSchema) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
    expect((schema.properties as Record<string, unknown>).severity).toBeDefined();
  });

  it("exports every registered schema by name", () => {
    const all = exportAllJsonSchemas();
    expect(Object.keys(all).sort()).toEqual([
      "diagnostic",
      "normalizedSpec",
      "position",
      "searchHit",
    ]);
  });
});
