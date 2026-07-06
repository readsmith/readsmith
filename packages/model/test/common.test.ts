import { describe, expect, it } from "vitest";
import { diagnosticSchema, positionSchema } from "../src/common.js";

describe("common schemas", () => {
  it("accepts a valid diagnostic", () => {
    const d = {
      severity: "error",
      code: "mdx-parse",
      message: "Unclosed tag",
      pos: { line: 3, col: 5 },
      source: "index.mdx",
    };
    expect(diagnosticSchema.parse(d)).toEqual(d);
  });

  it("rejects an invalid severity", () => {
    const r = diagnosticSchema.safeParse({
      severity: "fatal",
      code: "x",
      message: "m",
      source: "s",
    });
    expect(r.success).toBe(false);
  });

  it("requires non-negative integer positions", () => {
    expect(positionSchema.safeParse({ line: -1, col: 0 }).success).toBe(false);
    expect(positionSchema.safeParse({ line: 1.5, col: 0 }).success).toBe(false);
    expect(positionSchema.safeParse({ line: 1, col: 0 }).success).toBe(true);
  });
});
