import { getBundle } from "../site.js";
import { llmsFullTxtResponse } from "../text-routes.js";

export async function GET(): Promise<Response> {
  return llmsFullTxtResponse(await getBundle());
}
