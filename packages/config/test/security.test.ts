import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/resolve.js";
import {
  buildContentSecurityPolicy,
  isSafeCspToken,
  mergeCspFromEnv,
  securityHeaders,
} from "../src/security.js";

const fixtures = join(import.meta.dirname, "fixtures");

/** Parse a policy string into directive -> sources. */
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";").map((s) => s.trim())) {
    if (!part) continue;
    const [name, ...values] = part.split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe("buildContentSecurityPolicy", () => {
  // AC-3.4
  it("AC-3.4: never allows unsafe-eval in production", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).not.toContain("unsafe-eval");
    expect(directives(csp)["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("allows unsafe-eval and websockets only in development, for HMR", () => {
    const dev = directives(buildContentSecurityPolicy({ development: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toContain("ws:");
  });

  it("locks down the dangerous defaults", () => {
    const d = directives(buildContentSecurityPolicy());
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
  });

  it("upgrades insecure requests outside development", () => {
    expect(buildContentSecurityPolicy()).toContain("upgrade-insecure-requests");
    expect(buildContentSecurityPolicy({ development: true })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  // AC-3.3
  it("AC-3.3: an operator can extend img-src and connect-src", () => {
    const csp = buildContentSecurityPolicy({
      csp: { imgSrc: ["https://img.shields.io"], connectSrc: ["https://plausible.example"] },
    });
    const d = directives(csp);
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:", "https://img.shields.io"]);
    expect(d["connect-src"]).toEqual(["'self'", "https://plausible.example"]);
  });

  it("deduplicates sources while preserving order", () => {
    const d = directives(buildContentSecurityPolicy({ csp: { imgSrc: ["'self'", "data:"] } }));
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
  });

  it("is deterministic: the same input yields the same policy string", () => {
    const opts = { csp: { imgSrc: ["https://a.dev", "https://b.dev"] } };
    expect(buildContentSecurityPolicy(opts)).toBe(buildContentSecurityPolicy(opts));
  });
});

/**
 * A source token comes from `docs.yaml`, which on a hosted tier is attacker-adjacent.
 * A token containing a semicolon would close its directive and let the author append
 * `script-src *`, turning the policy into a formality.
 */
describe("CSP token validation: no header injection", () => {
  it("rejects a token that would close the directive", () => {
    expect(isSafeCspToken("https://a.dev; script-src *")).toBe(false);
    expect(isSafeCspToken("https://a.dev,https://b.dev")).toBe(false);
    expect(isSafeCspToken("https://a.dev script-src")).toBe(false);
    expect(isSafeCspToken("a\ndefault-src *")).toBe(false);
  });

  it("accepts real sources", () => {
    for (const ok of ["'self'", "data:", "blob:", "https://img.shields.io", "*.example.com"]) {
      expect(isSafeCspToken(ok), ok).toBe(true);
    }
  });

  it("drops a malicious token instead of emitting it", () => {
    const csp = buildContentSecurityPolicy({
      csp: { imgSrc: ["https://ok.dev", "evil; script-src *"] },
    });
    expect(csp).toContain("https://ok.dev");
    expect(csp).not.toContain("evil");
    // The policy still has exactly one script-src directive.
    expect(csp.match(/script-src/g)).toHaveLength(1);
  });
});

describe("securityHeaders", () => {
  const keys = (h: { key: string }[]) => h.map((x) => x.key);

  // AC-3.1
  it("AC-3.1: always emits a CSP alongside the standard headers", () => {
    const h = securityHeaders();
    expect(keys(h)).toContain("Content-Security-Policy");
    expect(keys(h)).toContain("X-Content-Type-Options");
    expect(keys(h)).toContain("Referrer-Policy");
    expect(keys(h)).toContain("X-Frame-Options");
    expect(keys(h)).toContain("Permissions-Policy");
  });

  it("emits HSTS in production and never from a local dev server", () => {
    expect(keys(securityHeaders())).toContain("Strict-Transport-Security");
    expect(keys(securityHeaders({ development: true }))).not.toContain("Strict-Transport-Security");
  });
});

describe("mergeCspFromEnv", () => {
  it("adds the operator's sources to the site's, never replacing them", () => {
    const merged = mergeCspFromEnv(
      { imgSrc: ["https://site.example"] },
      { READSMITH_CSP_IMG_SRC: "https://op.example https://op2.example" },
    );
    expect(merged.imgSrc).toEqual([
      "https://site.example",
      "https://op.example",
      "https://op2.example",
    ]);
  });

  it("accepts comma or space separated env values, and tolerates absence", () => {
    expect(mergeCspFromEnv({}, { READSMITH_CSP_CONNECT_SRC: "a.dev, b.dev" }).connectSrc).toEqual([
      "a.dev",
      "b.dev",
    ]);
    expect(mergeCspFromEnv({}, {}).imgSrc).toEqual([]);
  });
});

describe("resolveConfig: security.csp", () => {
  it("defaults to an empty extension set", async () => {
    const config = await resolveConfig(join(fixtures, "minimal"));
    expect(config.security.csp).toEqual({});
  });
});
