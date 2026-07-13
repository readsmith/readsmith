import { describe, expect, it } from "vitest";
import { isExecError } from "../src/errors.js";
import { parseProxyRequest } from "../src/schema.js";
import type { ExecRequest } from "../src/types.js";

function ok(json: unknown): ExecRequest {
  const r = parseProxyRequest(json);
  if (isExecError(r)) throw new Error(`expected ok, got ${r.code}`);
  return r;
}

describe("parseProxyRequest", () => {
  it("accepts a well-formed request with a json body and bearer auth", () => {
    const r = ok({
      method: "POST",
      url: "https://api.example.com/v1/pets",
      headers: { accept: "application/json" },
      query: { page: "1", tag: ["a", "b"] },
      body: { kind: "json", value: { name: "Rex" } },
      auth: { kind: "bearer", token: "T" },
    });
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({ kind: "json", value: { name: "Rex" } });
    expect(r.auth).toEqual({ kind: "bearer", token: "T" });
  });

  it("decodes multipart file parts from base64 into bytes", () => {
    const r = ok({
      method: "POST",
      url: "https://api.example.com/upload",
      body: {
        kind: "multipart",
        parts: [
          { name: "note", value: "hi" },
          { name: "file", filename: "a.bin", dataBase64: btoa("DATA") },
        ],
      },
    });
    if (r.body?.kind !== "multipart") throw new Error("expected multipart");
    const filePart = r.body.parts[1];
    if (!filePart || !("data" in filePart)) throw new Error("expected a file part");
    expect(new TextDecoder().decode(filePart.data)).toBe("DATA");
  });

  it("rejects a malformed request (missing url)", () => {
    const r = parseProxyRequest({ method: "GET" });
    expect(isExecError(r) && r.code).toBe("DENIED_MALFORMED_URL");
  });

  it("rejects a non-object payload", () => {
    expect(isExecError(parseProxyRequest(null))).toBe(true);
    expect(isExecError(parseProxyRequest("nope"))).toBe(true);
  });

  it("rejects an unknown auth kind", () => {
    const r = parseProxyRequest({ method: "GET", url: "https://a.com/", auth: { kind: "hmac" } });
    expect(isExecError(r) && r.code).toBe("DENIED_MALFORMED_URL");
  });

  it("rejects invalid base64 in a file part", () => {
    const r = parseProxyRequest({
      method: "POST",
      url: "https://a.com/",
      body: {
        kind: "multipart",
        parts: [{ name: "f", filename: "x", dataBase64: "@@@not-base64@@@" }],
      },
    });
    expect(isExecError(r) && r.code).toBe("DENIED_MALFORMED_URL");
  });
});
