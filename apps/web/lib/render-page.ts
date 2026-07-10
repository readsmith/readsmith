import { getApiReference } from "@/lib/api-reference";
import { getSite } from "@/lib/site";
import { type ShellSite, type ShellTab, renderShellBody } from "@readsmith/components";
import type { FinalNavNode, FinalNavTab, PageModel } from "@readsmith/mdx";

/**
 * Server-only. Renders one built page into the reading shell: sidebar and tab
 * resolution, the API-reference tab (from the build in pages mode, appended
 * here in single mode), and the spec handoff for hybrid operation pages. The
 * catch-all docs route and the reference route (pages-mode overview) share it,
 * so the two entrances can never drift apart.
 */

/** Whether a finalized nav subtree contains the given page slug. */
function navHasSlug(nav: FinalNavNode[], slug: string): boolean {
  return nav.some((node) =>
    node.type === "page" ? node.slug === slug : navHasSlug(node.children, slug),
  );
}

/** Resolve the sidebar nav and the tab bar for a page, given the build's tabs. */
function resolveTabs(
  tabs: FinalNavTab[] | undefined,
  fallbackNav: FinalNavNode[],
  slug: string,
): { nav: FinalNavNode[]; bar?: ShellTab[] } {
  if (!tabs || tabs.length === 0) return { nav: fallbackNav };
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => navHasSlug(tab.nav, slug)),
  );
  const active = tabs[activeIndex] ?? tabs[0];
  const bar = tabs.map((tab, i) => ({ label: tab.label, url: tab.url, active: i === activeIndex }));
  return { nav: active?.nav ?? fallbackNav, bar };
}

export interface RenderedPage {
  page: PageModel;
  html: string;
}

/** Render the page at `slug` into the shell, or null when no such page exists. */
export async function renderDocPage(slug: string): Promise<RenderedPage | null> {
  const { build, name, branding, url, logo, apiReference, footer } = await getSite();
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return null;

  const { nav, bar } = resolveTabs(build.tabs, build.nav, slug);
  // The API reference joins the tab bar (the Mintlify pattern: one product, one
  // row). In pages mode the build already carries its tab; in single mode it is
  // appended here. A tabless site keeps the header cross-link instead.
  const hasRefTab = apiReference && bar?.some((tab) => tab.url === apiReference.path);
  const tabs =
    bar && apiReference && !hasRefTab
      ? [...bar, { label: apiReference.label, url: apiReference.path, active: false }]
      : bar;
  const links =
    !bar && apiReference ? [{ label: apiReference.label, href: apiReference.path }] : undefined;
  const site: ShellSite = { name, nav, tabs, poweredBy: branding, url, logo, links, footer };

  // Hybrid operation pages render their generated sections from the normalized
  // spec; the bundle is memoized, so this is a cheap read for doc pages too.
  const apiSpec = page.kind === "api-operation" ? (await getApiReference())?.spec : undefined;
  return { page, html: renderShellBody(site, page, { apiSpec: apiSpec ?? null }) };
}
