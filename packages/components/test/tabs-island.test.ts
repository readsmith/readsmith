// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { hydrate } from "../src/islands/index.js";

function tabsMarkup(group: string): string {
  return `
    <div data-island="Tabs" data-island-id="Tabs-x">
      <div class="rs-tabs" data-rs-group="${group}">
        <div class="rs-tabs__list" role="tablist">
          <button class="rs-tabs__tab" role="tab" aria-selected="true" tabindex="0">Python</button>
          <button class="rs-tabs__tab" role="tab" aria-selected="false" tabindex="-1">Node</button>
        </div>
        <div class="rs-tabs__panels">
          <div class="rs-tab" role="tabpanel" data-rs-tab-title="Python">py</div>
          <div class="rs-tab" role="tabpanel" data-rs-tab-title="Node" hidden>js</div>
        </div>
      </div>
    </div>`;
}

function tabsOf(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(".rs-tabs__tab")];
}
function panelsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".rs-tab")];
}

beforeEach(() => {
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe("Tabs island", () => {
  it("wires ARIA ids and switches panels on click", () => {
    document.body.innerHTML = tabsMarkup("keyboard-1");
    hydrate();
    const tabs = tabsOf(document.body);
    const panels = panelsOf(document.body);

    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panels[0]?.id);
    expect(panels[0]?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);

    tabs[1]?.click();
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(panels[0]?.hidden).toBe(true);
    expect(panels[1]?.hidden).toBe(false);
  });

  it("moves selection with the arrow keys (roving, wrapping)", () => {
    document.body.innerHTML = tabsMarkup("keyboard-2");
    hydrate();
    const tabs = tabsOf(document.body);

    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.tabIndex).toBe(0);
    expect(tabs[0]?.tabIndex).toBe(-1);

    tabs[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("syncs selection page-wide across groups with the same name", () => {
    document.body.innerHTML = tabsMarkup("sync-lang") + tabsMarkup("sync-lang");
    hydrate();
    const groups = [...document.querySelectorAll<HTMLElement>(".rs-tabs")];
    const first = groups[0] as HTMLElement;
    const second = groups[1] as HTMLElement;

    tabsOf(first)[1]?.click(); // pick "Node" in the first group

    expect(tabsOf(second)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(panelsOf(second)[1]?.hidden).toBe(false);
    expect(panelsOf(second)[0]?.hidden).toBe(true);
  });
});
