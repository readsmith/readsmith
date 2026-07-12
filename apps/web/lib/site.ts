import { join } from "node:path";
import { type CurrentBundleLoader, createCurrentBundleLoader } from "@readsmith/git";
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

interface Bundle {
  site: Site;
  apiReference: ApiReference | null;
}

const BUNDLE_KEY = "bundle.json";
const SITE_ID = "default";
const store = createBundleStore(
  resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
);

let cached: Promise<Bundle> | null = null;
let loader: CurrentBundleLoader | null | undefined;
let parsedCurrent: { ref: string; bundle: Bundle } | null = null;

function currentLoader(): CurrentBundleLoader | null {
  if (loader === undefined) {
    const db = getDb();
    loader = db ? createCurrentBundleLoader({ db, store, siteId: SITE_ID }) : null;
  }
  return loader;
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

async function loadBundle(): Promise<Bundle> {
  const current = await currentLoader()?.load();
  if (current) {
    // Parse once per deployment: the artifact behind a ref is immutable.
    if (parsedCurrent?.ref !== current.ref) {
      parsedCurrent = { ref: current.ref, bundle: JSON.parse(current.json) as Bundle };
    }
    return parsedCurrent.bundle;
  }
  return loadLocalBundle();
}

/**
 * Drop the pointer cache so the next read re-resolves immediately. Called after
 * a publish by the in-process worker (each module graph has its own copy of
 * this state; the routes' copy relies on the pointer TTL + route revalidation).
 */
export function invalidateSiteCache(): void {
  loader?.invalidate();
  parsedCurrent = null;
}

export async function getSite(): Promise<Site> {
  return (await loadBundle()).site;
}

export async function getApiReference(): Promise<ApiReference | null> {
  return (await loadBundle()).apiReference;
}
