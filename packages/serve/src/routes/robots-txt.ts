import { getBundle } from "../site.js";
import { robotsTxtResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return robotsTxtResponse(await getBundle());
}
