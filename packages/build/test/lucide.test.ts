import { describe, expect, it } from "vitest";
import { readLucideSvg } from "../src/lucide.js";

describe("readLucideSvg", () => {
  it("reads a real Lucide icon's raw SVG by kebab name", () => {
    const svg = readLucideSvg("rocket");
    expect(svg).toBeDefined();
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).toContain('stroke="currentColor"');
  });

  it("returns undefined for a nonexistent icon", () => {
    expect(readLucideSvg("definitely-not-an-icon-xyz")).toBeUndefined();
  });

  it("rejects unsafe names (path traversal / uppercase / dots)", () => {
    expect(readLucideSvg("../package")).toBeUndefined();
    expect(readLucideSvg("a/b")).toBeUndefined();
    expect(readLucideSvg("Rocket")).toBeUndefined();
    expect(readLucideSvg("rocket.svg")).toBeUndefined();
  });
});
