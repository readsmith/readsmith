import { getBundle } from "../site.js";
import { llmsTxtResponse } from "../text-routes.js";

// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

export async function GET(): Promise<Response> {
  return llmsTxtResponse(await getBundle());
}
