import type { PageModel, SiteBuild } from "@readsmith/mdx";
import type { SiteVersions } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { resolveVersionRequest, versionSwitchTarget } from "../src/versioning.js";

const versions: SiteVersions = {
  default: "v2",
  list: [
    { id: "v2", prefix: "", isDefault: true, label: "v2 (latest)", tag: "latest", hidden: false },
    { id: "v1", prefix: "/v1", isDefault: false, label: "v1", hidden: false },
  ],
};

/** A build exposing only the page slugs/hidden flags versionSwitchTarget reads. */
const buildWith = (pages: { slug: string; hidden?: boolean }[]): SiteBuild =>
  ({ pages: pages as unknown as PageModel[] }) as unknown as SiteBuild;

describe("resolveVersionRequest", () => {
  it("AC-6: an un-prefixed path serves the default version", () => {
    expect(resolveVersionRequest(versions, "quickstart")).toEqual({
      versionId: "v2",
      slug: "quickstart",
    });
    expect(resolveVersionRequest(versions, "")).toEqual({ versionId: "v2", slug: "" });
  });

  it("AC-6: a non-default prefix selects that version and strips the segment", () => {
    expect(resolveVersionRequest(versions, "v1/quickstart")).toEqual({
      versionId: "v1",
      slug: "quickstart",
    });
    expect(resolveVersionRequest(versions, "v1")).toEqual({ versionId: "v1", slug: "" });
  });

  it("AC-15: the default version reached through its own prefix canonicalizes to the bare slug", () => {
    expect(resolveVersionRequest(versions, "v2/quickstart")).toEqual({
      versionId: "v2",
      slug: "quickstart",
      canonicalSlug: "quickstart",
    });
    expect(resolveVersionRequest(versions, "v2")).toEqual({
      versionId: "v2",
      slug: "",
      canonicalSlug: "",
    });
  });

  it("treats an unknown leading segment as an ordinary default-version slug", () => {
    expect(resolveVersionRequest(versions, "guides/intro")).toEqual({
      versionId: "v2",
      slug: "guides/intro",
    });
  });
});

describe("versionSwitchTarget (AC-7)", () => {
  const build = buildWith([{ slug: "" }, { slug: "quickstart" }, { slug: "secret", hidden: true }]);

  it("keeps the same page when it exists in the target version", () => {
    expect(versionSwitchTarget(build, "quickstart")).toBe("quickstart");
  });

  it("falls back to the version home when the page is absent, never a 404", () => {
    expect(versionSwitchTarget(build, "removed-in-this-version")).toBe("");
  });

  it("treats a hidden page as absent for switching", () => {
    expect(versionSwitchTarget(build, "secret")).toBe("");
  });
});
