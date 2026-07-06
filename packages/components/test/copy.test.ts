// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCopyButtons } from "../src/islands/copy.js";

function makeCodeBlock(withBar: boolean): HTMLElement {
  const bar = withBar ? '<figcaption class="rs-code__bar"></figcaption>' : "";
  document.body.innerHTML = `<figure class="rs-code">${bar}<pre class="shiki"><code>const x = 1;</code></pre></figure>`;
  return document.querySelector(".rs-code") as HTMLElement;
}

describe("mountCopyButtons", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects a floating copy button and copies the code on click", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const figure = makeCodeBlock(false);
    mountCopyButtons();
    const button = figure.querySelector(".rs-code__copy") as HTMLButtonElement;

    expect(button).toBeTruthy();
    expect(button.classList.contains("rs-code__copy--float")).toBe(true);

    button.click();
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
    expect(button.textContent).toBe("Copied");

    vi.advanceTimersByTime(1600);
    expect(button.textContent).toBe("Copy");
  });

  it("places the button inside the title bar when one is present", () => {
    const figure = makeCodeBlock(true);
    mountCopyButtons();
    const bar = figure.querySelector(".rs-code__bar") as HTMLElement;
    expect(bar.querySelector(".rs-code__copy")).toBeTruthy();
  });

  it("does not inject a second button when run twice", () => {
    makeCodeBlock(false);
    mountCopyButtons();
    mountCopyButtons();
    expect(document.querySelectorAll(".rs-code__copy").length).toBe(1);
  });
});
