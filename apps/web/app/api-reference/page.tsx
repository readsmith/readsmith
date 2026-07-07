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
  const { name, url, logo, favicon, branding } = await getSite();

  const site: ShellSite = {
    name,
    nav: [],
    url,
    logo,
    poweredBy: branding,
    links: [{ label: "Docs", href: "/" }],
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
