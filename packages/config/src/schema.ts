import type { Diagnostic } from "@readsmith/model";
import { z } from "zod";
import type { CspExtensions } from "./security.js";

/**
 * A navigation item in the user-authored config: either a page reference (a
 * slug or path) or a named group with its own child items. Recursive.
 */
export type NavItemInput = string | { group: string; pages: NavItemInput[] };

const navItemInputSchema: z.ZodType<NavItemInput> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({
      group: z.string(),
      pages: z.array(navItemInputSchema),
    }),
  ]),
);

/** A top-level navigation tab: a named section with its own navigation. */
export interface NavTabInput {
  tab: string;
  pages: NavItemInput[];
}

const navTabInputSchema = z.object({
  tab: z.string(),
  pages: z.array(navItemInputSchema),
});

/**
 * An asset directory mounted into the site. `from` is relative to the content
 * root and may escape it (real repos keep images beside the code, not beside the
 * prose); it may never escape the repository root. `to` is the URL path it is
 * served at. Declaring a mount is what makes an out-of-root directory public:
 * nothing outside the content root is ever copied by accident.
 */
export const assetMountSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type AssetMount = z.infer<typeof assetMountSchema>;

/**
 * How to treat links that leave the docs. A relative `.md` link that resolves to
 * no page and escapes the content root (`../SECURITY.md`) points at a real file
 * that is not a docs page; with `repo` set we send the reader to it on the forge
 * instead of emitting a dead href.
 */
export const linksSchema = z.object({
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

/**
 * The user-authored site config (our `docs.yaml` shape). Everything except
 * `site.name` is optional. When `navigation` is omitted the site auto-discovers
 * all content files and builds navigation from the file tree.
 */
export const configInputSchema = z.object({
  site: z.object({
    name: z.string(),
    /** Canonical base URL, e.g. https://docs.example.com. Enables absolute URLs
     * in the sitemap, RSS, llms.txt, and page metadata. */
    url: z.string().optional(),
    /** One-line site description, used in metadata and the agent outputs. */
    description: z.string().optional(),
    /** Logo image URL (served from content). Replaces the wordmark in the header. */
    logo: z.string().optional(),
    /** Favicon URL (served from content). Wired into page metadata. */
    favicon: z.string().optional(),
    /** Emitted as the JSON-LD `author`, when set. */
    author: z.object({ name: z.string().min(1), url: z.string().optional() }).optional(),
    /** Emitted as the JSON-LD `publisher`, when set. */
    publisher: z.object({ name: z.string().min(1), url: z.string().optional() }).optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
  }),
  /** Content-Security-Policy sources this site needs beyond `'self'`. */
  security: z
    .object({
      csp: z
        .object({
          imgSrc: z.array(z.string()).optional(),
          connectSrc: z.array(z.string()).optional(),
          fontSrc: z.array(z.string()).optional(),
          frameSrc: z.array(z.string()).optional(),
          frameAncestors: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  content: z
    .object({
      root: z.string().optional(),
      include: z.array(z.string()).optional(),
      /** Merged with the built-in defaults, never replacing them. */
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  /** Asset directories to publish, which may live outside the content root. */
  assets: z.array(assetMountSchema).optional(),
  /** Where links that leave the docs should point. */
  links: linksSchema.optional(),
  navigation: z.array(navItemInputSchema).optional(),
  /** Top-level navigation tabs. When set, the sidebar is scoped to the active tab. */
  tabs: z.array(navTabInputSchema).optional(),
  /** A read-only API reference from an OpenAPI spec, mounted alongside the docs. */
  apiReference: z
    .object({
      /** Path to the OpenAPI file, relative to the content root. */
      spec: z.string(),
      /** URL the reference is mounted at. Defaults to /api-reference. */
      path: z.string().optional(),
      /** Label used for the link into the reference. Defaults to "API Reference". */
      label: z.string().optional(),
    })
    .optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  /** Show the "Powered by Readsmith" badge. Defaults to true; set false to white-label. */
  branding: z.boolean().optional(),
  /**
   * AI: search, Ask-AI, and MCP. Passed through opaquely and validated by
   * `@readsmith/ai` at the boundary (this package must not depend on it). Keys
   * are NEVER here; they come from env/secrets.
   */
  ai: z.unknown().optional(),
});

export type ConfigInput = z.infer<typeof configInputSchema>;

/** A discovered content page: its path relative to the content root, and its URL slug. */
export interface PageRef {
  /** Path relative to the content root, POSIX separators, for example "guide/setup.mdx". */
  path: string;
  /** URL slug, for example "guide/setup". The root index page has slug "". */
  slug: string;
}

/** A resolved navigation node (the output tree the renderer consumes). */
export type NavNode =
  | { type: "page"; slug: string }
  | { type: "group"; label: string; children: NavNode[] };

/** A resolved top-level tab: a label and its own navigation tree. */
export interface NavTab {
  label: string;
  nav: NavNode[];
}

/** The fully resolved, defaulted config plus the discovered content. */
export interface ResolvedConfig {
  site: {
    name: string;
    url?: string;
    description?: string;
    logo?: string;
    favicon?: string;
    author?: { name: string; url?: string };
    publisher?: { name: string; url?: string };
    theme: Record<string, unknown>;
  };
  /** Resolved CSP extensions (always present, possibly empty). */
  security: { csp: CspExtensions };
  content: { root: string; include: string[]; exclude: string[] };
  /** Validated asset mounts. `from` is content-root-relative POSIX, normalized. */
  assets: AssetMount[];
  /** Resolved link policy. `branch` defaults to "main" once `repo` is set. */
  links: { repo?: string; branch: string };
  variables: Record<string, unknown>;
  pages: PageRef[];
  nav: NavNode[];
  /** Top-level tabs, when configured. Each carries its own navigation subtree. */
  tabs?: NavTab[];
  /** A read-only API reference from an OpenAPI spec, when configured. */
  apiReference?: { spec: string; path: string; label: string };
  /** Whether to show the "Powered by Readsmith" badge (white-label when false). */
  branding: boolean;
  /** Opaque AI config block, validated downstream by `@readsmith/ai`. */
  ai?: unknown;
  diagnostics: Diagnostic[];
}

export const DEFAULT_INCLUDE = ["**/*.md", "**/*.mdx"];

/**
 * Always excluded. A user's `content.exclude` is merged on top of these, never
 * substituted for them: writing `exclude: ["SECURITY.md"]` must not silently
 * re-enable a walk of `node_modules`.
 */
export const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**"];

/** Files never copied as assets: they are content, or they are the config itself. */
export const ASSET_SKIP_EXT = new Set([".md", ".mdx"]);
export const ASSET_SKIP_FILES = new Set(["docs.yaml", "docs.yml", "docs.json"]);
