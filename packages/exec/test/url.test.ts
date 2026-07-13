import { describe, expect, it } from "vitest";
import { isExecError } from "../src/errors.js";
import { type ParsedTarget, parseTarget } from "../src/url.js";

function ok(raw: string): ParsedTarget {
  const r = parseTarget(raw);
  if (isExecError(r)) throw new Error(`expected ok, got ${r.code}`);
  return r;
}

describe("parseTarget", () => {
  it("parses a normal https URL with default port", () => {
    expect(ok("https://api.example.com/v1/pets")).toMatchObject({
      scheme: "https",
      host: "api.example.com",
      port: 443,
      isIpLiteral: false,
    });
    expect(ok("http://api.example.com:8080/x").port).toBe(8080);
  });

  it("rejects non-http(s) schemes (SR-3, AC-9)", () => {
    for (const raw of ["file:///etc/passwd", "gopher://x", "ftp://x", "data:text/plain,hi"]) {
      const r = parseTarget(raw);
      expect(isExecError(r) && r.code).toBe("DENIED_SCHEME");
    }
  });

  it("rejects userinfo tricks (SR-6)", () => {
    const r = parseTarget("http://allowed@127.0.0.1/");
    expect(isExecError(r) && r.code).toBe("DENIED_MALFORMED_URL");
  });

  it("rejects control chars and backslashes (SR-6/SR-9)", () => {
    expect(isExecError(parseTarget("http://a.com/x\r\nHost: evil"))).toBe(true);
    expect(isExecError(parseTarget("http://a.com\\@evil.com"))).toBe(true);
    expect(isExecError(parseTarget("http://a.com/ has space"))).toBe(true);
  });

  it("normalizes non-decimal IPv4 encodings to dotted-decimal (SR-6)", () => {
    // The WHATWG URL parser decodes these; we then see the real host.
    expect(ok("http://0x7f000001/").host).toBe("127.0.0.1");
    expect(ok("http://2130706433/").host).toBe("127.0.0.1");
    expect(ok("http://017700000001/").host).toBe("127.0.0.1");
    expect(ok("http://0x7f000001/").isIpLiteral).toBe(true);
  });

  it("strips IPv6 brackets and flags the literal (parser compresses to hex form)", () => {
    const r = ok("http://[::ffff:169.254.169.254]/");
    // WHATWG URL compresses the mapped-v4 tail to hex hextets; the classifier
    // still resolves it back to 169.254.169.254 (see validate.test AC-8).
    expect(r.host).toBe("::ffff:a9fe:a9fe");
    expect(r.isIpLiteral).toBe(true);
  });
});
