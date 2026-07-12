import { describe, expect, it } from "vitest";
import type { Bundle } from "../src/site.js";
import {
  llmsTxtResponse,
  rawMarkdownResponse,
  robotsTxtResponse,
  sitemapXmlResponse,
  skillFileResponse,
  skillMdResponse,
  skillsIndexResponse,
} from "../src/text-routes.js";

function bundle(overrides: Partial<Bundle["site"]> = {}, apiReference: Bundle["apiReference"] = null): Bundle {
  return {
    site: {
      name: "Demo",
      branding: true,
      url: "https://demo.readsmith.app",
      build: {
        pages: [{ slug: "guide", rawMd: "# Guide\n", hidden: false }],
        llmsTxt: "# Demo\n\n- [Guide](https://demo.readsmith.app/guide)\n",
        llmsFullTxt: "full",
        sitemap: `<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://demo.readsmith.app/guide</loc></url>\n</urlset>`,
        rss: "<rss/>",
        skills: [
          {
            name: "demo",
            description: "Demo skill",
            files: [{ path: "SKILL.md", content: "# Skill\n" }],
          },
        ],
      },
      ...overrides,
    } as unknown as Bundle["site"],
    apiReference,
  };
}

describe("text routes from a bundle", () => {
  it("merges API operations into llms.txt with absolute links", async () => {
    const withRef = bundle({}, {
      path: "/api-reference",
      label: "API",
      spec: {
        operations: [{ id: "op-get-pets", method: "get", path: "/pets", summary: "List pets" }],
      },
    } as unknown as Bundle["apiReference"]);
    const text = await llmsTxtResponse(withRef).text();
    expect(text).toContain("## API reference");
    expect(text).toContain("[GET /pets](https://demo.readsmith.app/api-reference#op-get-pets): List pets");
    // Without a reference, the built text passes through untouched.
    expect(await llmsTxtResponse(bundle()).text()).toBe(bundle().site.build.llmsTxt);
  });

  it("points robots at the site's own sitemap", async () => {
    expect(await robotsTxtResponse(bundle()).text()).toContain(
      "Sitemap: https://demo.readsmith.app/sitemap.xml",
    );
  });

  it("appends the API reference page to the sitemap, escaped", async () => {
    const withRef = bundle({}, {
      path: "/api-reference",
      label: "API",
      spec: { operations: [] },
    } as unknown as Bundle["apiReference"]);
    const xml = await sitemapXmlResponse(withRef).text();
    expect(xml).toContain("<loc>https://demo.readsmith.app/api-reference</loc>");
  });

  it("serves raw markdown by slug and 404s unknown slugs", async () => {
    expect(await rawMarkdownResponse(bundle(), "guide").text()).toBe("# Guide\n");
    expect(rawMarkdownResponse(bundle(), "nope").status).toBe(404);
  });

  it("serves a single skill directly and lists it in the index", async () => {
    const single = skillMdResponse(bundle());
    expect(single.status).toBe(200);
    expect(await single.text()).toBe("# Skill\n");
    const index = (await skillsIndexResponse(bundle()).json()) as { skills: { name: string }[] };
    expect(index.skills.map((s) => s.name)).toEqual(["demo"]);
    expect(skillFileResponse(bundle(), "demo", "SKILL.md").status).toBe(200);
    expect(skillFileResponse(bundle(), "demo", "../etc/passwd").status).toBe(404);
  });

  it("redirects the skill root to the index when several skills exist", () => {
    const many = bundle();
    // biome-ignore lint/suspicious/noExplicitAny: fixture shaping
    (many.site.build as any).skills.push({ name: "second", description: "", files: [] });
    const res = skillMdResponse(many);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/.well-known/skills/index.json");
  });
});
