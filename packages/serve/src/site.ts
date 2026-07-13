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
import { getDb } from "./db.js";

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
  /** Precompiled bring-your-own analytics tags (docs.yaml `analytics:`). */
  analyticsHtml?: string;
  /** First-visit color scheme; "system" follows the visitor's OS. */
  appearance?: { default: "system" | "light" | "dark" };
  /** The API-reference config from docs.yaml, when set (for the header cross-link). */
  apiReference?: { spec: string; path: string; label: string; layout?: "single" | "pages" };
  /** Content footer: social links by platform. */
  footer?: { socials?: Record<string, string> };
  /** Opaque AI config block from docs.yaml (validated at runtime by @readsmith/ai). */
  ai?: unknown;
  /** Static assets by serving path, each naming a content-addressed artifact key. */
  assets?: Record<string, { key: string; contentType: string; bytes: number; immutable?: boolean }>;
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

let siteUrlResolver: ((siteId: string) => Promise<string | null | undefined>) | null = null;

/**
 * Replace the site-URL resolver (the second multi-tenant seam): where a site
 * is served, for hosts that assign domains. Consulted per build (the URL is
 * baked into page URLs and metadata), so a domain change is one rebuild.
 * Default: none, and builds use the config's own `site.url` (self-host).
 */
export function configureSiteUrlResolver(
  next: (siteId: string) => Promise<string | null | undefined>,
): void {
  siteUrlResolver = next;
}

/** The URL the host serves this site at, or null to use the config's own. */
export async function resolveSiteUrl(siteId: string): Promise<string | null> {
  return (await siteUrlResolver?.(siteId)) ?? null;
}

let afterPublishHook: ((siteId: string) => void | Promise<void>) | null = null;

/**
 * Register a host hook fired after a deployment's pointer flips to current (a
 * publish). A multi-tenant host uses it for edge-cache invalidation or similar
 * side effects; because publishing happens only in the worker role, the hook
 * (and any credential it closes over) never runs in a serve instance. Default:
 * none, so self-host serving and building are byte-identical without it. Pass
 * null to clear.
 */
export function configureAfterPublish(
  next: ((siteId: string) => void | Promise<void>) | null,
): void {
  afterPublishHook = next;
}

/** The registered after-publish hook, or null when none is configured. */
export function getAfterPublishHook(): ((siteId: string) => void | Promise<void>) | null {
  return afterPublishHook;
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

/** The default site's whole bundle (site plus API reference). Throws when absent. */
export async function getBundle(): Promise<Bundle> {
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

/**
 * Serve one static asset for a site, straight from the artifact store via the
 * bundle's manifest. Conditional requests hit the content address: the ETag is
 * the asset's own hash, so a 304 needs no byte read at all. Null = the site
 * has no such asset (the host 404s).
 */
export async function loadSiteAsset(
  siteId: string,
  path: string,
  request?: Request,
): Promise<Response | null> {
  const bundle = await loadBundleForSite(siteId);
  const ref = bundle?.site.assets?.[path.startsWith("/") ? path : `/${path}`];
  if (!ref) return null;
  const etag = `"${ref.key.slice(ref.key.lastIndexOf("/") + 1)}"`;
  const headers: Record<string, string> = {
    "content-type": ref.contentType,
    etag,
    // A fingerprinted path names exact bytes and may be cached forever. The
    // authored path is mutable across deployments even though the bytes
    // behind an ETag never are, so its freshness is short and revalidation
    // is cheap (304).
    "cache-control": ref.immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, stale-while-revalidate=600",
  };
  if (request?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const bytes = await store.get(ref.key);
  if (!bytes) return null;
  return new Response(new Uint8Array(bytes), { headers });
}

export async function getSite(): Promise<Site> {
  return (await getBundle()).site;
}

export async function getApiReference(): Promise<ApiReference | null> {
  return (await getBundle()).apiReference;
}
