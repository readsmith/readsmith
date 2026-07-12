import { getSkills } from "../skills.js";
import { getBundle } from "../site.js";
import { skillFileResponse } from "../text-routes.js";

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
  return skillFileResponse(await getBundle(), name, file.join("/"));
}
