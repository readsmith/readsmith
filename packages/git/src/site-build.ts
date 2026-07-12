import {
  type Db,
  type DeploymentRow,
  type Logger,
  defineJob,
  insertDeployment,
  markDeploymentFailed,
  publishDeployment,
} from "@readsmith/db";
import { contentHash } from "@readsmith/model";
import type { BundleStore } from "@readsmith/storage";
import { z } from "zod";
import type { Executor } from "./executor.js";

/** Where deployment artifacts live in the store, content-addressed. */
export const BUNDLE_PREFIX = "bundles/";

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
    source: { repo: payload.repo, commitSha: payload.commitSha },
    limits: { timeoutSec: deps.timeoutSec ?? 300 },
    artifact: { bundlePrefix: BUNDLE_PREFIX },
  });

  if (!result.ok || result.bundleKey === null || result.bundleHash === null) {
    await markDeploymentFailed(db, opened.id);
    logger?.warn("build failed", {
      deployment: opened.id,
      commit: payload.commitSha,
      wallMs: result.usage.wallMs,
      diagnostics: result.diagnostics.length,
    });
    return { ...opened, status: "failed" };
  }

  const stored = await store.get(result.bundleKey);
  if (!stored || contentHash(stored.toString("utf8")) !== result.bundleHash) {
    await markDeploymentFailed(db, opened.id);
    logger?.warn("artifact verification failed", {
      deployment: opened.id,
      key: result.bundleKey,
    });
    return { ...opened, status: "failed" };
  }

  const { flipped, row } = await publishDeployment(db, {
    id: opened.id,
    bundleRef: result.bundleKey,
    bundleHash: result.bundleHash,
  });
  logger?.info(flipped ? "deployment published" : "deployment superseded", {
    deployment: row.id,
    commit: payload.commitSha,
    pages: result.pageCount,
    wallMs: result.usage.wallMs,
  });
  if (flipped) await deps.afterFlip?.(row);
  return row;
}
