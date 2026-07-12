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
      resolveStorageConfig({ STORAGE_DRIVER: "gcs" }, "/tmp/r");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("gcs");
    expect(message).toContain("local");
  });

  it("constructs a working local store from resolved config", () => {
    const store = createBundleStore(resolveStorageConfig({}, "/tmp/r"));
    expect(typeof store.get).toBe("function");
    expect(typeof store.put).toBe("function");
    expect(typeof store.list).toBe("function");
  });
});

describe("s3 config resolution", () => {
  const FULL = {
    STORAGE_DRIVER: "s3",
    STORAGE_ENDPOINT: "http://localhost:9000",
    STORAGE_BUCKET: "readsmith",
    STORAGE_ACCESS_KEY_ID: "ak",
    STORAGE_SECRET_ACCESS_KEY: "sk",
  };

  it("resolves a complete s3 env, defaulting the region to auto", () => {
    const config = resolveStorageConfig(FULL, "/tmp/r");
    expect(config).toEqual({
      driver: "s3",
      endpoint: "http://localhost:9000",
      bucket: "readsmith",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      region: "auto",
    });
    const regioned = resolveStorageConfig({ ...FULL, STORAGE_REGION: "us-east-1" }, "/tmp/r");
    expect(regioned.driver === "s3" && regioned.region).toBe("us-east-1");
  });

  it("fails fast naming every missing variable, echoing no values", () => {
    let message = "";
    try {
      resolveStorageConfig({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "readsmith" }, "/tmp/r");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("STORAGE_ENDPOINT");
    expect(message).toContain("STORAGE_ACCESS_KEY_ID");
    expect(message).toContain("STORAGE_SECRET_ACCESS_KEY");
    expect(message).not.toContain("readsmith"); // no values, ever
  });
});
