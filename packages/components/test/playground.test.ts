import type { Operation } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { formToCurl, formToWireRequest } from "../src/api/playground.js";

const op = {
  method: "post",
  path: "/pets/{id}",
  operationId: "updatePet",
  tags: [],
  parameters: [
    { name: "id", in: "path", required: true, schema: { type: "string" }, example: "p1" },
    { name: "verbose", in: "query", required: false, schema: { type: "boolean" }, example: "true" },
  ],
  requestBody: {
    required: true,
    content: { "application/json": { schema: { example: { name: "Rex" } } } },
  },
  responses: [],
} as unknown as Operation;

const BASE = "https://api.example.com";

describe("playground request model", () => {
  it("prefills from the operation's examples", () => {
    const curl = formToCurl(op, { baseUrl: BASE });
    expect(curl).toContain(`${BASE}/pets/p1`);
    expect(curl).toContain("verbose=true");
    expect(curl).toContain("Rex");

    const wire = formToWireRequest(op, { baseUrl: BASE });
    expect(wire.method).toBe("POST");
    expect(wire.url).toBe(`${BASE}/pets/p1`);
    expect(wire.query).toEqual({ verbose: "true" });
    expect(wire.body?.value).toContain("Rex");
    expect(wire.headers?.["Content-Type"]).toBe("application/json");
  });

  it("FR-14: form overrides flow identically into the curl and the wire request", () => {
    const form = {
      baseUrl: BASE,
      params: { "path:id": "p99", "query:verbose": "false" },
      body: '{"name":"Milo"}',
      auth: { kind: "bearer", token: "TK" } as const,
    };
    const curl = formToCurl(op, form);
    const wire = formToWireRequest(op, form);

    // path + query: same in both
    expect(curl).toContain("/pets/p99");
    expect(curl).toContain("verbose=false");
    expect(wire.url).toBe(`${BASE}/pets/p99`);
    expect(wire.query).toEqual({ verbose: "false" });
    // body: same in both
    expect(curl).toContain('{"name":"Milo"}');
    expect(wire.body?.value).toBe('{"name":"Milo"}');
    // auth: curl shows the header the proxy will inject; wire carries the field
    expect(curl).toContain("Authorization: Bearer TK");
    expect(wire.auth).toEqual({ kind: "bearer", token: "TK" });
  });

  it("apiKey-in-query auth shows in the curl query and the wire auth field", () => {
    const form = {
      baseUrl: BASE,
      auth: { kind: "apiKey", in: "query", name: "api_key", value: "K" } as const,
    };
    expect(formToCurl(op, form)).toContain("api_key=K");
    expect(formToWireRequest(op, form).auth).toEqual({
      kind: "apiKey",
      in: "query",
      name: "api_key",
      value: "K",
    });
  });

  it("basic auth renders the same base64 header in the curl", () => {
    const form = { baseUrl: BASE, auth: { kind: "basic", username: "u", password: "p" } as const };
    expect(formToCurl(op, form)).toContain(`Authorization: Basic ${btoa("u:p")}`);
  });

  it("is deterministic (same form -> byte-identical curl + wire)", () => {
    const form = { baseUrl: BASE, params: { "path:id": "z" } };
    expect(formToCurl(op, form)).toBe(formToCurl(op, form));
    expect(formToWireRequest(op, form)).toEqual(formToWireRequest(op, form));
  });
});
