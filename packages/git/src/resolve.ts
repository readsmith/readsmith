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

/**
 * The site-resolution port: how a request Host becomes a site. The self-host
 * default resolves every host to the one configured site; a multi-tenant host
 * injects a resolver backed by its own tenancy data. Routes never learn about
 * organizations or plans: `suspended` is the entire moderation surface the
 * serving shell sees (it renders a neutral 410), and `null` is an unknown host
 * (404). Resolvers should cache internally; this is a hot-path call.
 */
export interface SiteResolution {
  siteId: string;
  status: "active" | "suspended";
}

export interface SiteResolver {
  /** Map a request Host (hostname, possibly with port) to a site. */
  resolve(host: string): Promise<SiteResolution | null> | SiteResolution | null;
}

/** The self-host default: every host is the configured site, always active. */
export function createStaticSiteResolver(siteId = "default"): SiteResolver {
  const resolution: SiteResolution = { siteId, status: "active" };
  return { resolve: () => resolution };
}

/**
 * Multi-site current-bundle resolution: one pointer-cached loader per site,
 * capped so a long tail of sites cannot hold every bundle in memory (least
 * recently used sites drop their loader and simply re-resolve on the next
 * request). Single-site mode is this source with one permanently-hot entry.
 */
export interface CurrentBundleSource {
  load(siteId: string): Promise<CurrentBundle | null>;
  /** Drop one site's pointer cache, or every site's. */
  invalidate(siteId?: string): void;
}

/**
 * Every live bundle source in the process, across Next's module graphs. The
 * boot instrumentation and the route handlers each bundle their own copy of
 * the serving shell, but this package is server-external (one module instance
 * per process), so a registry here is the one place a LISTEN/NOTIFY signal can
 * reach every pointer cache at once.
 */
const liveSources = new Set<CurrentBundleSource>();

/** Drop the pointer cache for a site (or all) in every source in the process. */
export function invalidateAllBundleSources(siteId?: string): void {
  for (const source of liveSources) source.invalidate(siteId);
}

export function createDeploymentBundleSource(deps: {
  db: Db;
  store: BundleStore;
  versionId?: string;
  /** Pointer re-check interval per site, milliseconds. */
  ttlMs?: number;
  /** Max sites with a live loader (and cached bundle bytes) at once. */
  maxSites?: number;
  now?: () => number;
  logger?: Logger;
}): CurrentBundleSource {
  const maxSites = deps.maxSites ?? 64;
  const loaders = new Map<string, CurrentBundleLoader>();

  function loaderFor(siteId: string): CurrentBundleLoader {
    const existing = loaders.get(siteId);
    if (existing) {
      // Refresh recency (Map iteration order is insertion order).
      loaders.delete(siteId);
      loaders.set(siteId, existing);
      return existing;
    }
    const loader = createCurrentBundleLoader({
      db: deps.db,
      store: deps.store,
      siteId,
      versionId: deps.versionId,
      ttlMs: deps.ttlMs,
      now: deps.now,
      logger: deps.logger,
    });
    loaders.set(siteId, loader);
    while (loaders.size > maxSites) {
      const oldest = loaders.keys().next().value;
      if (oldest === undefined) break;
      loaders.delete(oldest);
    }
    return loader;
  }

  const source: CurrentBundleSource = {
    load(siteId: string): Promise<CurrentBundle | null> {
      return loaderFor(siteId).load();
    },
    invalidate(siteId?: string): void {
      if (siteId === undefined) {
        for (const loader of loaders.values()) loader.invalidate();
        return;
      }
      loaders.get(siteId)?.invalidate();
    },
  };
  liveSources.add(source);
  return source;
}
