import { describe, expect, it } from "vitest";
import { isExecError } from "../src/errors.js";
import { buildRequest, redactHeaders } from "../src/request.js";
import type { ExecRequest, PreparedRequest } from "../src/types.js";

const dec = new TextDecoder();

function ok(req: ExecRequest, opts?: { maxRequestBytes?: number }): PreparedRequest {
  const r = buildRequest(req, opts);
  if (isExecError(r)) throw new Error(`expected ok, got ${r.code}`);
  return r;
}

describe("buildRequest bodies (FR-1)", () => {
  it("json: sets application/json and serializes", () => {
    const r = ok({
      method: "post",
      url: "https://api.example.com/x",
      body: { kind: "json", value: { a: 1 } },
    });
    expect(r.method).toBe("POST");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(dec.decode(r.body)).toBe('{"a":1}');
  });

  it("form: url-encodes with repeated keys for arrays", () => {
    const r = ok({
      method: "POST",
      url: "https://api.example.com/x",
      body: { kind: "form", value: { a: "1", tag: ["x", "y"] } },
    });
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(dec.decode(r.body)).toBe("a=1&tag=x&tag=y");
  });

  it("multipart: builds a boundary body with a file part", () => {
    const r = ok({
      method: "POST",
      url: "https://api.example.com/upload",
      body: {
        kind: "multipart",
        parts: [
          { name: "field", value: "hello" },
          { name: "file", filename: "a.txt", data: new TextEncoder().encode("DATA") },
        ],
      },
    });
    expect(r.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const text = dec.decode(r.body);
    expect(text).toContain('Content-Disposition: form-data; name="field"');
    expect(text).toContain('filename="a.txt"');
    expect(text).toContain("DATA");
  });

  it("raw: honors an explicit content type", () => {
    const r = ok({
      method: "POST",
      url: "https://api.example.com/x",
      body: { kind: "raw", value: "<x/>", contentType: "application/xml" },
    });
    expect(r.headers["content-type"]).toBe("application/xml");
    expect(dec.decode(r.body)).toBe("<x/>");
  });
});

describe("buildRequest auth injection (FR-3)", () => {
  it("bearer / basic set Authorization", () => {
    expect(
      ok({ method: "GET", url: "https://a.com/", auth: { kind: "bearer", token: "T" } }).headers
        .authorization,
    ).toBe("Bearer T");
    expect(
      ok({
        method: "GET",
        url: "https://a.com/",
        auth: { kind: "basic", username: "u", password: "p" },
      }).headers.authorization,
    ).toBe(`Basic ${btoa("u:p")}`);
  });

  it("apiKey in header / query / cookie", () => {
    expect(
      ok({
        method: "GET",
        url: "https://a.com/",
        auth: { kind: "apiKey", in: "header", name: "X-Key", value: "K" },
      }).headers["x-key"],
    ).toBe("K");
    expect(
      ok({
        method: "GET",
        url: "https://a.com/",
        auth: { kind: "apiKey", in: "query", name: "key", value: "K" },
      }).url,
    ).toBe("https://a.com/?key=K");
    expect(
      ok({
        method: "GET",
        url: "https://a.com/",
        auth: { kind: "apiKey", in: "cookie", name: "sid", value: "K" },
      }).headers.cookie,
    ).toBe("sid=K");
  });
});

describe("buildRequest query + limits + hardening", () => {
  it("merges query params into the URL", () => {
    expect(
      ok({ method: "GET", url: "https://a.com/x?a=1", query: { b: "2", c: ["3", "4"] } }).url,
    ).toBe("https://a.com/x?a=1&b=2&c=3&c=4");
  });

  it("rejects CRLF in a header value (SR-9)", () => {
    const r = buildRequest({
      method: "GET",
      url: "https://a.com/",
      headers: { "x-evil": `v${String.fromCharCode(13, 10)}Host: evil` },
    });
    expect(isExecError(r) && r.code).toBe("DENIED_MALFORMED_URL");
  });

  it("rejects an oversized body (LIMIT_SIZE_REQUEST)", () => {
    const r = buildRequest(
      { method: "POST", url: "https://a.com/", body: { kind: "raw", value: "0123456789" } },
      { maxRequestBytes: 5 },
    );
    expect(isExecError(r) && r.code).toBe("LIMIT_SIZE_REQUEST");
  });

  it("is deterministic: same input -> byte-identical output (FR-14)", () => {
    const req: ExecRequest = {
      method: "POST",
      url: "https://a.com/x",
      body: { kind: "multipart", parts: [{ name: "f", value: "v" }] },
      auth: { kind: "bearer", token: "T" },
    };
    const a = ok(req);
    const b = ok(req);
    expect(a).toEqual(b);
    expect(dec.decode(a.body)).toBe(dec.decode(b.body));
  });
});

describe("redactHeaders (SR-10)", () => {
  it("masks credential headers and never mutates the input", () => {
    const headers = {
      authorization: "Bearer secret",
      cookie: "sid=abc",
      accept: "application/json",
      "x-api-key": "k",
    };
    const red = redactHeaders(headers, ["x-api-key"]);
    expect(red.authorization).toBe("[redacted]");
    expect(red.cookie).toBe("[redacted]");
    expect(red["x-api-key"]).toBe("[redacted]");
    expect(red.accept).toBe("application/json");
    // input untouched
    expect(headers.authorization).toBe("Bearer secret");
  });
});
