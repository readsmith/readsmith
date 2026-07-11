import { getSkills } from "@/lib/skills";

/**
 * The root skill entry point (Mintlify-compatible behavior): a single skill
 * serves its SKILL.md directly; several redirect to the discovery index so the
 * client picks. Assembly guarantees at least the fallback skill.
 */
export const dynamic = "force-static";

export async function GET() {
  const skills = await getSkills();
  if (skills.length > 1) {
    return new Response(null, {
      status: 307,
      headers: { location: "/.well-known/skills/index.json" },
    });
  }
  const content = skills[0]?.files[0]?.content;
  if (!content) return new Response("Not found", { status: 404 });
  return new Response(content, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
