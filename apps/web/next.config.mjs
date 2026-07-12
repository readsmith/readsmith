import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_CANONICAL_PATH,
  mcpAlias,
  mergeCspFromEnv,
  resolveConfig,
  securityHeaders,
  siteBasePath,
} from "@readsmith/config";

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(here, "content");

/**
 * Subpath hosting (spec subpath-hosting SP-4): the base path derives from
 * site.url's pathname (`https://a.dev/docs` -> "/docs"), overridable at build
 * time with READSMITH_BASE_PATH. Next scopes routing, assets, public/ files,
 * and rewrites under it.
 */
async function basePath() {
  if (process.env.READSMITH_BASE_PATH !== undefined) {
    return process.env.READSMITH_BASE_PATH.replace(/\/+$/, "");
  }
  try {
    const config = await resolveConfig(CONTENT_DIR);
    return siteBasePath(config.site.url);
  } catch {
    return "";
  }
}
const BASE_PATH = await basePath();

/**
 * The site's own CSP sources (a badge host, an embed) come from `docs.yaml`; the
 * operator's come from the environment and are added, never substituted. Resolved
 * here rather than at request time because Next serializes `headers()` into the
 * build manifest. A missing or broken config must not take the server down, so a
 * failure falls back to the strict default policy.
 */
async function cspExtensions() {
  try {
    const config = await resolveConfig(CONTENT_DIR);
    return mergeCspFromEnv(config.security.csp, process.env);
  } catch {
    return mergeCspFromEnv({}, process.env);
  }
}

/**
 * The MCP server lives at `/_readsmith/mcp`, and is aliased to `/mcp` (the path
 * clients expect) whenever no docs page claims that URL. A repository with a
 * `docs/mcp.md` keeps its page; the endpoint stays reachable at its canonical
 * path, and the build warns so nobody has to discover that by curl.
 */
async function mcpRewrites() {
  try {
    const config = await resolveConfig(CONTENT_DIR);
    const alias = mcpAlias(config.pages, config.mcp.path);
    if (!alias) {
      console.warn(`[readsmith] a docs page claims /mcp; MCP serves ${MCP_CANONICAL_PATH}`);
      return [];
    }
    return alias === MCP_CANONICAL_PATH ? [] : [{ source: alias, destination: MCP_CANONICAL_PATH }];
  } catch {
    return [{ source: "/mcp", destination: MCP_CANONICAL_PATH }];
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(BASE_PATH ? { basePath: BASE_PATH } : {}),
  async rewrites() {
    // `beforeFiles` so the aliases resolve ahead of the static docs pages.
    // `agent-skills` is the alternate spelling some skills clients probe.
    const agentSkillsAlias = {
      source: "/.well-known/agent-skills/:path*",
      destination: "/.well-known/skills/:path*",
    };
    return {
      beforeFiles: [...(await mcpRewrites()), agentSkillsAlias],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    const headers = securityHeaders({
      csp: await cspExtensions(),
      development: process.env.NODE_ENV !== "production",
    });
    return [{ source: "/:path*", headers }];
  },
  // Self-host builds a standalone server image (see apps/web/Dockerfile).
  output: "standalone",
  // Trace from the monorepo root so the standalone bundle resolves workspace deps.
  outputFileTracingRoot: join(here, "../../"),
  // The workspace packages ship ESM dist; transpiling them keeps Next's bundler
  // happy across the ESM-only dependency graph (unified, shiki, etc.).
  transpilePackages: [
    "@readsmith/components",
    "@readsmith/mdx",
    "@readsmith/config",
    "@readsmith/model",
    "@readsmith/api",
    "@readsmith/storage",
  ],
  // Server-only packages stay external, loaded by Node at runtime rather than
  // bundled by the compiler. @readsmith/db must be external so its runtime
  // `import.meta.url` migration-dir resolution is not rewritten by the bundler.
  serverExternalPackages: [
    "pg",
    "pg-boss",
    "@readsmith/db",
    "@readsmith/git",
    "@readsmith/build",
    "@readsmith/ai",
    "@readsmith/cache",
    "@readsmith/api-reference",
    "@apidevtools/swagger-parser",
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@modelcontextprotocol/sdk",
  ],
};

export default nextConfig;
