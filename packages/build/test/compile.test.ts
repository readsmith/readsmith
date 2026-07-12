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
