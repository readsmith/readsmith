import type { Diagnostic } from "@readsmith/model";
import type { NavItemInput, NavNode, PageRef } from "./schema.js";

function isIndexPath(path: string): boolean {
  const base = path
    .split("/")
    .pop()
    ?.replace(/\.(md|mdx)$/i, "")
    .toLowerCase();
  return base === "index" || base === "readme";
}

function humanize(segment: string): string {
  const words = segment.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface TreeDir {
  pages: PageRef[];
  dirs: Map<string, TreeDir>;
}

function emptyDir(): TreeDir {
  return { pages: [], dirs: new Map() };
}

/**
 * Build navigation from the file tree when the config declares none. Folders
 * become groups, files become pages. Within a directory, index/readme pages
 * come first, then remaining pages and subgroups in alphabetical order. The
 * result is deterministic and independent of filesystem enumeration order.
 */
export function buildAutoNav(pages: PageRef[]): NavNode[] {
  const root = emptyDir();
  for (const page of pages) {
    // The home page may live above the content root (`../README.md`). It belongs
    // at the top of the tree, not inside a group named "..".
    const segments = page.slug === "" ? [] : page.path.split("/").slice(0, -1);
    let dir = root;
    for (const seg of segments) {
      let next = dir.dirs.get(seg);
      if (!next) {
        next = emptyDir();
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.pages.push(page);
  }
  return dirToNav(root);
}

function dirToNav(dir: TreeDir): NavNode[] {
  const nodes: NavNode[] = [];

  const pages = [...dir.pages].sort((a, b) => {
    const ai = isIndexPath(a.path);
    const bi = isIndexPath(b.path);
    if (ai !== bi) return ai ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  for (const p of pages) nodes.push({ type: "page", slug: p.slug });

  for (const name of [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const child = dir.dirs.get(name);
    if (child) nodes.push({ type: "group", label: humanize(name), children: dirToNav(child) });
  }

  return nodes;
}

/**
 * Build navigation from the config's explicit `navigation`, resolving each page
 * reference (a slug, a path without extension, or a bare filename) to a known
 * page. Unresolvable references produce a diagnostic and are skipped.
 */
export function buildExplicitNav(
  navigation: NavItemInput[],
  pages: PageRef[],
): { nav: NavNode[]; diagnostics: Diagnostic[] } {
  const lookup = buildLookup(pages);
  const diagnostics: Diagnostic[] = [];

  function resolveItems(items: NavItemInput[]): NavNode[] {
    const out: NavNode[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        const slug = lookup.get(item);
        if (slug === undefined) {
          diagnostics.push({
            severity: "warning",
            code: "nav-missing-page",
            message: `Navigation references "${item}", which matches no content file.`,
            source: "navigation",
          });
          continue;
        }
        out.push({ type: "page", slug });
      } else {
        out.push({
          type: "group",
          label: item.group,
          children: resolveItems(item.pages),
          ...(item.tag !== undefined ? { tag: item.tag } : {}),
          ...(item.expanded !== undefined ? { expanded: item.expanded } : {}),
        });
      }
    }
    return out;
  }

  return { nav: resolveItems(navigation), diagnostics };
}

function buildLookup(pages: PageRef[]): Map<string, string> {
  const map = new Map<string, string>();
  // Specificity must hold ACROSS pages, not per page: write every page's
  // basename first, then every path, then every slug, so one page's bare
  // basename ("cli/apps.md" answering to "apps") can never clobber another
  // page's exact path or slug ("apps.md" at slug "apps").
  for (const page of pages) {
    const pathNoExt = page.path.replace(/\.(md|mdx)$/i, "");
    map.set(pathNoExt.split("/").pop() ?? pathNoExt, page.slug);
  }
  for (const page of pages) {
    map.set(page.path.replace(/\.(md|mdx)$/i, ""), page.slug);
  }
  for (const page of pages) {
    map.set(page.slug, page.slug);
  }
  return map;
}
