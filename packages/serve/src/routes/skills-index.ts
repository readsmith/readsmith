import { getSkills } from "../skills.js";

/**
 * Agent-skills discovery index (agentskills.io convention, Mintlify-compatible
 * shape): what skills exist and which files each bundles. `npx skills add
 * <domain>` and MCP-less agents start here.
 */
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.

export async function GET(): Promise<Response> {
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
