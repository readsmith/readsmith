import { describe, expect, it } from "vitest";
import { GitConfigError, resolveGitConfig } from "../src/config.js";
import { buildAppManifest, exchangeManifestCode } from "../src/manifest.js";

describe("resolveGitConfig", () => {
  it("is null (git off) with no credentials", () => {
    expect(resolveGitConfig({})).toBeNull();
  });

  it("resolves App mode and normalizes escaped PEM newlines", () => {
    const config = resolveGitConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN\\nKEY-----",
      GITHUB_REPO: "acme/docs",
    });
    expect(config?.auth).toEqual({
      kind: "app",
      appId: "123",
      privateKey: "-----BEGIN\nKEY-----",
    });
    expect(config?.repo).toBe("acme/docs");
  });

  it("resolves PAT mode", () => {
    const config = resolveGitConfig({ GITHUB_PAT: "tok", GITHUB_BRANCH: "docs" });
    expect(config?.auth).toEqual({ kind: "pat", token: "tok" });
    expect(config?.branch).toBe("docs");
  });

  it("fails fast on a partial App pair, on both modes, and on repo without auth", () => {
    expect(() => resolveGitConfig({ GITHUB_APP_ID: "123" })).toThrow(GitConfigError);
    expect(() =>
      resolveGitConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_PAT: "t" }),
    ).toThrow(/not both/);
    expect(() => resolveGitConfig({ GITHUB_REPO: "acme/docs" })).toThrow(/no GitHub credentials/);
  });

  it("parses the poll interval and rejects nonsense", () => {
    expect(resolveGitConfig({ GITHUB_PAT: "t", GITHUB_POLL_INTERVAL: "90" })?.pollIntervalSec).toBe(
      90,
    );
    expect(resolveGitConfig({ GITHUB_PAT: "t" })?.pollIntervalSec).toBeNull();
    expect(() => resolveGitConfig({ GITHUB_PAT: "t", GITHUB_POLL_INTERVAL: "soon" })).toThrow(
      /positive integer/,
    );
    expect(() => resolveGitConfig({ GITHUB_PAT: "t", GITHUB_POLL_INTERVAL: "0" })).toThrow(
      GitConfigError,
    );
  });
});

describe("buildAppManifest", () => {
  it("asks for exactly the permissions the build needs", () => {
    const manifest = buildAppManifest({
      appName: "readsmith-docs",
      siteUrl: "https://docs.example.com",
      webhookUrl: "https://docs.example.com/_readsmith/api/git/webhook",
      redirectUrl: "https://docs.example.com/_readsmith/setup/github/callback",
    });
    expect(manifest).toEqual({
      name: "readsmith-docs",
      url: "https://docs.example.com",
      hook_attributes: { url: "https://docs.example.com/_readsmith/api/git/webhook" },
      redirect_url: "https://docs.example.com/_readsmith/setup/github/callback",
      public: false,
      default_permissions: { contents: "read", metadata: "read" },
      default_events: ["push"],
    });
  });
});

describe("exchangeManifestCode", () => {
  it("exchanges the code for credentials", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/app-manifests/the%2Fcode/conversions");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          id: 777,
          slug: "readsmith-docs",
          pem: "-----BEGIN RSA PRIVATE KEY-----",
          webhook_secret: "hook-1",
          html_url: "https://github.com/apps/readsmith-docs",
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    const creds = await exchangeManifestCode("the/code", { fetchImpl });
    expect(creds.appId).toBe("777");
    expect(creds.webhookSecret).toBe("hook-1");
    expect(creds.htmlUrl).toBe("https://github.com/apps/readsmith-docs");
  });

  it("fails clearly on an expired or reused code, echoing nothing sensitive", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    await expect(exchangeManifestCode("gone", { fetchImpl })).rejects.toThrow(/single-use/);
  });
});
