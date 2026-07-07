import { describe, expect, it } from "vitest";
import { StorageConfigError, createBundleStore, resolveStorageConfig } from "../src/index.js";

describe("storage config resolution", () => {
  it("defaults to the local driver and the provided default root", () => {
    expect(resolveStorageConfig({}, "/tmp/default-root")).toEqual({
      driver: "local",
      root: "/tmp/default-root",
    });
  });

  it("honors STORAGE_ROOT over the default", () => {
    const cfg = resolveStorageConfig({ STORAGE_ROOT: "/data/store" }, "/tmp/default-root");
    expect(cfg).toEqual({ driver: "local", root: "/data/store" });
  });

  it("fails fast on an unknown driver, naming the allowed values", () => {
    let message = "";
    try {
      resolveStorageConfig({ STORAGE_DRIVER: "s3" }, "/tmp/r");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("s3");
    expect(message).toContain("local");
  });

  it("constructs a working local store from resolved config", () => {
    const store = createBundleStore(resolveStorageConfig({}, "/tmp/r"));
    expect(typeof store.get).toBe("function");
    expect(typeof store.put).toBe("function");
    expect(typeof store.list).toBe("function");
  });
});
