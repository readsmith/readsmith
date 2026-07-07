import type { NormalizedSchema } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { type SchemaContext, renderSchema } from "../src/api/schema-viewer.js";

const ctx = (
  schemas: Record<string, NormalizedSchema> = {},
  role?: "request" | "response",
): SchemaContext => ({ schemas, ...(role ? { role } : {}) });

describe("renderSchema (view mode)", () => {
  it("renders object properties with types and a required badge", () => {
    const schema: NormalizedSchema = {
      type: ["object"],
      required: ["id"],
      properties: {
        id: { type: ["integer"] },
        name: { type: ["string", "null"], description: "The name." },
      },
    };
    const html = renderSchema(schema, ctx());
    expect(html).toContain("id");
    expect(html).toContain("integer");
    expect(html).toContain("string | null");
    expect(html).toContain("rs-schema__req"); // required badge on id
    expect(html).toContain("The name.");
  });

  // FR-1: oneOf renders a variant selector (reusing the Tabs island).
  it("renders oneOf variants as a Tabs island with discriminator labels", () => {
    const schema: NormalizedSchema = {
      composition: {
        kind: "oneOf",
        variants: [{ ref: "Cat" }, { ref: "Dog" }],
        discriminator: { propertyName: "petType", mapping: { cat: "Cat", dog: "Dog" } },
      },
    };
    const html = renderSchema(
      schema,
      ctx({ Cat: { type: ["object"] }, Dog: { type: ["object"] } }),
    );
    expect(html).toContain('data-island="Tabs"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Discriminated by");
    expect(html).toContain(">cat<"); // discriminator mapping key as a tab label
    expect(html).toContain(">dog<");
  });

  // FR-5 / RG-1: a cyclic ref renders as a terminal chip, no infinite recursion.
  it("renders a cyclic ref as a recursive reference chip", () => {
    const schema: NormalizedSchema = {
      type: ["object"],
      properties: {
        replies: { type: ["array"], items: { ref: "Comment", cyclic: true } },
      },
    };
    const html = renderSchema(schema, ctx({ Comment: { type: ["object"] } }));
    expect(html).toContain("Comment");
    expect(html).toContain("recursive");
  });

  // RG-4: allOf merge conflicts render a warning, never a crash.
  it("renders a warning for schema conflicts", () => {
    const schema: NormalizedSchema = {
      type: ["integer"],
      conflicts: [{ keyword: "type", message: "incompatible types" }],
    };
    const html = renderSchema(schema, ctx());
    expect(html).toContain("rs-schema__warn");
    expect(html).toContain("incompatible types");
  });

  // RG-5 / RG-6: no-type and empty schemas render as "any" without throwing.
  it("renders a typeless schema as any, and an empty schema sanely", () => {
    expect(renderSchema({}, ctx())).toContain("any");
    expect(() => renderSchema({ additionalProperties: false }, ctx())).not.toThrow();
    expect(renderSchema({ additionalProperties: false }, ctx())).toContain(
      "No additional properties",
    );
  });

  // RG-7: a large enum collapses into a disclosure rather than a wall of values.
  it("collapses a large enum into a details disclosure", () => {
    const values = Array.from({ length: 40 }, (_, i) => `v${i}`);
    const html = renderSchema({ type: ["string"], enum: values }, ctx());
    expect(html).toContain("<details");
    expect(html).toContain("Allowed values (40)");
  });

  // RG-11 / FR-9: writeOnly is omitted from a response view.
  it("omits writeOnly fields in a response and readOnly fields in a request", () => {
    const schema: NormalizedSchema = {
      type: ["object"],
      properties: {
        password: { type: ["string"], writeOnly: true },
        id: { type: ["string"], readOnly: true },
        name: { type: ["string"] },
      },
    };
    const response = renderSchema(schema, ctx({}, "response"));
    expect(response).not.toContain("password");
    expect(response).toContain("id");

    const request = renderSchema(schema, ctx({}, "request"));
    expect(request).toContain("password");
    expect(request).not.toContain(">id<");
  });

  // RG-9: unicode / special property names render and stay escaped.
  it("escapes special property names and values", () => {
    const schema: NormalizedSchema = {
      type: ["object"],
      properties: { "x.y <z>": { type: ["string"], example: "<b>hi</b>" } },
    };
    const html = renderSchema(schema, ctx());
    expect(html).toContain("x.y &lt;z&gt;");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
  });

  // FR-6: deep nesting stays bounded (ref expansion stops at the depth budget).
  it("stops ref expansion at the depth budget", () => {
    const schemas: Record<string, NormalizedSchema> = {
      Deep: { type: ["object"], properties: { next: { ref: "Deep" } } },
    };
    // Deep -> next -> Deep ... second occurrence is on the seen-path, so it stops.
    const html = renderSchema({ ref: "Deep" }, { schemas, depthBudget: 3 });
    expect(html).toContain("Deep");
    // Should terminate; the produced string is finite and small.
    expect(html.length).toBeLessThan(5000);
  });
});
