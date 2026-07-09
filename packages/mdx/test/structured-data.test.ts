import { describe, expect, it } from "vitest";
import {
  type AssembleInput,
  type NavNode,
  type SiteConfig,
  assembleSite,
} from "../src/assemble.js";
import type { ComponentRegistry } from "../src/render.js";
import { buildJsonLd, deepMerge, serializeJsonLd } from "../src/structured-data.js";

const registry: ComponentRegistry = {};

/** The payload that used to close the script element and execute. */
const BREAKOUT = "x</script><img src=x onerror=alert(1)>";

const site = { name: "Docs", url: "https://docs.example.com" };
const basePage = { title: "Setup", url: "/setup", hidden: false, frontmatter: {} };

/**
 * Pull the ld+json payload out of rendered HTML, the way a browser's parser would:
 * stop at the first `</script>`. Build the regex fresh each call, since a /g regex
 * carries `lastIndex` between uses.
 */
function scriptBodies(html: string): string[] {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  return [...html.matchAll(re)].map((m) => m[1] ?? "");
}

describe("serializeJsonLd: script breakout", () => {
  // AC-9.2
  it("AC-9.2: never emits a literal <, >, or & inside the payload", () => {
    const payload = serializeJsonLd({ headline: BREAKOUT, note: "a & b" });
    expect(payload).not.toContain("<");
    expect(payload).not.toContain(">");
    expect(payload).not.toContain("&");
    expect(payload).not.toContain("</script");
  });

  // AC-9.3
  it("AC-9.3: round-trips, so the escaped payload is still the same JSON-LD", () => {
    const source = { "@type": "TechArticle", headline: BREAKOUT, isPartOf: { name: "A & B" } };
    expect(JSON.parse(serializeJsonLd(source))).toEqual(source);
  });

  it("escapes the angle brackets as JSON unicode, not as HTML entities", () => {
    // A JSON string containing < parses back to "<": still valid JSON-LD.
    const payload = serializeJsonLd({ h: "<" });
    expect(payload).toBe('{"h":"\\u003c"}');
    expect(JSON.parse(payload).h).toBe("<");
  });

  // AC-9.1, at the unit level. The end-to-end assertion lives below.
  //
  // The word "onerror" still appears, as inert text inside a JSON string. What
  // matters to an HTML parser is `<`: without one, no tag can begin. So assert on
  // tags, not on scary substrings.
  it("AC-9.1: a headline containing </script> cannot terminate the element", () => {
    const html = `<script type="application/ld+json">${serializeJsonLd({ headline: BREAKOUT })}</script>`;
    expect(html.match(/<[a-zA-Z]/g)).toHaveLength(1); // one tag opens: our script
    expect(html.match(/<\//g)).toHaveLength(1); // one tag closes: our script
    expect(html).not.toContain("<img");
    // And the value survives intact as data.
    expect(JSON.parse(scriptBodies(html)[0] ?? "").headline).toBe(BREAKOUT);
  });
});

describe("buildJsonLd", () => {
  // AC-9.6
  it("AC-9.6: defaults to TechArticle", () => {
    const doc = JSON.parse(buildJsonLd(site, basePage) ?? "");
    expect(doc["@context"]).toBe("https://schema.org");
    expect(doc["@type"]).toBe("TechArticle");
    expect(doc.headline).toBe("Setup");
  });

  it("uses the canonical base for the page url, and stays relative without one", () => {
    expect(JSON.parse(buildJsonLd(site, basePage, "https://docs.example.com") ?? "").url).toBe(
      "https://docs.example.com/setup",
    );
    expect(JSON.parse(buildJsonLd({ name: "Docs" }, basePage) ?? "").url).toBe("/setup");
  });

  // AC-9.4
  it("AC-9.4: a hidden page emits nothing", () => {
    expect(buildJsonLd(site, { ...basePage, hidden: true })).toBeNull();
  });

  // AC-9.7
  it("AC-9.7: author and publisher appear only when configured", () => {
    const bare = JSON.parse(buildJsonLd(site, basePage) ?? "");
    expect(bare).not.toHaveProperty("author");
    expect(bare).not.toHaveProperty("publisher");

    const full = JSON.parse(
      buildJsonLd(
        { ...site, author: { name: "Ada" }, publisher: { name: "Acme", url: "https://acme.dev" } },
        basePage,
      ) ?? "",
    );
    expect(full.author).toEqual({ "@type": "Person", name: "Ada" });
    expect(full.publisher).toEqual({
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.dev",
    });
  });

  // AC-9.5
  it("AC-9.5: frontmatter jsonLd merges over the defaults", () => {
    const doc = JSON.parse(
      buildJsonLd(site, {
        ...basePage,
        frontmatter: { jsonLd: { "@type": "HowTo", headline: "Overridden" } },
      }) ?? "",
    );
    expect(doc["@type"]).toBe("HowTo"); // AC-9.6: selectable
    expect(doc.headline).toBe("Overridden");
    expect(doc["@context"]).toBe("https://schema.org"); // untouched default survives
  });

  // AC-9.5
  it("AC-9.5: unknown keys pass through, and nested objects deep-merge", () => {
    const doc = JSON.parse(
      buildJsonLd(site, {
        ...basePage,
        frontmatter: {
          jsonLd: { datePublished: "2026-01-01", isPartOf: { url: "https://x.dev" } },
        },
      }) ?? "",
    );
    expect(doc.datePublished).toBe("2026-01-01");
    // isPartOf.name from the default survives the nested merge.
    expect(doc.isPartOf).toEqual({ "@type": "WebSite", name: "Docs", url: "https://x.dev" });
  });

  it("ignores a non-object jsonLd frontmatter value", () => {
    const doc = JSON.parse(buildJsonLd(site, { ...basePage, frontmatter: { jsonLd: 42 } }) ?? "");
    expect(doc["@type"]).toBe("TechArticle");
  });

  it("escapes a malicious title even after a frontmatter merge", () => {
    const payload = buildJsonLd(site, {
      ...basePage,
      title: BREAKOUT,
      frontmatter: { jsonLd: { description: BREAKOUT } },
    });
    expect(payload).not.toContain("<");
    expect(JSON.parse(payload ?? "").headline).toBe(BREAKOUT);
  });

  // AC-9.8
  it("AC-9.8: is deterministic", () => {
    const page = { ...basePage, frontmatter: { jsonLd: { datePublished: "2026-01-01" } } };
    expect(buildJsonLd(site, page, "https://d.example")).toBe(
      buildJsonLd(site, page, "https://d.example"),
    );
  });
});

describe("deepMerge", () => {
  it("keeps base key order and appends new keys in patch order", () => {
    expect(Object.keys(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 }))).toEqual(["a", "b", "c"]);
  });

  it("replaces arrays rather than concatenating them", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
});

/** The whole way through: a page whose frontmatter title is an attack. */
describe("assembleSite: structured data", () => {
  function build(files: Record<string, string>, siteOver: Partial<SiteConfig["site"]> = {}) {
    const pages = Object.keys(files).map((path) => ({
      path,
      slug: path === "index.md" ? "" : path.replace(/\.md$/, ""),
    }));
    const config: SiteConfig = {
      site: { name: "Docs", url: "https://docs.example.com", ...siteOver },
      pages,
      nav: pages.map((p) => ({ type: "page", slug: p.slug }) as NavNode),
    };
    const input: AssembleInput = { config, readPage: (p) => files[p] ?? "", registry };
    return assembleSite(input);
  }

  // AC-9.1 end to end.
  it("AC-9.1: a page titled with </script> yields exactly one script and no injected node", async () => {
    const site = await build({
      "index.md": `---\ntitle: "${BREAKOUT.replace(/"/g, '\\"')}"\n---\n\n# Home\n`,
    });
    const payload = site.pages[0]?.jsonLd ?? "";
    const html = `<script type="application/ld+json">${payload}</script>`;

    // Exactly one element: nothing was injected. `<` never survives the escape,
    // so the parser cannot be induced to open a second tag.
    expect(html.match(/<[a-zA-Z]/g)).toHaveLength(1);
    expect(html.match(/<\//g)).toHaveLength(1);
    expect(payload).not.toContain("<");
    expect(JSON.parse(payload).headline).toBe(BREAKOUT);
  });

  it("attaches an absolute url from site.url", async () => {
    const site = await build({ "guide.md": "---\ntitle: Guide\n---\n\n# Guide\n" });
    expect(JSON.parse(site.pages[0]?.jsonLd ?? "").url).toBe("https://docs.example.com/guide");
  });

  // AC-9.4 end to end.
  it("AC-9.4: hidden pages carry no payload", async () => {
    const site = await build({
      "index.md": "---\ntitle: Home\n---\n\n# Home\n",
      "secret.md": "---\ntitle: Secret\nhidden: true\n---\n\n# Secret\n",
    });
    expect(site.pages.find((p) => p.slug === "")?.jsonLd).not.toBeNull();
    expect(site.pages.find((p) => p.slug === "secret")?.jsonLd).toBeNull();
  });

  // AC-9.7 end to end.
  it("AC-9.7: emits the configured publisher", async () => {
    const site = await build(
      { "index.md": "---\ntitle: Home\n---\n\n# Home\n" },
      { publisher: { name: "Acme" } },
    );
    expect(JSON.parse(site.pages[0]?.jsonLd ?? "").publisher).toEqual({
      "@type": "Organization",
      name: "Acme",
    });
  });

  // AC-9.8 end to end.
  it("AC-9.8: two builds of the same input produce byte-identical payloads", async () => {
    const files = { "index.md": "---\ntitle: Home\ndescription: Hi\n---\n\n# Home\n" };
    const a = await build(files);
    const b = await build(files);
    expect(a.pages[0]?.jsonLd).toBe(b.pages[0]?.jsonLd);
  });
});
