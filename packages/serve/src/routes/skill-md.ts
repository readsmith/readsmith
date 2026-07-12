import { getBundle } from "../site.js";
import { skillMdResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return skillMdResponse(await getBundle());
}
