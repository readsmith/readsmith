import { createSign } from "node:crypto";
import { createGunzip } from "node:zlib";
import type { FetchTarget, GitProvider } from "./provider.js";
import { TarError, extractTar } from "./tar.js";

/**
 * The GitHub driver: App-installation or PAT auth, tarball acquisition at an
 * exact commit, and the small read API the bind/polling paths need. No git
 * binary anywhere; every network call is an HTTPS request to the provider host,
 * and no token ever reaches a log or an error message.
 */
export type GitHubAuth =
  | { kind: "app"; appId: string; privateKey: string }
  | { kind: "pat"; token: string };

export interface GitHubLimits {
  /** Cap on the compressed download. */
  maxDownloadBytes: number;
  /** Cap on total uncompressed file bytes. */
  maxTotalBytes: number;
  /** Cap on tar entries. */
  maxEntries: number;
}

export const DEFAULT_GITHUB_LIMITS: GitHubLimits = {
  maxDownloadBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
};

export interface GitHubProviderOptions {
  auth: GitHubAuth;
  /** API host, default https://api.github.com (GHES: https://host/api/v3). */
  apiBase?: string;
  limits?: Partial<GitHubLimits>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface RepoRef {
  /** `owner/name`. */
  repo: string;
  /** Known App installation id; discovered from the repo when absent. */
  installationId?: string | null;
}

export interface GitHubProvider extends GitProvider {
  /**
   * The bearer credential for a repo: PAT as-is, or a cached 1-hour App
   * installation token. In App mode an unknown installation is discovered via
   * the repo's installation endpoint (JWT-authenticated), so binding works
   * before any webhook has recorded the id.
   */
  resolveToken(ref: RepoRef): Promise<string>;
  /** Resolve a branch (or the repo default) to its name + head commit. */
  resolveBranch(ref: RepoRef, branch?: string | null): Promise<{ branch: string; headSha: string }>;
}

function base64url(data: Buffer): string {
  return data.toString("base64url");
}

/** RS256 App JWT, expiring well inside GitHub's 10-minute ceiling. */
export function mintAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60; // clock-drift allowance
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat, exp: iat + 540, iss: appId })));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  /** Epoch ms after which the token is considered stale (real expiry minus a margin). */
  staleAt: number;
}

export function createGitHubProvider(options: GitHubProviderOptions): GitHubProvider {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const limits: GitHubLimits = { ...DEFAULT_GITHUB_LIMITS, ...options.limits };
  const tokenCache = new Map<string, CachedToken>();
  const installationCache = new Map<string, string>();

  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "readsmith",
  });

  async function apiJson(path: string, token: string): Promise<unknown> {
    const res = await fetchImpl(`${apiBase}${path}`, { headers: headers(token) });
    if (!res.ok) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** App mode: which installation covers this repo (JWT-authenticated lookup). */
  async function findInstallationId(repo: string, jwt: string): Promise<string> {
    const cached = installationCache.get(repo.toLowerCase());
    if (cached) return cached;
    const res = await fetchImpl(`${apiBase}/repos/${repo}/installation`, {
      headers: headers(jwt),
    });
    if (res.status === 404) {
      throw new Error(`the GitHub App is not installed on ${repo}`);
    }
    if (!res.ok)
      throw new Error(`GitHub installation lookup for ${repo} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { id?: number | string };
    if (body.id === undefined)
      throw new Error(`GitHub installation lookup for ${repo} returned no id`);
    const id = String(body.id);
    installationCache.set(repo.toLowerCase(), id);
    return id;
  }

  async function resolveToken(ref: RepoRef): Promise<string> {
    if (options.auth.kind === "pat") return options.auth.token;
    const jwt = mintAppJwt(options.auth.appId, options.auth.privateKey, now());
    const installationId = ref.installationId ?? (await findInstallationId(ref.repo, jwt));
    const cached = tokenCache.get(installationId);
    if (cached && now() < cached.staleAt) return cached.token;
    const res = await fetchImpl(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: headers(jwt),
    });
    if (!res.ok) {
      throw new Error(`GitHub installation-token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) throw new Error("GitHub installation-token exchange returned no token");
    const expiresMs = body.expires_at ? Date.parse(body.expires_at) : now() + 60 * 60 * 1000;
    tokenCache.set(installationId, { token: body.token, staleAt: expiresMs - 60 * 1000 });
    return body.token;
  }

  async function resolveBranch(
    ref: RepoRef,
    branch?: string | null,
  ): Promise<{ branch: string; headSha: string }> {
    const token = await resolveToken(ref);
    let name = branch ?? null;
    if (!name) {
      const info = (await apiJson(`/repos/${ref.repo}`, token)) as { default_branch?: string };
      if (!info.default_branch) {
        throw new Error(`could not resolve the default branch of ${ref.repo}`);
      }
      name = info.default_branch;
    }
    const data = (await apiJson(
      `/repos/${ref.repo}/branches/${encodeURIComponent(name)}`,
      token,
    )) as { commit?: { sha?: string } };
    if (!data.commit?.sha) throw new Error(`could not resolve branch ${name} of ${ref.repo}`);
    return { branch: name, headSha: data.commit.sha };
  }

  async function fetchAtRef(target: FetchTarget, destDir: string): Promise<void> {
    const token = await resolveToken(target);
    const url = `${apiBase}/repos/${target.repo}/tarball/${target.commitSha}`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "readsmith" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw new Error(
        `tarball fetch failed for ${target.repo}@${target.commitSha}: HTTP ${res.status}`,
      );
    }
    const gunzip = createGunzip();
    let compressed = 0;
    const pump = (async () => {
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          compressed += chunk.byteLength;
          if (compressed > limits.maxDownloadBytes) {
            throw new TarError(
              `tarball exceeds the download cap (${limits.maxDownloadBytes} bytes)`,
            );
          }
          if (!gunzip.write(Buffer.from(chunk))) {
            await new Promise((resolve) => gunzip.once("drain", resolve));
          }
        }
        gunzip.end();
      } catch (err) {
        gunzip.destroy(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    })();
    const extract = extractTar(gunzip, destDir, {
      stripComponents: 1, // the tarball's {owner}-{repo}-{sha}/ root
      limits: { maxEntries: limits.maxEntries, maxTotalBytes: limits.maxTotalBytes },
    });
    await Promise.all([pump, extract]);
  }

  return { resolveToken, resolveBranch, fetchAtRef };
}
