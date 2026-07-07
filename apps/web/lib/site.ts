import { join } from "node:path";
import type { SiteBuild } from "@readsmith/mdx";
import type { NormalizedSpec } from "@readsmith/model";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";

/**
 * Server-only. Reads the precompiled content bundle (produced by
 * scripts/build-content.mjs as a prebuild step) through the BundleStore port.
 * Next is the serving shell here: the compile happened before the build, so the
 * routes just read one immutable artifact. The store key is fixed and the local
 * driver root is a static subfolder, so the content pipeline is never traced
 * into the route graph. Swapping to an S3-compatible driver later touches only
 * the store construction, not any route.
 */
export interface Site {
  build: SiteBuild;
  name: string;
  branding: boolean;
  url?: string;
  description?: string;
  logo?: string;
  favicon?: string;
  /** The API-reference config from docs.yaml, when set (for the header cross-link). */
  apiReference?: { spec: string; path: string; label: string };
  /** Opaque AI config block from docs.yaml (validated at runtime by @readsmith/ai). */
  ai?: unknown;
}

/** The normalized API reference, ready to render. */
export interface ApiReference {
  spec: NormalizedSpec;
  path: string;
  label: string;
}

interface Bundle {
  site: Site;
  apiReference: ApiReference | null;
}

const BUNDLE_KEY = "bundle.json";
const store = createBundleStore(
  resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
);

let cached: Promise<Bundle> | null = null;

function loadBundle(): Promise<Bundle> {
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

export async function getSite(): Promise<Site> {
  return (await loadBundle()).site;
}

export async function getApiReference(): Promise<ApiReference | null> {
  return (await loadBundle()).apiReference;
}
