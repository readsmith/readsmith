import { type ShellSite, type ShellTab, renderShellBody } from "@readsmith/components";
import { siteBasePath } from "@readsmith/config";
import type { FinalNavNode, FinalNavTab, PageModel } from "@readsmith/mdx";
import { type Bundle, getBundle } from "./site.js";

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
  const bar = tabs.map((tab, i) => ({
    label: tab.label,
    url: tab.url,
    active: i === activeIndex,
    ...(tab.icon ? { icon: tab.icon } : {}),
  }));
  return { nav: active?.nav ?? fallbackNav, bar };
}

export interface RenderedPage {
  page: PageModel;
  html: string;
}

/**
 * Render the page at `slug` from the given bundle, or null when no such page
 * exists. Pure over its inputs: a multi-site host resolves the bundle per
 * request (loadBundleForSite) and renders through the exact code path the
 * single-site app uses, so tenant serving can never drift from self-host.
 */
export function renderPageFromBundle(bundle: Bundle, slug: string): RenderedPage | null {
  const { build, name, branding, url, logo, homeUrl, apiReference, footer } = bundle.site;
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return null;

  const { nav, bar } = resolveTabs(build.tabs, build.nav, slug);
  // The API reference joins the tab bar (the common pattern: one product, one
  // row). In pages mode the build already carries its tab; in single mode it is
  // appended here. A tabless site keeps the header cross-link instead.
  // Tab URLs from the build already carry any subpath prefix; the config path
  // does not, so it is prefixed here before comparing or serving (SP-2).
  const refUrl = apiReference ? siteBasePath(url) + apiReference.path : "";
  const hasRefTab = apiReference && bar?.some((tab) => tab.url === refUrl);
  const tabs =
    bar && apiReference && !hasRefTab
      ? [...bar, { label: apiReference.label, url: refUrl, active: false }]
      : bar;
  const links = !bar && apiReference ? [{ label: apiReference.label, href: refUrl }] : undefined;
  const site: ShellSite = {
    name,
    nav,
    tabs,
    poweredBy: branding,
    url,
    logo,
    homeUrl,
    links,
    footer,
  };

  // Hybrid operation and data-model pages render their generated sections from
  // the normalized spec, carried in the same bundle.
  const needsSpec = page.kind === "api-operation" || page.kind === "api-schema";
  const apiSpec = needsSpec ? bundle.apiReference?.spec : undefined;
  return { page, html: renderShellBody(site, page, { apiSpec: apiSpec ?? null }) };
}

/** Render the default site's page at `slug` (the single-site app's path). */
export async function renderDocPage(slug: string): Promise<RenderedPage | null> {
  return renderPageFromBundle(await getBundle(), slug);
}
