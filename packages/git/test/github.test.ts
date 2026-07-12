import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createGitHubProvider, mintAppJwt } from "../src/github.js";
import { makeTarGz } from "./tar-util.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
}

/** A scripted GitHub API: records calls, serves canned JSON + one tarball. */
function mockGitHub(tarball: Buffer) {
  const calls: Call[] = [];
  let exchanges = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization") ?? undefined,
    });
    const path = new URL(url).pathname;
    if (path === "/repos/acme/docs/installation") {
      return Response.json({ id: 42 });
    }
    if (path === "/app/installations/42/access_tokens") {
      exchanges += 1;
      return new Response(
        JSON.stringify({
          token: `inst-token-${exchanges}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (path === "/repos/acme/docs") {
      return Response.json({ default_branch: "main" });
    }
    if (path === "/repos/acme/docs/branches/main") {
      return Response.json({ commit: { sha: "head-sha-1" } });
    }
    if (path.startsWith("/repos/acme/docs/tarball/")) {
      return new Response(new Uint8Array(tarball));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, exchangeCount: () => exchanges };
}

const TARBALL = makeTarGz([
  { name: "acme-docs-sha1/", type: "5" },
  { name: "acme-docs-sha1/index.md", content: "# Fetched\n" },
]);

describe("mintAppJwt", () => {
  it("produces a valid RS256 JWT with the App claims inside the 10-minute ceiling", () => {
    const now = 1_750_000_000_000;
    const jwt = mintAppJwt("12345", PEM, now);
    const [h, p, s] = jwt.split(".");
    expect(h && p && s).toBeTruthy();
    const header = JSON.parse(Buffer.from(h ?? "", "base64url").toString());
    const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(540);
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    const verified = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s ?? "", "base64url"));
    expect(verified).toBe(true);
  });
});

describe("createGitHubProvider (App mode)", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), "rs-gh-"));
  });

  it("discovers the installation, exchanges a token, and fetches the tarball", async () => {
    const gh = mockGitHub(TARBALL);
    const provider = createGitHubProvider({
      auth: { kind: "app", appId: "12345", privateKey: PEM },
      fetchImpl: gh.fetchImpl,
    });
    await provider.fetchAtRef({ repo: "acme/docs", commitSha: "sha1" }, dest);
    expect(await readFile(join(dest, "index.md"), "utf8")).toBe("# Fetched\n");
    const tarballCall = gh.calls.find((c) => c.url.includes("/tarball/"));
    expect(tarballCall?.auth).toBe("Bearer inst-token-1");
    // The exchange used the App JWT, never a stored token.
    const exchange = gh.calls.find((c) => c.url.includes("/access_tokens"));
    expect(exchange?.auth?.startsWith("Bearer ey")).toBe(true);
  });

  it("caches the installation token until near expiry", async () => {
    let clock = Date.now();
    const gh = mockGitHub(TARBALL);
    const provider = createGitHubProvider({
      auth: { kind: "app", appId: "12345", privateKey: PEM },
      fetchImpl: gh.fetchImpl,
      now: () => clock,
    });
    await provider.resolveToken({ repo: "acme/docs" });
    await provider.resolveToken({ repo: "acme/docs" });
    expect(gh.exchangeCount()).toBe(1);
    clock += 3600_000; // beyond expiry
    await provider.resolveToken({ repo: "acme/docs" });
    expect(gh.exchangeCount()).toBe(2);
  });

  it("resolves the default branch to its head commit", async () => {
    const gh = mockGitHub(TARBALL);
    const provider = createGitHubProvider({
      auth: { kind: "app", appId: "12345", privateKey: PEM },
      fetchImpl: gh.fetchImpl,
    });
    const resolved = await provider.resolveBranch({ repo: "acme/docs" }, null);
    expect(resolved).toEqual({ branch: "main", headSha: "head-sha-1" });
  });

  it("enforces the download cap and surfaces no token in the error", async () => {
    const gh = mockGitHub(TARBALL);
    const provider = createGitHubProvider({
      auth: { kind: "app", appId: "12345", privateKey: PEM },
      fetchImpl: gh.fetchImpl,
      limits: { maxDownloadBytes: 16 },
    });
    await expect(
      provider.fetchAtRef({ repo: "acme/docs", commitSha: "sha1" }, dest),
    ).rejects.toThrow(/download cap/);
    await expect(
      provider.fetchAtRef({ repo: "acme/docs", commitSha: "sha1" }, dest),
    ).rejects.not.toThrow(/inst-token/);
  });
});

describe("createGitHubProvider (PAT mode)", () => {
  it("uses the token verbatim with no App endpoints", async () => {
    const gh = mockGitHub(TARBALL);
    const provider = createGitHubProvider({
      auth: { kind: "pat", token: "pat-abc" },
      fetchImpl: gh.fetchImpl,
    });
    const dest = await mkdtemp(join(tmpdir(), "rs-pat-"));
    await provider.fetchAtRef({ repo: "acme/docs", commitSha: "sha1" }, dest);
    expect(await readFile(join(dest, "index.md"), "utf8")).toBe("# Fetched\n");
    expect(gh.calls.every((c) => !c.url.includes("/app/"))).toBe(true);
    expect(gh.calls.every((c) => !c.url.includes("/installation"))).toBe(true);
    const tarballCall = gh.calls.find((c) => c.url.includes("/tarball/"));
    expect(tarballCall?.auth).toBe("Bearer pat-abc");
  });
});
