import { HydrateClient } from "@/components/hydrate-client";
import { getSite } from "@/lib/site";
import { type ShellSite, type ShellTab, renderShellBody } from "@readsmith/components";
import type { FinalNavNode, FinalNavTab } from "@readsmith/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

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

interface Params {
  slug?: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const { build } = await getSite();
  return build.pages
    .filter((page) => !page.hidden)
    .map((page) => ({ slug: page.slug === "" ? [] : page.slug.split("/") }));
}

function baseUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { build, name, url, description, favicon } = await getSite();
  const base = baseUrl(url);
  const icons = favicon ? { icon: favicon } : undefined;
  const slug = ((await params).slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return { title: name, metadataBase: base, icons };

  const title = `${page.title} · ${name}`;
  const desc = page.description ?? description;
  return {
    metadataBase: base,
    title,
    description: desc,
    icons,
    alternates: { canonical: page.url },
    // Dropping a page from the sitemap does not stop a crawler that finds it via
    // an inbound link. Only the robots meta does.
    ...(page.noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: { title, description: desc, siteName: name, type: "article", url: page.url },
    twitter: { card: "summary_large_image", title, description: desc },
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const { build, name, branding, url, logo, apiReference } = await getSite();
  const slug = ((await params).slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) notFound();

  const { nav, bar } = resolveTabs(build.tabs, build.nav, slug);
  const links = apiReference ? [{ label: apiReference.label, href: apiReference.path }] : undefined;
  const site: ShellSite = { name, nav, tabs: bar, poweredBy: branding, url, logo, links };
  const html = renderShellBody(site, page);

  const base = url ? url.replace(/\/+$/, "") : "";
  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    description: page.description,
    url: base ? base + page.url : page.url,
    isPartOf: { "@type": "WebSite", name },
  });

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD structured data */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson }} />
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prebuilt page HTML from the P1-P7 pipeline */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <HydrateClient />
    </>
  );
}
