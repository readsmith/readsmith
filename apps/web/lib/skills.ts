import { getSite } from "@/lib/site";
import type { Skill } from "@readsmith/mdx";

/**
 * Server-only. The bundle's agent skills (assembly guarantees at least the
 * mechanical fallback; the guard covers a pre-skills bundle artifact).
 */
export async function getSkills(): Promise<Skill[]> {
  const { build } = await getSite();
  return build.skills ?? [];
}

/** Content type for a skill file; everything in a skill bundle is utf-8 text. */
export function skillContentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "text/yaml; charset=utf-8";
  return "text/plain; charset=utf-8";
}
