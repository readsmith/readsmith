import { getSite } from "@/lib/site";
import { getSkills } from "@/lib/skills";
import { siteBasePath } from "@readsmith/config";

/**
 * The root skill entry point (Mintlify-compatible behavior): a single skill
 * serves its SKILL.md directly; several redirect to the discovery index so the
 * client picks. Assembly guarantees at least the fallback skill.
 */
export const dynamic = "force-static";
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function GET() {
  const skills = await getSkills();
  if (skills.length > 1) {
    // Location headers are not basePath-scoped by Next; prefix explicitly.
    const base = siteBasePath((await getSite()).url);
    return new Response(null, {
      status: 307,
      headers: { location: `${base}/.well-known/skills/index.json` },
    });
  }
  const content = skills[0]?.files[0]?.content;
  if (!content) return new Response("Not found", { status: 404 });
  return new Response(content, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
