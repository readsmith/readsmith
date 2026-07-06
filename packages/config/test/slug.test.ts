import { describe, expect, it } from "vitest";
import { slugFromPath, slugifySegment } from "../src/slug.js";

describe("slugFromPath", () => {
  it("maps a root index to the empty slug", () => {
    expect(slugFromPath("index.mdx")).toBe("");
    expect(slugFromPath("README.md")).toBe("");
  });

  it("maps a folder index to the folder slug", () => {
    expect(slugFromPath("guides/index.mdx")).toBe("guides");
  });

  it("keeps nested paths and drops the extension", () => {
    expect(slugFromPath("guides/authentication.mdx")).toBe("guides/authentication");
  });

  it("lowercases and hyphenates segments", () => {
    expect(slugFromPath("Getting Started.mdx")).toBe("getting-started");
  });
});

describe("slugifySegment", () => {
  it("collapses non-alphanumeric runs to single hyphens", () => {
    expect(slugifySegment("Hello, World!")).toBe("hello-world");
    expect(slugifySegment("  spaced  out  ")).toBe("spaced-out");
  });
});
