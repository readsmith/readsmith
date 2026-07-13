import { describe, expect, it } from "vitest";
import { isExecError } from "../src/errors.js";
import { parseTarget } from "../src/url.js";
import { type TargetAllowlist, checkResolvedIp, checkTarget } from "../src/validate.js";

function target(raw: string) {
  const r = parseTarget(raw);
  if (isExecError(r)) throw new Error(`parse failed: ${r.code}`);
  return r;
}

const ALLOW: TargetAllowlist = [
  { scheme: "https", host: "api.example.com", port: 443 },
  { scheme: "http", host: "localhost", port: 3000 },
];

describe("checkTarget", () => {
  it("allows an allowlisted host+scheme+port", () => {
    expect(checkTarget(target("https://api.example.com/v1"), ALLOW)).toEqual({ ok: true });
  });

  it("denies an unknown host (DENIED_NOT_ALLOWLISTED)", () => {
    const r = checkTarget(target("https://evil.com/"), ALLOW);
    expect(isExecError(r) && r.code).toBe("DENIED_NOT_ALLOWLISTED");
  });

  it("denies a known host on a non-allowlisted port (DENIED_PORT)", () => {
    const r = checkTarget(target("https://api.example.com:9999/"), ALLOW);
    expect(isExecError(r) && r.code).toBe("DENIED_PORT");
  });

  it("AC-6: denies the metadata IP even when it is on the allowlist (SR-2)", () => {
    const allow: TargetAllowlist = [{ scheme: "http", host: "169.254.169.254", port: 80 }];
    const r = checkTarget(target("http://169.254.169.254/latest/meta-data/"), allow);
    expect(isExecError(r) && r.code).toBe("DENIED_PRIVATE_IP");
  });

  it("AC-8: denies obfuscated loopback/metadata (decimal/hex/mapped) before allowlist even matters", () => {
    for (const raw of [
      "http://0x7f000001/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata, bracketed
    ]) {
      const r = checkTarget(target(raw), ALLOW);
      expect(isExecError(r) && r.code).toBe("DENIED_PRIVATE_IP");
    }
  });

  it("allows a public IP literal only when allowlisted", () => {
    const allow: TargetAllowlist = [{ scheme: "https", host: "8.8.8.8", port: 443 }];
    expect(checkTarget(target("https://8.8.8.8/"), allow)).toEqual({ ok: true });
    // public but not allowlisted -> denied
    expect(isExecError(checkTarget(target("https://1.1.1.1/"), allow))).toBe(true);
  });
});

describe("checkResolvedIp (SR-5 post-resolution)", () => {
  it("denies a domain that resolves to a private IP", () => {
    const r = checkResolvedIp("10.0.0.5");
    expect(isExecError(r) && r.code).toBe("DENIED_PRIVATE_IP");
  });
  it("allows a domain that resolves to a public IP", () => {
    expect(checkResolvedIp("93.184.216.34")).toEqual({ ok: true });
  });
});
