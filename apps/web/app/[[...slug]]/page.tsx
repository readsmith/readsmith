import { HydrateClient } from "@/components/hydrate-client";
import { renderDocPage } from "@/lib/render-page";
import { getSite } from "@/lib/site";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

interface Params {
  slug?: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const { build, apiReference } = await getSite();
  // The reference ROOT belongs to the dedicated route (a static segment wins
  // over this catch-all); its children (pages-mode operations) are served here.
  const refSlug = apiReference?.path.replace(/^\//, "");
  return build.pages
    .filter((page) => !page.hidden && page.slug !== refSlug)
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
  const { build, name, url, description } = await getSite();
  const base = baseUrl(url);
  // Icons come from the root layout's metadata (site favicon or the default
  // hallmark); per-field merging keeps them without re-declaring here.
  const slug = ((await params).slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return { title: name, metadataBase: base };

  const title = `${page.title} · ${name}`;
  const desc = page.description ?? description;
  // A pages-mode mirror canonicalizes to the authored page it duplicates.
  const canonical = page.canonicalOf ?? page.url;
  return {
    metadataBase: base,
    title,
    description: desc,
    alternates: { canonical },
    // Dropping a page from the sitemap does not stop a crawler that finds it via
    // an inbound link. Only the robots meta does.
    ...(page.noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: { title, description: desc, siteName: name, type: "article", url: canonical },
    twitter: { card: "summary_large_image", title, description: desc },
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const slug = ((await params).slug ?? []).join("/");
  const rendered = await renderDocPage(slug);
  if (!rendered) notFound();
  const { page, html } = rendered;

  return (
    <>
      {/* The payload is script-escaped at build time by serializeJsonLd: `<`, `>`,
          and `&` become their JSON unicode forms, so an author-controlled title
          cannot close this element. The CSP allows inline scripts, so that escape
          is the only line of defense here. */}
      {page.jsonLd ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by serializeJsonLd at build time
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: page.jsonLd }} />
      ) : null}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prebuilt page HTML from the P1-P7 pipeline */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <HydrateClient />
    </>
  );
}
