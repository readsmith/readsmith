import { describe, expect, it } from "vitest";
import { contentHash, stableStringify } from "../src/serialize.js";

// Model spec AC-1 (round-trip with stable key order) and AC-7 (stable hash).
describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces identical output regardless of key insertion order", () => {
    const a = { z: 1, a: { y: 2, x: 3 }, m: [3, 2, 1] };
    const b = { m: [3, 2, 1], a: { x: 3, y: 2 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (order is meaningful)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined values", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("contentHash", () => {
  it("is stable across key order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("differs when content differs", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
