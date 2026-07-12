import { getBundle } from "../site.js";
import { sitemapXmlResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return sitemapXmlResponse(await getBundle());
}
