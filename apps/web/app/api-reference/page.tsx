import { HydrateClient } from "@/components/hydrate-client";
import { type ShellSite, renderReferenceBody } from "@readsmith/components";
import { getApiReference, getSite, renderDocPage } from "@readsmith/serve";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const ref = await getApiReference();
  const { name, url } = await getSite();
  if (!ref) return { title: name };
  const title = `${ref.spec.info.title} · ${name}`;
  return {
    title,
    description: ref.spec.info.description,
    alternates: { canonical: ref.path },
    openGraph: { title, description: ref.spec.info.description, siteName: name, url: ref.path },
    metadataBase: baseUrl(url),
  };
}

function baseUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export default async function ApiReferencePage() {
  const ref = await getApiReference();
  if (!ref) notFound();

  // Pages mode: the root serves the generated overview (a normal built page);
  // the per-operation pages live under it in the catch-all docs route.
  if (ref.layout === "pages") {
    const rendered = await renderDocPage(ref.path.replace(/^\//, ""));
    if (!rendered) notFound();
    return (
      <>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prebuilt page HTML from the P1-P7 pipeline */}
        <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        <HydrateClient />
      </>
    );
  }

  const { build, name, url, logo, branding } = await getSite();

  // Mirror the docs pages' tab bar with the reference tab active, so the
  // reference reads as a section of one product, not a side page. A tabless
  // site falls back to a plain "Docs" header link.
  const contentTabs = (build.tabs ?? []).map((tab) => ({
    label: tab.label,
    url: tab.url,
    active: false,
  }));
  const tabs =
    contentTabs.length > 0
      ? [...contentTabs, { label: ref.label, url: ref.path, active: true }]
      : undefined;
  const site: ShellSite = {
    name,
    nav: [],
    url,
    logo,
    poweredBy: branding,
    tabs,
    links: tabs ? undefined : [{ label: "Docs", href: "/" }],
  };
  const html = renderReferenceBody(site, ref.spec, { basePath: ref.path });

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prebuilt reference HTML */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <HydrateClient />
    </>
  );
}
