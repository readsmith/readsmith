import { describe, expect, it } from "vitest";
import { GET as faviconGet } from "../src/routes/favicon.js";
import { escapeHtml, setupPage } from "../src/setup.js";
import { skillContentType } from "../src/skills.js";

describe("skillContentType", () => {
  it("maps skill bundle extensions to utf-8 text types", () => {
    expect(skillContentType("SKILL.md")).toBe("text/markdown; charset=utf-8");
    expect(skillContentType("meta.json")).toBe("application/json; charset=utf-8");
    expect(skillContentType("config.yaml")).toBe("text/yaml; charset=utf-8");
    expect(skillContentType("config.yml")).toBe("text/yaml; charset=utf-8");
    expect(skillContentType("script.sh")).toBe("text/plain; charset=utf-8");
  });
});

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("setupPage", () => {
  it("returns a noindex, never-cached page with the title escaped", async () => {
    const res = setupPage("<Setup>", "<h1>ok</h1>", 200);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("<title>&lt;Setup&gt;</title>");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("<h1>ok</h1>");
  });
});

describe("favicon route", () => {
  it("serves the hallmark SVG with long-lived caching", async () => {
    const res = faviconGet();
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    expect(await res.text()).toContain("<svg");
  });
});
