import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "../src/redact.js";
import { stableStringify } from "../src/serialize.js";

// Model spec AC-2: serializing a DTO that carries a secret must not leak it.
describe("redactSecrets", () => {
  it("redacts secret-bearing keys, including nested ones", () => {
    const input = {
      authorization: "Bearer sk-secret-123",
      auth: { token: "sk-token-xyz" },
      headers: { cookie: "session=abc" },
      author: "Jane Doe",
      title: "Getting Started",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.authorization).toBe(REDACTED);
    expect(out.auth).toBe(REDACTED);
    expect((out.headers as Record<string, unknown>).cookie).toBe(REDACTED);
  });

  it("preserves non-secret fields, including 'author' (not 'auth')", () => {
    const out = redactSecrets({ author: "Jane Doe", title: "Intro" }) as Record<string, unknown>;
    expect(out.author).toBe("Jane Doe");
    expect(out.title).toBe("Intro");
  });

  it("leaves no secret material in the serialized output", () => {
    const input = { authorization: "Bearer sk-secret-123", nested: { apiKey: "sk-token-xyz" } };
    const serialized = stableStringify(redactSecrets(input, ["apiKey"]));
    expect(serialized).not.toContain("sk-secret-123");
    expect(serialized).not.toContain("sk-token-xyz");
  });

  it("supports caller-specified extra secret keys", () => {
    const out = redactSecrets({ sessionToken: "x" }, ["sessionToken"]) as Record<string, unknown>;
    expect(out.sessionToken).toBe(REDACTED);
  });
});
