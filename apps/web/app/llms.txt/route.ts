import { getApiReference } from "@/lib/api-reference";
import { getSite } from "@/lib/site";

export const dynamic = "force-static";
// Regenerate at most once a minute: a published deployment (pointer flip)
// becomes visible without an app rebuild; docs-only output is unchanged.
export const revalidate = 60;

export async function GET() {
  const { build, url } = await getSite();
  const ref = await getApiReference();

  let text = build.llmsTxt;
  if (ref) {
    const base = url ? url.replace(/\/+$/, "") : "";
    const lines = ["## API reference", ""];
    for (const op of ref.spec.operations) {
      const summary = op.summary ? `: ${op.summary}` : "";
      lines.push(
        `- [${op.method.toUpperCase()} ${op.path}](${base}${ref.path}#${op.id})${summary}`,
      );
    }
    text = `${text.trimEnd()}\n\n${lines.join("\n")}\n`;
  }

  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
