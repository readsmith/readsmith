import { getBundle, getSite } from "../site.js";
import { rawMarkdownResponse } from "../text-routes.js";

export async function generateStaticParams(): Promise<{ slug?: string[] }[]> {
  const { build } = await getSite();
  return build.pages
    .filter((page) => !page.hidden)
    .map((page) => ({ slug: page.slug === "" ? [] : page.slug.split("/") }));
}

/** Serve a page's raw Markdown at /md/{slug}, for agents and "view as Markdown". */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  return rawMarkdownResponse(await getBundle(), ((await params).slug ?? []).join("/"));
}
