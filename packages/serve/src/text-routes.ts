import { siteBasePath } from "@readsmith/config";
import type { Skill } from "@readsmith/mdx";
import type { Bundle } from "./site.js";
import { skillContentType } from "./skills.js";

/**
 * The text surfaces (agent outputs, crawler files, raw Markdown, agent
 * skills) as pure functions over a bundle. The single-site route modules
 * delegate with the default bundle; a multi-site host resolves the bundle per
 * request and calls the same functions, so tenant serving can never drift
 * from self-host.
 */

const TEXT = { "content-type": "text/plain; charset=utf-8" };
const MARKDOWN = { "content-type": "text/markdown; charset=utf-8" };

function skillsOf(bundle: Bundle): Skill[] {
  return bundle.site.build.skills ?? [];
}

/** llms.txt: the built index, with API-reference operations merged in. */
export function llmsTxtResponse(bundle: Bundle): Response {
  const { build, url } = bundle.site;
  const ref = bundle.apiReference;
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
  return new Response(text, { headers: TEXT });
}

export function llmsFullTxtResponse(bundle: Bundle): Response {
  return new Response(bundle.site.build.llmsFullTxt, { headers: TEXT });
}

export function robotsTxtResponse(bundle: Bundle): Response {
  const base = bundle.site.url ? bundle.site.url.replace(/\/+$/, "") : "";
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`, {
    headers: TEXT,
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** sitemap.xml: the built map, with the API-reference page appended. */
export function sitemapXmlResponse(bundle: Bundle): Response {
  const { build, url } = bundle.site;
  const ref = bundle.apiReference;
  let xml = build.sitemap;
  if (ref) {
    const base = url ? url.replace(/\/+$/, "") : "";
    const loc = `${base}${ref.path}`;
    xml = xml.replace("</urlset>", `  <url><loc>${escapeXml(loc)}</loc></url>\n</urlset>`);
  }
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

export function rssXmlResponse(bundle: Bundle): Response {
  return new Response(bundle.site.build.rss, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}

/**
 * The root skill entry point (Mintlify-compatible behavior): a single skill
 * serves its SKILL.md directly; several redirect to the discovery index so
 * the client picks. Assembly guarantees at least the fallback skill.
 */
export function skillMdResponse(bundle: Bundle): Response {
  const skills = skillsOf(bundle);
  if (skills.length > 1) {
    // Location headers are not basePath-scoped by Next; prefix explicitly.
    const base = siteBasePath(bundle.site.url);
    return new Response(null, {
      status: 307,
      headers: { location: `${base}/.well-known/skills/index.json` },
    });
  }
  const content = skills[0]?.files[0]?.content;
  if (!content) return new Response("Not found", { status: 404 });
  return new Response(content, { headers: MARKDOWN });
}

/** A page's raw Markdown (the /md/{slug} mirror, for agents and "view as Markdown"). */
export function rawMarkdownResponse(bundle: Bundle, slug: string): Response {
  const page = bundle.site.build.pages.find((p) => p.slug === slug);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(page.rawMd, { headers: MARKDOWN });
}

/** The bare /.well-known/skills directory: land on the index, not a 404. */
export function skillsRedirectResponse(bundle: Bundle): Response {
  const base = siteBasePath(bundle.site.url);
  return new Response(null, {
    status: 308,
    headers: { location: `${base}/.well-known/skills/index.json` },
  });
}

/** Agent-skills discovery index (agentskills.io convention). */
export function skillsIndexResponse(bundle: Bundle): Response {
  const body = {
    skills: skillsOf(bundle).map((s) => ({
      name: s.name,
      description: s.description,
      files: s.files.map((f) => f.path),
    })),
  };
  return Response.json(body);
}

/**
 * One skill file. Paths resolve only against the bundle's file map, never the
 * filesystem, so there is no traversal surface.
 */
export function skillFileResponse(bundle: Bundle, name: string, filePath: string): Response {
  const hit = skillsOf(bundle)
    .find((s) => s.name === name)
    ?.files.find((f) => f.path === filePath);
  if (!hit) return new Response("Not found", { status: 404 });
  return new Response(hit.content, { headers: { "content-type": skillContentType(filePath) } });
}
