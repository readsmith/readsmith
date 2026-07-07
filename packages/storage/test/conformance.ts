import { expect, it } from "vitest";
import { type BundleStore, StorageKeyError } from "../src/index.js";

/**
 * Reusable port conformance suite. Every BundleStore driver - the local FS
 * driver today, an S3-compatible driver later - must pass this identical
 * battery, so the abstraction stays honest across backends. `makeStore` returns
 * a fresh, empty store per invocation.
 */
export function runBundleStoreConformance(makeStore: () => Promise<BundleStore> | BundleStore) {
  it("round-trips string bytes", async () => {
    const store = await makeStore();
    await store.put("bundle.json", '{"a":1}');
    expect((await store.get("bundle.json"))?.toString("utf8")).toBe('{"a":1}');
  });

  it("round-trips binary bytes byte-for-byte", async () => {
    const store = await makeStore();
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    await store.put("blob.bin", bytes);
    const got = await store.get("blob.bin");
    expect(got && Uint8Array.from(got)).toEqual(bytes);
  });

  it("returns null for a missing key without throwing", async () => {
    const store = await makeStore();
    expect(await store.get("nope.json")).toBeNull();
  });

  it("reports presence with has()", async () => {
    const store = await makeStore();
    expect(await store.has("k")).toBe(false);
    await store.put("k", "v");
    expect(await store.has("k")).toBe(true);
  });

  it("overwrites an existing key", async () => {
    const store = await makeStore();
    await store.put("k", "first");
    await store.put("k", "second");
    expect((await store.get("k"))?.toString("utf8")).toBe("second");
  });

  it("lists keys under a prefix, sorted", async () => {
    const store = await makeStore();
    await store.put("pages/b.json", "1");
    await store.put("pages/a.json", "1");
    await store.put("bundle.json", "1");
    expect(await store.list()).toEqual(["bundle.json", "pages/a.json", "pages/b.json"]);
    expect(await store.list("pages/")).toEqual(["pages/a.json", "pages/b.json"]);
  });

  it("preserves a large payload byte-for-byte", async () => {
    const store = await makeStore();
    const big = JSON.stringify({ data: "x".repeat(2_000_000) });
    await store.put("bundle.json", big);
    expect((await store.get("bundle.json"))?.toString("utf8")).toBe(big);
  });

  it("rejects keys that escape the root, touching nothing", async () => {
    const store = await makeStore();
    for (const bad of ["../escape", "/etc/passwd", "a/../../b", ""]) {
      await expect(store.put(bad, "x")).rejects.toBeInstanceOf(StorageKeyError);
      await expect(store.get(bad)).rejects.toBeInstanceOf(StorageKeyError);
    }
    expect(await store.list()).toEqual([]);
  });
}
