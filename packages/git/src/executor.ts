import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSite, openRenderCache } from "@readsmith/build";
import type { Diagnostic } from "@readsmith/model";
import type { BundleStore } from "@readsmith/storage";
import type { GitProvider } from "./provider.js";

/**
 * The executor port: where a build actually runs. The in-process driver is the
 * self-host default (operator-trusted content, no code execution in the
 * pipeline); an isolated remote driver implements this same interface for
 * untrusted multi-tenant builds. The job carries a key *prefix*, not a final
 * key: the artifact is content-addressed, so its key exists only after the
 * compile. The executor owns fetch + compile + artifact write and never touches
 * the database; publishing is the dispatcher's job.
 */
export interface ExecutorJob {
  kind: "site.build";
  siteId: string;
  source: { repo: string; commitSha: string; installationId?: string | null };
  limits: { timeoutSec: number };
  artifact: { bundlePrefix: string };
  /** Strict mode: a page-level error diagnostic fails the build (nothing publishes). */
  failOnError?: boolean;
  /** Serve at this URL instead of the config's `site.url` (the host owns domains). */
  siteUrl?: string | null;
}

export interface ExecutorResult {
  ok: boolean;
  /** Content-addressed artifact key actually written (`{prefix}{hash}.json`), or null on failure. */
  bundleKey: string | null;
  /** Hash the executor claims for the artifact; the dispatcher verifies it before publish. */
  bundleHash: string | null;
  pageCount: number;
  /** Pages actually re-rendered (the rest came from the persisted render cache). */
  rendered: number;
  diagnostics: Diagnostic[];
  usage: { wallMs: number };
}

export interface Executor {
  run(job: ExecutorJob): Promise<ExecutorResult>;
}

async function withTimeout<T>(seconds: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`build timed out after ${seconds}s`)),
          seconds * 1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The in-process driver: fetch into an ephemeral scratch directory, compile,
 * write the content-addressed artifact through the store, and always delete the
 * checkout. The timeout is advisory here (a race, not a kill: acceptable for
 * operator-trusted content); remote drivers enforce a hard kill.
 */
export function createInProcessExecutor(deps: {
  provider: GitProvider;
  store: BundleStore;
  /** Injected clock for the usage measurement (tests); defaults to Date.now. */
  now?: () => number;
}): Executor {
  const now = deps.now ?? (() => Date.now());
  return {
    async run(job: ExecutorJob): Promise<ExecutorResult> {
      const started = now();
      let workDir: string | null = null;
      try {
        workDir = await mkdtemp(join(tmpdir(), "readsmith-build-"));
        // Fetch into a child named after the repo, not the random scratch dir:
        // convention-over-config derives an unset site name from the content
        // directory's basename, so the checkout must carry the repo's name for
        // the compile to be byte-identical across builds (and identical to a
        // local clone). A random name here would poison the content address.
        const dir = join(workDir, job.source.repo.split("/").pop() || "site");
        await mkdir(dir);
        // The persisted render cache is an accelerator, never a dependency: if
        // it cannot be read or written the build simply renders everything.
        const persisted = await openRenderCache(deps.store).catch(() => null);
        const compiled = await withTimeout(job.limits.timeoutSec, async () => {
          await deps.provider.fetchAtRef(job.source, dir);
          return compileSite({
            contentDir: dir,
            siteId: job.siteId,
            renderCache: persisted?.cache,
            failOnError: job.failOnError,
            siteUrl: job.siteUrl ?? undefined,
          });
        });
        if (!compiled.bundle.site.build.ok) {
          // Strict mode tripped: report the diagnostics, publish nothing. The
          // successful page renders still flush (they make the retry cheap).
          await persisted?.flush().catch(() => {});
          return {
            ok: false,
            bundleKey: null,
            bundleHash: null,
            pageCount: compiled.bundle.site.build.pages.length,
            rendered: compiled.rebuiltPages.length,
            diagnostics: [
              ...compiled.apiReferenceDiagnostics,
              ...compiled.bundle.site.build.diagnostics,
            ],
            usage: { wallMs: now() - started },
          };
        }
        const bundleKey = `${job.artifact.bundlePrefix}${compiled.bundleHash}.json`;
        await deps.store.put(bundleKey, compiled.bundleJson);
        await persisted?.flush().catch(() => {});
        return {
          ok: true,
          bundleKey,
          bundleHash: compiled.bundleHash,
          pageCount: compiled.bundle.site.build.pages.length,
          rendered: compiled.rebuiltPages.length,
          diagnostics: [
            ...compiled.apiReferenceDiagnostics,
            ...compiled.bundle.site.build.diagnostics,
          ],
          usage: { wallMs: now() - started },
        };
      } catch (err) {
        return {
          ok: false,
          bundleKey: null,
          bundleHash: null,
          pageCount: 0,
          rendered: 0,
          diagnostics: [
            {
              severity: "error",
              code: "build-failed",
              message: err instanceof Error ? err.message : String(err),
              source: job.source.repo,
            },
          ],
          usage: { wallMs: now() - started },
        };
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
