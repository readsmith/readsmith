import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCspFromEnv, resolveConfig, securityHeaders } from "@readsmith/config";

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = process.env.READSMITH_CONTENT ?? join(here, "content");

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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
