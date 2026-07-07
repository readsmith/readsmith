import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  ],
  // Server-only packages stay external, loaded by Node at runtime rather than
  // bundled by the compiler. @readsmith/db must be external so its runtime
  // `import.meta.url` migration-dir resolution is not rewritten by the bundler.
  serverExternalPackages: [
    "pg",
    "pg-boss",
    "@readsmith/db",
    "@readsmith/api-reference",
    "@apidevtools/swagger-parser",
  ],
};

export default nextConfig;
