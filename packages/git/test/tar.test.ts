import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { TarError, extractTar } from "../src/tar.js";
import { asStream, makeTar } from "./tar-util.js";

const LIMITS = { maxEntries: 100, maxTotalBytes: 1024 * 1024 };

describe("extractTar", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), "rs-tar-"));
  });

  it("extracts files and directories, stripping the tarball root", async () => {
    const tar = makeTar([
      { name: "acme-docs-abc123/", type: "5" },
      { name: "acme-docs-abc123/index.md", content: "# Home\n" },
      { name: "acme-docs-abc123/guide/", type: "5" },
      { name: "acme-docs-abc123/guide/setup.md", content: "# Setup\n" },
    ]);
    const result = await extractTar(asStream(tar), dest, {
      stripComponents: 1,
      limits: LIMITS,
    });
    expect(result.files).toBe(2);
    expect(await readFile(join(dest, "index.md"), "utf8")).toBe("# Home\n");
    expect(await readFile(join(dest, "guide/setup.md"), "utf8")).toBe("# Setup\n");
  });

  it("honors pax path overrides (long paths) and skips the global header", async () => {
    const longName = `acme-docs-abc123/${"deep/".repeat(30)}page.md`;
    const tar = makeTar([
      { name: "pax_global_header", type: "g", content: "52 comment=abc\n" },
      { name: "acme-docs-abc123/truncated-name.md", paxPath: longName, content: "deep\n" },
    ]);
    await extractTar(asStream(tar), dest, { stripComponents: 1, limits: LIMITS });
    expect(await readFile(join(dest, `${"deep/".repeat(30)}page.md`), "utf8")).toBe("deep\n");
  });

  it("never materializes symlinks or other special entries", async () => {
    const tar = makeTar([
      { name: "root/evil-link", type: "2" }, // symlink
      { name: "root/fifo", type: "6" },
      { name: "root/ok.md", content: "fine\n" },
    ]);
    const result = await extractTar(asStream(tar), dest, {
      stripComponents: 1,
      limits: LIMITS,
    });
    expect(result.files).toBe(1);
    expect((await readdir(dest)).sort()).toEqual(["ok.md"]);
  });

  it("rejects traversal (tar-slip) without writing anything outside", async () => {
    const tar = makeTar([{ name: "root/../../evil.md", content: "boom" }]);
    await expect(
      extractTar(asStream(tar), dest, { stripComponents: 1, limits: LIMITS }),
    ).rejects.toBeInstanceOf(TarError);
    expect(existsSync(join(dest, "..", "evil.md"))).toBe(false);
  });

  it("enforces the entry and byte caps", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      name: `root/f${i}.md`,
      content: "x",
    }));
    await expect(
      extractTar(asStream(makeTar(many)), dest, {
        stripComponents: 1,
        limits: { maxEntries: 3, maxTotalBytes: 1024 },
      }),
    ).rejects.toThrow(/entry cap/);

    const big = makeTar([{ name: "root/big.md", content: "y".repeat(2048) }]);
    await expect(
      extractTar(asStream(big), dest, {
        stripComponents: 1,
        limits: { maxEntries: 100, maxTotalBytes: 1024 },
      }),
    ).rejects.toThrow(/size cap/);
  });

  it("extracts a real system-tar archive identically", async () => {
    // Cross-check the hand-rolled parser against a real producer.
    const src = await mkdtemp(join(tmpdir(), "rs-src-"));
    await writeFile(join(src, "index.md"), "# Real\n");
    await symlink("index.md", join(src, "link.md")); // must be skipped
    const out = join(await mkdtemp(join(tmpdir(), "rs-out-")), "repo.tar.gz");
    execFileSync("tar", ["czf", out, "-C", join(src, ".."), src.split("/").pop() ?? ""]);
    const gunzip = createGunzip();
    Readable.from(await readFile(out)).pipe(gunzip);
    const result = await extractTar(gunzip, dest, { stripComponents: 1, limits: LIMITS });
    expect(result.files).toBe(1);
    expect(await readFile(join(dest, "index.md"), "utf8")).toBe("# Real\n");
    expect((await readdir(dest)).sort()).toEqual(["index.md"]);
  });
});
