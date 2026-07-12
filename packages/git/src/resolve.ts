import { type Db, type Logger, getCurrentDeployment } from "@readsmith/db";
import type { BundleStore } from "@readsmith/storage";

export interface CurrentBundle {
  /** The artifact key the bytes came from; stable per deployment (cache key). */
  ref: string;
  /** The bundle's canonical JSON. Parsing and validation stay with the caller. */
  json: string;
}

export interface CurrentBundleLoader {
  /**
   * The current deployment's bundle, or null when none exists (the caller
   * falls back to its local artifact). The pointer is re-checked at most once
   * per TTL, so the serving hot path never queries Postgres per page view.
   */
  load(): Promise<CurrentBundle | null>;
  /** Drop the cache so the next load re-resolves immediately (post-flip hook). */
  invalidate(): void;
}

/**
 * Pointer-cached resolution of the current deployment. Bytes are cached by
 * artifact ref (immutable, so no invalidation is ever needed for content);
 * only the pointer lookup has a lifetime. On a database error it serves the
 * last known bundle rather than taking the site down (stale beats broken).
 */
export function createCurrentBundleLoader(deps: {
  db: Db;
  store: BundleStore;
  siteId: string;
  versionId?: string;
  /** Pointer re-check interval, milliseconds. */
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
}): CurrentBundleLoader {
  const ttl = deps.ttlMs ?? 5000;
  const now = deps.now ?? (() => Date.now());
  let cached: CurrentBundle | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let resolved = false;

  return {
    async load(): Promise<CurrentBundle | null> {
      if (resolved && now() - checkedAt < ttl) return cached;
      try {
        const current = await getCurrentDeployment(deps.db, {
          siteId: deps.siteId,
          versionId: deps.versionId,
        });
        if (!current || current.bundle_ref === null) {
          cached = null;
        } else if (cached?.ref !== current.bundle_ref) {
          const bytes = await deps.store.get(current.bundle_ref);
          if (!bytes) {
            deps.logger?.error("current deployment artifact missing", {
              ref: current.bundle_ref,
            });
            // Keep serving what we have; a repoint or republish heals this.
            return cached;
          }
          cached = { ref: current.bundle_ref, json: bytes.toString("utf8") };
        }
        checkedAt = now();
        resolved = true;
        return cached;
      } catch (err) {
        deps.logger?.error("current deployment lookup failed", { err: String(err) });
        // Serve the last known bundle (or the caller's fallback) on a DB fault.
        return resolved ? cached : null;
      }
    },
    invalidate(): void {
      resolved = false;
      checkedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
