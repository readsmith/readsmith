import { HydrateClient } from "@/components/hydrate-client";
import { getSite } from "@/lib/site";
import { type ShellSite, renderShellBody } from "@readsmith/components";
import { notFound } from "next/navigation";

interface Params {
  slug?: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const { build } = await getSite();
  return build.pages
    .filter((page) => !page.hidden)
    .map((page) => ({ slug: page.slug === "" ? [] : page.slug.split("/") }));
}

export async function generateMetadata({ params }: { params: Params }) {
  const { build, name } = await getSite();
  const slug = (params.slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return { title: name };
  return { title: `${page.title} · ${name}`, description: page.description };
}

export default async function DocPage({ params }: { params: Params }) {
  const { build, name } = await getSite();
  const slug = (params.slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) notFound();

  const site: ShellSite = { name, nav: build.nav };
  const html = renderShellBody(site, page);

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted prebuilt page HTML from the P1-P7 pipeline */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <HydrateClient />
    </>
  );
}
