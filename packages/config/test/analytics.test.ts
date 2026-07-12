import { describe, expect, it } from "vitest";
import { analyticsCspSources, analyticsHeadHtml } from "../src/analytics.js";

const FULL = {
  ga4: { measurementId: "G-ABC123" },
  posthog: { apiKey: "phc_key_1", host: "https://ph.example.com" },
  plausible: { domain: "docs.example.com" },
  fathom: { siteId: "ABCDEF" },
};

describe("analyticsHeadHtml", () => {
  it("emits every configured provider in a stable order, escaped", () => {
    const html = analyticsHeadHtml(FULL) ?? "";
    expect(html).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    expect(html).toContain("gtag('config','G-ABC123')");
    expect(html).toContain('src="https://ph.example.com/static/array.js"');
    expect(html).toContain("posthog.init('phc_key_1'");
    expect(html).toContain('data-domain="docs.example.com"');
    expect(html).toContain('data-site="ABCDEF"');
    // Deterministic: same input, same string.
    expect(analyticsHeadHtml(FULL)).toBe(html);
    // Fixed provider order: ga4 before posthog before plausible before fathom.
    expect(html.indexOf("gtag")).toBeLessThan(html.indexOf("posthog"));
    expect(html.indexOf("posthog")).toBeLessThan(html.indexOf("plausible.io") + 1);
  });

  it("returns undefined when nothing is configured (the bundle omits the field)", () => {
    expect(analyticsHeadHtml(undefined)).toBeUndefined();
    expect(analyticsHeadHtml({})).toBeUndefined();
  });

  it("attribute-escapes interpolations even though the schema constrains them", () => {
    const html = analyticsHeadHtml({
      posthog: { apiKey: "k", host: 'https://ph.example.com/"onload="x' },
    });
    expect(html).not.toContain('"onload="x');
    expect(html).toContain("&quot;");
  });
});

describe("analyticsCspSources", () => {
  it("derives each provider's script and connect sources", () => {
    const csp = analyticsCspSources(FULL);
    expect(csp.scriptSrc).toContain("https://www.googletagmanager.com");
    expect(csp.scriptSrc).toContain("https://ph.example.com");
    expect(csp.scriptSrc).toContain("https://plausible.io");
    expect(csp.scriptSrc).toContain("https://cdn.usefathom.com");
    expect(csp.connectSrc).toContain("https://*.google-analytics.com");
    expect(csp.connectSrc).toContain("https://ph.example.com");
  });

  it("is empty with no analytics", () => {
    expect(analyticsCspSources(undefined)).toEqual({ scriptSrc: [], connectSrc: [] });
  });
});
