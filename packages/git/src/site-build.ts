import {
  type Db,
  type DeploymentRow,
  type Logger,
  defineJob,
  getGitConnection,
  insertDeployment,
  markDeploymentFailed,
  pruneSuperseded,
  publishDeployment,
  setDeploymentDiagnostics,
  setDeploymentVersion,
  setLastSyncedSha,
} from "@readsmith/db";
import { type Diagnostic, contentHash } from "@readsmith/model";
import type { BundleStore } from "@readsmith/storage";
import { z } from "zod";
import type { Executor } from "./executor.js";

/** Where deployment artifacts live in the store, content-addressed. */
export const BUNDLE_PREFIX = "bundles/";

/**
 * The version routing table key (`sites/{siteId}/versions.json`): the manifest
 * the serve reads to map a request path to the answering version. Site-scoped
 * and mutable (rewritten each multi-version publish), unlike the content bundles.
 * Must match `@readsmith/serve`'s reader.
 */
export function siteVersionsKey(siteId: string): string {
  return `sites/${siteId}/versions.json`;
}

/**
 * Per-deployment build log key: site-scoped (not content-addressed like
 * bundles), because a log belongs to one build and is never shared. One growing
 * text object per deployment, which the host can read to show build output.
 */
export function deploymentLogKey(siteId: string, deploymentId: string): string {
  return `sites/${siteId}/logs/${deploymentId}.txt`;
}

export interface BuildLogInput {
  deploymentId: string;
  repo: string;
  ref: string;
  commitSha: string;
  status: "published" | "superseded" | "failed";
  pageCount: number;
  rendered: number;
  wallMs: number;
  diagnostics: Diagnostic[];
}

/**
 * Assemble a build's log as fixed-order plain text: header, outcome, then every
 * diagnostic. Pure and deterministic (no clock beyond the executor's measured
 * wall-ms), so the same build yields the same bytes and this is unit-testable
 * without a store. Keeps ALL diagnostics, not the 50-row cap the DB column
 * keeps: the store has no size pressure at beta page caps.
 */
