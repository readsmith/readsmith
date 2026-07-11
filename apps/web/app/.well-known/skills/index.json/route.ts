import { getSkills } from "@/lib/skills";

/**
 * Agent-skills discovery index (agentskills.io convention, Mintlify-compatible
 * shape): what skills exist and which files each bundles. `npx skills add
 * <domain>` and MCP-less agents start here.
 */
export const dynamic = "force-static";

export async function GET() {
  const skills = await getSkills();
  const body = {
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      files: s.files.map((f) => f.path),
    })),
  };
  return Response.json(body);
}
