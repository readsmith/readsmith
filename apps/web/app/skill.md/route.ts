import { getSite } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const { build } = await getSite();
  return new Response(build.skillMd, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
