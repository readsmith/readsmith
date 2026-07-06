import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const { build } = await getSite();
  return new Response(build.llmsFullTxt, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
