import { join } from "node:path";
import { resolveConfig } from "@readsmith/config";
import { describe, expect, it } from "vitest";
import { collectAssets } from "../src/assets.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("collectAssets", () => {
  it("serves real assets and skips prose, config, and snippet sources", async () => {
    const dir = fixture("site");
    const { entries, missingMounts } = await collectAssets(dir, await resolveConfig(dir));
    expect(entries.map((e) => e.key)).toEqual(["logo.svg"]);
    expect(entries[0]?.source).toBe(join(dir, "logo.svg"));
    expect(missingMounts).toEqual([]);
  });

  it("keeps non-content files like the OpenAPI spec servable, but never docs.yaml", async () => {
    const dir = fixture("api-site");
    const { entries } = await collectAssets(dir, await resolveConfig(dir));
    expect(entries.map((e) => e.key)).toEqual(["openapi.json"]);
  });

  it("is deterministic across runs", async () => {
    const dir = fixture("site");
    const config = await resolveConfig(dir);
    const a = await collectAssets(dir, config);
    const b = await collectAssets(dir, config);
    expect(a).toEqual(b);
  });
});
