import { afterEach, describe, expect, it } from "vitest";
import { configureAfterPublish, getAfterPublishHook } from "../src/site.js";

describe("configureAfterPublish seam (AC-E1/E2)", () => {
  afterEach(() => configureAfterPublish(null));

  it("defaults to no hook (self-host is byte-identical)", () => {
    expect(getAfterPublishHook()).toBeNull();
  });

  it("registers and returns the hook", () => {
    const hook = async () => {};
    configureAfterPublish(hook);
    expect(getAfterPublishHook()).toBe(hook);
  });

  it("clears the hook when passed null", () => {
    configureAfterPublish(async () => {});
    configureAfterPublish(null);
    expect(getAfterPublishHook()).toBeNull();
  });
});
