import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStore } from "../src/index.js";
import { runBundleStoreConformance } from "./conformance.js";

const roots: string[] = [];

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rs-storage-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("local BundleStore - port conformance", () => {
  runBundleStoreConformance(async () => createLocalStore(await freshRoot()));
});

describe("local BundleStore - filesystem specifics", () => {
  it("creates the root directory tree on first put", async () => {
    const root = join(await freshRoot(), "nested", "readsmith");
    const store = createLocalStore(root);
    await store.put("bundle.json", "{}");
    expect((await store.get("bundle.json"))?.toString("utf8")).toBe("{}");
  });

  it("leaves no temp files behind after an atomic put", async () => {
    const root = await freshRoot();
    await createLocalStore(root).put("bundle.json", "hello");
    expect(await readdir(root)).toEqual(["bundle.json"]);
  });

  it("does not surface temp files as keys", async () => {
    const root = await freshRoot();
    const store = createLocalStore(root);
    await store.put("a.json", "1");
    expect(await store.list()).toEqual(["a.json"]);
  });

  it("returns [] from list when the root does not exist yet", async () => {
    const store = createLocalStore(join(await freshRoot(), "missing"));
    expect(await store.list()).toEqual([]);
  });
});
