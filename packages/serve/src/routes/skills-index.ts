import { getBundle } from "../site.js";
import { skillsIndexResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return skillsIndexResponse(await getBundle());
}
