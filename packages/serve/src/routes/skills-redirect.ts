import { getBundle } from "../site.js";
import { skillsRedirectResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return skillsRedirectResponse(await getBundle());
}
