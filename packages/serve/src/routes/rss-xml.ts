import { getBundle } from "../site.js";
import { rssXmlResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return rssXmlResponse(await getBundle());
}