export function buildLogText(input: BuildLogInput): string {
  const cached = Math.max(0, input.pageCount - input.rendered);
  const lines = [
    "Readsmith build log",
    `deployment: ${input.deploymentId}`,
    `repo: ${input.repo}`,
    `ref: ${input.ref}`,
    `commit: ${input.commitSha}`,
    `status: ${input.status}`,
    `pages: ${input.pageCount} (rendered ${input.rendered}, cached ${cached})`,
    `duration: ${input.wallMs}ms`,
    "",
  ];
  if (input.diagnostics.length === 0) {
    lines.push("diagnostics: none");
  } else {
    lines.push(`diagnostics (${input.diagnostics.length}):`);
    for (const d of input.diagnostics) {
      const where = d.pos ? `${d.source}:${d.pos.line}:${d.pos.col}` : d.source;
      lines.push(`[${d.severity}] ${d.code}: ${d.message}${where ? ` (${where})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Persist a build log, best-effort: a failed write logs a warning and never
 * fails or delays the build (mirrors the retention-GC posture). Extracted so
 * the swallow-errors contract is unit-testable with a throwing store.
 */
export async function writeBuildLog(
  store: BundleStore,
  siteId: string,
  deploymentId: string,
  text: string,
  logger?: Logger,
): Promise<void> {
  try {
    await store.put(deploymentLogKey(siteId, deploymentId), text);
  } catch (err) {
    logger?.warn("build log write failed", { deployment: deploymentId, err: String(err) });
  }
}

export const siteBuildPayloadSchema = z.object({
  siteId: z.string(),
  repo: z.string(),
  ref: z.string(),
  commitSha: z.string(),
});
export type SiteBuildPayload = z.infer<typeof siteBuildPayloadSchema>;

/** The build job. Singleton key dedupes redelivered pushes (idempotency). */
export const siteBuildJob = defineJob({
  name: "site.build",
  schema: siteBuildPayloadSchema,
});

export function siteBuildSingletonKey(payload: { siteId: string; commitSha: string }): string {
  return `${payload.siteId}:${payload.commitSha}`;
}

export interface RunSiteBuildDeps {
  db: Db;
  store: BundleStore;
  executor: Executor;
  logger?: Logger;
  /**
   * Called after `is_current` moves to this build (never for failed or
   * superseded ones). The host uses it to drop serving caches; the hook keeps
   * this orchestration host-agnostic.
   */
  afterFlip?: (row: DeploymentRow) => void | Promise<void>;
  /** Build wall-clock budget, seconds. */
  timeoutSec?: number;
  /** Strict mode: a page-level error diagnostic fails the build (nothing publishes). */
  failOnError?: boolean;
  /**
   * Rollback-history retention, applied after every publish: non-current
   * snapshots beyond the most recent `keepLast` are marked pruned and their
   * artifacts deleted when no live deployment still references them (content
   * addresses are shared). The current deployment is never pruned. 0 disables.
   */
  retention?: { keepLast: number };
  /**
   * The URL a site is served at, when the host owns domain assignment (a
   * multi-site install). Resolved per build and passed to the executor, so a
   * domain change is exactly one rebuild. Absent = the config's own site.url
   * (the self-host behavior, unchanged).
   */
  resolveSiteUrl?: (siteId: string) => Promise<string | null | undefined>;
}

/**
 * The `site.build` handler body: dispatch-only orchestration. Open a
 * deployment (allocating its supersede sequence), run the executor (fetch +
 * compile + artifact write happen inside it), verify the stored artifact's
 * bytes hash to what the executor claimed (trivial in-process, load-bearing for
 * remote drivers), then publish atomically under the sequence guard. A failed
 * build, a hash mismatch, or a lost supersede race never moves the pointer.
 */
export async function runSiteBuild(
  deps: RunSiteBuildDeps,
  payload: SiteBuildPayload,
): Promise<DeploymentRow> {
  const { db, store, executor, logger } = deps;
  const connection = await getGitConnection(db, payload.siteId);
  const siteUrl = (await deps.resolveSiteUrl?.(payload.siteId)) ?? null;
  const opened = await insertDeployment(db, {
    siteId: payload.siteId,
    gitRef: payload.ref,
    commitSha: payload.commitSha,
  });
  logger?.info("build started", {
    deployment: opened.id,
    commit: payload.commitSha,
    repo: payload.repo,
  });

  const result = await executor.run({
    kind: "site.build",
    siteId: payload.siteId,
    source: {
      repo: payload.repo,
      commitSha: payload.commitSha,
      installationId: connection?.installation_id ?? null,
    },
    limits: { timeoutSec: deps.timeoutSec ?? 300 },
    artifact: { bundlePrefix: BUNDLE_PREFIX },
    failOnError: deps.failOnError,
    siteUrl,
  });

  const keptDiagnostics = result.diagnostics.slice(0, 50);
  const logFailed = (diagnostics: Diagnostic[]) =>
    writeBuildLog(
      store,
      payload.siteId,
      opened.id,
      buildLogText({
        deploymentId: opened.id,
        repo: payload.repo,
        ref: payload.ref,
        commitSha: payload.commitSha,
        status: "failed",
        pageCount: result.pageCount,
        rendered: result.rendered,
        wallMs: result.usage.wallMs,
        diagnostics,
      }),
      logger,
    );
  if (!result.ok || result.versions.length === 0 || result.bundleHash === null) {
    await markDeploymentFailed(db, opened.id, keptDiagnostics);
    await logFailed(result.diagnostics);
    logger?.warn("build failed", {
      deployment: opened.id,
      commit: payload.commitSha,
      wallMs: result.usage.wallMs,
      diagnostics: result.diagnostics.length,
    });
    return { ...opened, status: "failed" };
  }

  // Verify every version's stored artifact hashes to what the executor claimed
  // (trivial in-process, load-bearing for remote drivers) before any lane flips.
  for (const v of result.versions) {
    const stored = await store.get(v.bundleKey);
    if (!stored || contentHash(stored.toString("utf8")) !== v.bundleHash) {
      const verify: Diagnostic = {
        severity: "error",
        code: "artifact-verify-failed",
        message: "stored artifact does not match the executor's hash",
        source: payload.repo,
      };
      await markDeploymentFailed(db, opened.id, [verify, ...keptDiagnostics]);
      await logFailed([verify, ...result.diagnostics]);
      logger?.warn("artifact verification failed", { deployment: opened.id, key: v.bundleKey });
      return { ...opened, status: "failed" };
    }
  }

  // Publish each version lane. The pre-opened row (allocated on the placeholder
  // 'current' lane) is reused for the default version, reassigned to its real id
  // when the site is multi-version; every other version opens its own lane. Only
  // the default lane's flip drives the site-wide post-publish steps below.
  let defaultFlipped = false;
  let defaultRow: DeploymentRow = opened;
  for (const v of result.versions) {
    const isDefault = v.versionId === result.defaultVersionId;
    let deploymentId: string;
    if (isDefault) {
      if (opened.version_id !== v.versionId) {
        await setDeploymentVersion(db, { id: opened.id, versionId: v.versionId });
      }
      deploymentId = opened.id;
    } else {
      const extra = await insertDeployment(db, {
        siteId: payload.siteId,
        versionId: v.versionId,
        gitRef: payload.ref,
        commitSha: payload.commitSha,
      });
      deploymentId = extra.id;
    }
    const { flipped, row } = await publishDeployment(db, {
      id: deploymentId,
      bundleRef: v.bundleKey,
      bundleHash: v.bundleHash,
    });
    if (isDefault) {
      defaultFlipped = flipped;
      defaultRow = row;
    }
    await writeBuildLog(
      store,
      payload.siteId,
      deploymentId,
      buildLogText({
        deploymentId,
        repo: payload.repo,
        ref: payload.ref,
        commitSha: payload.commitSha,
        status: flipped ? "published" : "superseded",
        pageCount: v.pageCount,
        rendered: v.rendered,
        wallMs: result.usage.wallMs,
        diagnostics: result.diagnostics,
      }),
      logger,
    );
  }
  if (keptDiagnostics.length > 0) {
    // Published builds keep their warnings on the default lane's row: "live, but
    // three pages complained" is what an operator wants without log archaeology.
    await setDeploymentDiagnostics(db, { id: opened.id, diagnostics: keptDiagnostics }).catch(
      () => {},
    );
  }
  logger?.info(defaultFlipped ? "deployment published" : "deployment superseded", {
    deployment: defaultRow.id,
    commit: payload.commitSha,
    versions: result.versions.length,
    pages: result.pageCount,
    rendered: result.rendered,
    cached: Math.max(0, result.pageCount - result.rendered),
    wallMs: result.usage.wallMs,
  });
  if (defaultFlipped) {
    // The version routing table is stored only now, after every lane is live, so
    // the serve never advertises a version whose bundle is not yet current.
    if (result.manifest) {
      try {
        await store.put(siteVersionsKey(payload.siteId), JSON.stringify(result.manifest));
      } catch (err) {
        logger?.warn("versions manifest write failed", {
          site: payload.siteId,
          err: String(err),
        });
      }
    }
    if (connection && connection.repo.toLowerCase() === payload.repo.toLowerCase()) {
      await setLastSyncedSha(db, { id: connection.id, sha: payload.commitSha });
    }
    const keepLast = deps.retention?.keepLast ?? 20;
    if (keepLast > 0) {
      // Retention is housekeeping: a fault here never fails a published build.
      try {
        const { prunedIds, unreferencedRefs, retainedRefs } = await pruneSuperseded(db, {
          siteId: payload.siteId,
          keepLast,
        });
        // Asset GC: keys referenced only by the bundles being deleted. Read
        // the pruned manifests BEFORE deleting them, subtract every key a
        // retained bundle still references, and only ever touch this site's
        // scoped prefix. Executors re-put assets unconditionally, so the
        // worst concurrent-build race rewrites bytes instead of dangling.
        const assetPrefix = `sites/${payload.siteId}/assets/`;
        const assetKeysOf = async (refs: string[]): Promise<Set<string>> => {
          const keys = new Set<string>();
          for (const ref of refs) {
            const bytes = await store.get(ref);
            if (!bytes) continue;
            const parsed = JSON.parse(bytes.toString("utf8")) as {
              site?: { assets?: Record<string, { key?: string }> };
            };
            for (const entry of Object.values(parsed.site?.assets ?? {})) {
              if (entry.key?.startsWith(assetPrefix)) keys.add(entry.key);
            }
          }
          return keys;
        };
        const dead = await assetKeysOf(unreferencedRefs);
        if (dead.size > 0) {
          for (const live of await assetKeysOf(retainedRefs)) dead.delete(live);
        }
        for (const ref of unreferencedRefs) await store.delete(ref);
        for (const key of dead) await store.delete(key);
        // A pruned deployment's log is no longer reachable from the dashboard,
        // so collect it too (best-effort; a stray log never fails a build).
        for (const id of prunedIds) {
          await store.delete(deploymentLogKey(payload.siteId, id)).catch(() => {});
        }
        if (prunedIds.length > 0) {
          logger?.info("deployments pruned", {
            pruned: prunedIds.length,
            artifactsDeleted: unreferencedRefs.length,
            assetsDeleted: dead.size,
            keepLast,
          });
        }
      } catch (err) {
        logger?.warn("deployment pruning failed", { err: String(err) });
      }
    }
    await deps.afterFlip?.(defaultRow);
  }
  return defaultRow;
}
