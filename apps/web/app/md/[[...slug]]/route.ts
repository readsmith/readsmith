import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function generateStaticParams(): Promise<{ slug?: string[] }[]> {
  const { build } = await getSite();
  return build.pages
    .filter((page) => !page.hidden)
    .map((page) => ({ slug: page.slug === "" ? [] : page.slug.split("/") }));
}

/** Serve a page's raw Markdown at /md/{slug}, for agents and "view as Markdown". */
export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { build } = await getSite();
  const slug = ((await params).slug ?? []).join("/");
  const page = build.pages.find((p) => p.slug === slug);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(page.rawMd, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
