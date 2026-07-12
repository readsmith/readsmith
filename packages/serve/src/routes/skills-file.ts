import { getSkills, skillContentType } from "../skills.js";

/**
 * One skill file, e.g. `/.well-known/skills/pets/SKILL.md`. Paths resolve only
 * against the bundle's file map, never the filesystem, so there is no traversal
 * surface. Unknown skill or file: 404.
 */
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

interface Params {
  name: string;
  file: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const skills = await getSkills();
  return skills.flatMap((s) => s.files.map((f) => ({ name: s.name, file: f.path.split("/") })));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<Params> },
): Promise<Response> {
  const { name, file } = await params;
  const path = file.join("/");
  const skills = await getSkills();
  const hit = skills.find((s) => s.name === name)?.files.find((f) => f.path === path);
  if (!hit) return new Response("Not found", { status: 404 });
  return new Response(hit.content, {
    headers: { "content-type": skillContentType(path) },
  });
}
