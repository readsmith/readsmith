import type { Diagnostic } from "@readsmith/model";
import { z } from "zod";

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

/**
 * The user-authored site config (our `docs.yaml` shape). Everything except
 * `site.name` is optional. When `navigation` is omitted the site auto-discovers
 * all content files and builds navigation from the file tree.
 */
export const configInputSchema = z.object({
  site: z.object({
    name: z.string(),
    theme: z.record(z.string(), z.unknown()).optional(),
  }),
  content: z
    .object({
      root: z.string().optional(),
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  navigation: z.array(navItemInputSchema).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
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

/** The fully resolved, defaulted config plus the discovered content. */
export interface ResolvedConfig {
  site: { name: string; theme: Record<string, unknown> };
  content: { root: string; include: string[]; exclude: string[] };
  variables: Record<string, unknown>;
  pages: PageRef[];
  nav: NavNode[];
  diagnostics: Diagnostic[];
}

export const DEFAULT_INCLUDE = ["**/*.md", "**/*.mdx"];
export const DEFAULT_EXCLUDE = ["**/node_modules/**"];
