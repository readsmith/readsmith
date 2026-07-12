import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSite } from "../src/compile.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("compileSite", () => {
  it("is deterministic: same content, byte-identical bundle and hash", async () => {
    const a = await compileSite({ contentDir: fixture("site") });
    const b = await compileSite({ contentDir: fixture("site") });
    expect(a.bundleJson).toBe(b.bundleJson);
    expect(a.bundleHash).toBe(b.bundleHash);
  });

  it("compiles pages with snippets expanded into the bundle", async () => {
    const { bundle, bundleJson } = await compileSite({ contentDir: fixture("site") });
    expect(bundle.site.build.pages.length).toBe(2);
    expect(bundleJson).toContain("A shared note that must appear on every dependent page.");
    expect(typeof bundle.site.themeCss).toBe("string");
    expect(bundle.apiReference).toBeNull();
  });

  it("serializes exactly the returned bundle object", async () => {
    const { bundle, bundleJson } = await compileSite({ contentDir: fixture("site") });
    expect(JSON.parse(bundleJson)).toEqual(JSON.parse(JSON.stringify(bundle)));
  });

  it("ingests a configured API spec and bakes the default siteId", async () => {
    const { bundle, apiReferenceDiagnostics } = await compileSite({
      contentDir: fixture("api-site"),
    });
    expect(bundle.apiReference).not.toBeNull();
    expect(bundle.apiReference?.spec.siteId).toBe("default");
    expect(bundle.apiReference?.spec.operations.map((op) => op.method)).toEqual(["get"]);
    expect(bundle.site.name).toBe("Petstore Docs");
    expect(apiReferenceDiagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("threads an explicit siteId into the bundle (a compile input, not a constant)", async () => {
    const acme = await compileSite({ contentDir: fixture("api-site"), siteId: "acme" });
    const dflt = await compileSite({ contentDir: fixture("api-site") });
    expect(acme.bundle.apiReference?.spec.siteId).toBe("acme");
    expect(acme.bundleHash).not.toBe(dflt.bundleHash);
  });

  it("survives an unreadable spec: pages build, reference is null, diagnostic says why", async () => {
    const { bundle, apiReferenceDiagnostics } = await compileSite({
      contentDir: fixture("broken-api"),
    });
    expect(bundle.apiReference).toBeNull();
    expect(bundle.site.build.pages.length).toBe(1);
    expect(apiReferenceDiagnostics).toEqual([
      expect.objectContaining({ code: "api-spec-read", severity: "warning" }),
    ]);
  });
});

describe("compileSite failOnError", () => {
  it("builds resiliently by default: diagnostics ride along, ok stays true", async () => {
    const { bundle } = await compileSite({ contentDir: fixture("broken-page") });
    expect(bundle.site.build.ok).toBe(true);
    expect(bundle.site.build.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("strict mode marks the build not-ok so callers refuse to publish it", async () => {
    const { bundle } = await compileSite({
      contentDir: fixture("broken-page"),
      failOnError: true,
    });
    expect(bundle.site.build.ok).toBe(false);
  });
});

describe("compileSite analytics injection", () => {
  it("bakes configured provider tags into the envelope with their CSP sources", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "rs-an-")), "site");
    await mkdir(dir);
    await cp(fixture("site"), dir, { recursive: true });
    await writeFile(
      join(dir, "docs.yaml"),
      "site:\n  name: site\nanalytics:\n  ga4:\n    measurementId: G-TEST42\n",
    );
    const { bundle, config } = await compileSite({ contentDir: dir });
    expect(bundle.site.analyticsHtml).toContain("G-TEST42");
    expect(config.security.csp.scriptSrc).toContain("https://www.googletagmanager.com");
  });

  it("omits the field entirely when no analytics is configured", async () => {
    const { bundle, bundleJson } = await compileSite({ contentDir: fixture("site") });
    expect(bundle.site.analyticsHtml).toBeUndefined();
    expect(bundleJson).not.toContain("analyticsHtml");
  });
});

describe("siteUrl override", () => {
  it("serves the site at the host-assigned URL instead of the config's own", async () => {
    const dir = fixture("site");
    const own = await compileSite({ contentDir: dir });
    const overridden = await compileSite({
      contentDir: dir,
      siteUrl: "https://acme.readsmith.app",
    });
    expect(overridden.bundle.site.url).toBe("https://acme.readsmith.app");
    expect(overridden.bundle.site.url).not.toBe(own.bundle.site.url);
    // Different served URL = different artifact, deterministically.
    expect(overridden.bundleHash).not.toBe(own.bundleHash);
    const again = await compileSite({ contentDir: dir, siteUrl: "https://acme.readsmith.app" });
    expect(again.bundleHash).toBe(overridden.bundleHash);
  });
});

describe("asset manifest", () => {
  async function siteWithAssets(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rs-assets-"));
    await cp(fixture("site"), dir, { recursive: true });
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(
      join(dir, "images", "logo.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>`,
    );
    return dir;
  }

  it("omits the manifest entirely for a site with no assets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rs-noassets-"));
    await writeFile(join(dir, "index.md"), "# Bare\n\nProse only.\n");
    const { bundle, assetFiles } = await compileSite({ contentDir: dir });
    expect(bundle.site.assets).toBeUndefined();
    expect(assetFiles).toEqual([]);
  });

  it("maps serving paths to content-addressed keys, deterministically", async () => {
    const dir = await siteWithAssets();
    const a = await compileSite({ contentDir: dir });
    const b = await compileSite({ contentDir: dir });
    expect(a.bundleJson).toBe(b.bundleJson);
    const ref = a.bundle.site.assets?.["/images/logo.svg"];
    expect(ref).toBeDefined();
    expect(ref?.key).toMatch(/^assets\/[0-9a-f]{64}$/);
    expect(ref?.contentType).toBe("image/svg+xml");
    expect(ref?.bytes).toBeGreaterThan(0);
    // The returned files back exactly the manifest's keys.
    expect(a.assetFiles.map((f) => f.key)).toContain(ref?.key);
  });

  it("prose and config never appear as served assets", async () => {
    const dir = await siteWithAssets();
    const { bundle } = await compileSite({ contentDir: dir });
    const paths = Object.keys(bundle.site.assets ?? {}).sort();
    // The fixture's own logo.svg plus the added image; never .md or docs.yaml.
    expect(paths).toEqual(["/images/logo.svg", "/logo.svg"]);
  });
});
