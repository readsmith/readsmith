import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompileVersionedResult,
  compileVersionedSite,
  openRenderCache,
} from "@readsmith/build";
import { siteVersionsOf } from "@readsmith/build";
import type { Diagnostic, SiteVersions } from "@readsmith/model";
import type { BundleStore } from "@readsmith/storage";
import type { GitProvider } from "./provider.js";

/** The deployment lane a compiled version publishes to: "" maps to 'current'. */
function laneOf(versionId: string): string {
  return versionId || "current";
}

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

/** One built version's stored artifact and the lane it publishes to. */
export interface ExecutorVersionArtifact {
  /** Deployment lane id ("current" for a single-version/default site, else the version id). */
  versionId: string;
  /** Content-addressed artifact key (`{prefix}{hash}.json`). */
  bundleKey: string;
  /** Hash the executor claims for this artifact; the dispatcher verifies each before publish. */
  bundleHash: string;
  pageCount: number;
  rendered: number;
}

export interface ExecutorResult {
  ok: boolean;
  /** The default version's artifact key (`{prefix}{hash}.json`), or null on failure. Back-compat
   * convenience; multi-version callers iterate `versions`. */
  bundleKey: string | null;
  /** The default version's claimed hash, or null on failure. */
  bundleHash: string | null;
  /** The default version's deployment lane ("current" single-version, else its real id). */
  defaultVersionId: string;
  /** Every built version's stored artifact (single-version: one, lane "current"). Empty on failure. */
  versions: ExecutorVersionArtifact[];
  /** The version routing table for the dispatcher to store post-publish; null single-version. */
  manifest: SiteVersions | null;
  /** Aggregate page count across versions. */
  pageCount: number;
  /** Aggregate pages actually re-rendered (the rest came from the persisted render cache). */
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
        const compiled: CompileVersionedResult = await withTimeout(
          job.limits.timeoutSec,
          async () => {
            await deps.provider.fetchAtRef(job.source, dir);
            return compileVersionedSite({
              contentDir: dir,
              siteId: job.siteId,
              renderCache: persisted?.cache,
              failOnError: job.failOnError,
              siteUrl: job.siteUrl ?? undefined,
            });
          },
        );
        // Aggregate over every version, so counts and diagnostics read as one build.
        const pageCount = compiled.versions.reduce(
          (n, v) => n + v.result.bundle.site.build.pages.length,
          0,
        );
        const rendered = compiled.versions.reduce((n, v) => n + v.result.rebuiltPages.length, 0);
        const diagnostics = compiled.versions.flatMap((v) => [
          ...v.result.apiReferenceDiagnostics,
          ...v.result.bundle.site.build.diagnostics,
        ]);
        const defaultVersionId = laneOf(compiled.default);

        if (!compiled.versions.every((v) => v.result.bundle.site.build.ok)) {
          // Strict mode tripped in some version: report the diagnostics, publish
          // nothing. The successful renders still flush (they make the retry cheap).
          await persisted?.flush().catch(() => {});
          return {
            ok: false,
            bundleKey: null,
            bundleHash: null,
            defaultVersionId,
            versions: [],
            manifest: null,
            pageCount,
            rendered,
            diagnostics,
            usage: { wallMs: now() - started },
          };
        }

        // Assets go in before the bundle that references them: content-addressed
        // keys make the puts idempotent and shareable across deployments (and
        // across versions). Deliberately unconditional (no exists-check): a
        // concurrent retention GC could delete a key between a skipped put and
        // this build's publish, and re-writing identical bytes is cheaper.
        const artifacts: ExecutorVersionArtifact[] = [];
        for (const v of compiled.versions) {
          for (const file of v.result.assetFiles) {
            await deps.store.put(file.key, await readFile(file.source));
          }
          const bundleKey = `${job.artifact.bundlePrefix}${v.result.bundleHash}.json`;
          await deps.store.put(bundleKey, v.result.bundleJson);
          artifacts.push({
            versionId: laneOf(v.id),
            bundleKey,
            bundleHash: v.result.bundleHash,
            pageCount: v.result.bundle.site.build.pages.length,
            rendered: v.result.rebuiltPages.length,
          });
        }
        await persisted?.flush().catch(() => {});
        const primary = artifacts.find((a) => a.versionId === defaultVersionId) ?? artifacts[0];
        return {
          ok: true,
          bundleKey: primary?.bundleKey ?? null,
          bundleHash: primary?.bundleHash ?? null,
          defaultVersionId,
          versions: artifacts,
          // Stored by the dispatcher only after the lanes publish, so the serve
          // never advertises a version whose lane is not yet live.
          manifest: siteVersionsOf(compiled),
          pageCount,
          rendered,
          diagnostics,
          usage: { wallMs: now() - started },
        };
      } catch (err) {
        return {
          ok: false,
          bundleKey: null,
          bundleHash: null,
          defaultVersionId: "current",
          versions: [],
          manifest: null,
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
