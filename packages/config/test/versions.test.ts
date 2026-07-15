import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/resolve.js";

/** A repo with the given docs.yaml body and a docs/ content root holding one page. */
async function repo(yamlBody: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rs-versions-"));
  await writeFile(join(dir, "docs.yaml"), yamlBody);
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "index.md"), "# Home\n\nHi.\n");
  return dir;
}

describe("resolveConfig versions", () => {
  it("resolves prefixes, labels, and content dirs; default is un-prefixed", async () => {
    const dir = await repo(
      [
        "site:",
        "  name: Versioned",
        "content:",
        "  root: docs",
        "versions:",
        "  default: v2",
        "  list:",
        "    - id: v2",
        '      label: "v2 (latest)"',
        "      tag: latest",
        "    - id: v1",
        "      content: versions/v1",
      ].join("\n"),
    );
    const { versions } = await resolveConfig(dir);
    expect(versions?.default).toBe("v2");
    expect(versions?.list).toEqual([
      {
        id: "v2",
        label: "v2 (latest)",
        content: "docs",
        prefix: "",
        isDefault: true,
        tag: "latest",
        hidden: false,
      },
      {
        id: "v1",
        label: "v1", // defaults to the id
        content: "versions/v1",
        prefix: "/v1", // non-default carries a segment
        isDefault: false,
        hidden: false,
      },
    ]);
  });

  it("is absent on a single-version site (no versions block)", async () => {
    const dir = await repo("site:\n  name: Plain\ncontent:\n  root: docs\n");
    const { versions } = await resolveConfig(dir);
    expect(versions).toBeUndefined();
  });

  it("errors when the default is not in the list", async () => {
    const dir = await repo("site:\n  name: X\nversions:\n  default: v9\n  list:\n    - id: v1\n");
    const { diagnostics } = await resolveConfig(dir);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "versions-default", severity: "error" }),
    );
  });

  it("errors on a duplicate version id", async () => {
    const dir = await repo(
      "site:\n  name: X\nversions:\n  default: v1\n  list:\n    - id: v1\n    - id: v1\n",
    );
    const { diagnostics } = await resolveConfig(dir);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "versions-duplicate", severity: "error" }),
    );
  });
});
