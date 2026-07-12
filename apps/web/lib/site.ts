import { join } from "node:path";
import { createMemoryCache } from "@readsmith/cache";
import {
  type CurrentBundleSource,
  type SiteResolution,
  type SiteResolver,
  createDeploymentBundleSource,
  createStaticSiteResolver,
} from "@readsmith/git";
import type { SiteBuild } from "@readsmith/mdx";
import type { NormalizedSpec } from "@readsmith/model";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";
import { getDb } from "./db";

/**
 * Server-only. Resolves the content bundle the shell serves, through the
 * BundleStore port. With a database, the current *deployment* wins: the
 * `is_current` pointer names an immutable content-addressed artifact, checked
 * at most once per TTL (never Postgres per page view), and rollback is just
 * that pointer moving. Without a database, or before any deployment exists,
 * this reads the locally-compiled `bundle.json` exactly as before - the
 * docs-only path is byte-identical. The store key layout is fixed and the
 * local driver root is a static subfolder, so the content pipeline is never
 * traced into the route graph.
 */
export interface Site {
  build: SiteBuild;
  name: string;
  branding: boolean;
  url?: string;
  description?: string;
  /** Where the header brand links; defaults to "/". */
  homeUrl?: string;
  /** Per-theme pairs (config resolution fills both slots from a bare string). */
  logo?: { light: string; dark: string };
  favicon?: { light: string; dark: string };
  /** Precompiled per-site brand theme CSS (see @readsmith/components themeToCss). */
  themeCss?: string;
  /** First-visit color scheme; "system" follows the visitor's OS. */
  appearance?: { default: "system" | "light" | "dark" };
  /** The API-reference config from docs.yaml, when set (for the header cross-link). */
  apiReference?: { spec: string; path: string; label: string; layout?: "single" | "pages" };
  /** Content footer: social links by platform. */
  footer?: { socials?: Record<string, string> };
  /** Opaque AI config block from docs.yaml (validated at runtime by @readsmith/ai). */
  ai?: unknown;
}

/** The normalized API reference, ready to render. */
export interface ApiReference {
  spec: NormalizedSpec;
  path: string;
  label: string;
  /** "single" = one continuous page (default); "pages" = one page per operation. */
  layout?: "single" | "pages";
}

export interface Bundle {
  site: Site;
  apiReference: ApiReference | null;
}

const BUNDLE_KEY = "bundle.json";
const DEFAULT_SITE_ID = "default";
const store = createBundleStore(
  resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
);

/**
 * Hydrated (parsed) sites, LRU-capped and keyed by `siteId:ref`. Refs are
 * immutable content addresses, so entries never need invalidating, only
 * evicting; a pointer flip changes the key. Single-site installs live entirely
 * inside one permanently-hot entry.
 */
const siteCacheMax = Number(process.env.READSMITH_SITE_CACHE_MAX ?? "16");
const parsedSites = createMemoryCache({
  max: Number.isInteger(siteCacheMax) && siteCacheMax > 0 ? siteCacheMax : 16,
  defaultTtlMs: Number.MAX_SAFE_INTEGER,
});

let cached: Promise<Bundle> | null = null;
let source: CurrentBundleSource | null | undefined;
let resolver: SiteResolver = createStaticSiteResolver(DEFAULT_SITE_ID);

/**
 * Replace the host-to-site resolver (the multi-tenant seam). The default maps
 * every host to the single configured site, which keeps self-host serving
 * byte-identical; a multi-tenant composition injects one backed by its own
 * tenancy data. Routes themselves never learn about tenants.
 */
export function configureSiteResolver(next: SiteResolver): void {
  resolver = next;
}

/** Resolve a request Host to a site (null = unknown, suspended = serve a 410). */
export function resolveSiteForHost(
  host: string,
): Promise<SiteResolution | null> | SiteResolution | null {
  return resolver.resolve(host);
}

function bundleSource(): CurrentBundleSource | null {
  if (source === undefined) {
    const db = getDb();
    source = db ? createDeploymentBundleSource({ db, store }) : null;
  }
  return source;
}

function loadLocalBundle(): Promise<Bundle> {
  if (!cached) {
    cached = store.get(BUNDLE_KEY).then((bytes) => {
      if (!bytes) {
        throw new Error("content bundle missing - run the content build (pnpm build / predev)");
      }
      return JSON.parse(bytes.toString("utf8")) as Bundle;
    });
  }
  return cached;
}

/**
 * The bundle a site serves: its current deployment when one exists, hydrated
 * through the LRU. Only the default site may fall back to the locally-compiled
 * bundle (the docs-only path); any other site without a deployment is null,
 * which a multi-site host maps to a 404.
 */
export async function loadBundleForSite(siteId: string): Promise<Bundle | null> {
  const current = await bundleSource()?.load(siteId);
  if (current) {
    const key = `${siteId}:${current.ref}`;
    const hit = await parsedSites.get<Bundle>(key);
    if (hit) return hit;
    const bundle = JSON.parse(current.json) as Bundle;
    await parsedSites.set(key, bundle);
    return bundle;
  }
  return siteId === DEFAULT_SITE_ID ? loadLocalBundle() : null;
}

async function loadBundle(): Promise<Bundle> {
  const bundle = await loadBundleForSite(DEFAULT_SITE_ID);
  if (!bundle) {
    throw new Error("content bundle missing - run the content build (pnpm build / predev)");
  }
  return bundle;
}

/**
 * Drop the pointer cache so the next read re-resolves immediately. Called after
 * a publish by the in-process worker (each module graph has its own copy of
 * this state; the routes' copy relies on the pointer TTL + route revalidation).
 */
export function invalidateSiteCache(siteId?: string): void {
  bundleSource()?.invalidate(siteId);
}

export async function getSite(): Promise<Site> {
  return (await loadBundle()).site;
}

export async function getApiReference(): Promise<ApiReference | null> {
  return (await loadBundle()).apiReference;
}
