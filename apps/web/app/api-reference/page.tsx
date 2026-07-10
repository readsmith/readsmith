import { HydrateClient } from "@/components/hydrate-client";
import { getApiReference } from "@/lib/api-reference";
import { getSite } from "@/lib/site";
import { type ShellSite, renderReferenceBody } from "@readsmith/components";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

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
