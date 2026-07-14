import type { Element } from "hast";
import { describe, expect, it, vi } from "vitest";
import { createLucideResolver } from "../src/lucide/resolve.js";
import { makeIcon } from "../src/registry/icon.js";
import { createRegistry } from "../src/registry/index.js";

const ROCKET_SVG = `<!-- @license lucide-static v1 - ISC -->
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5" />
  <path d="M9 12H4s.55-3.03 2-4" />
</svg>`;

function classes(el: Element): string[] {
  return (el.properties?.className as string[]) ?? [];
}
function render(
  props: Record<string, unknown>,
  resolver?: ReturnType<typeof createLucideResolver>,
) {
  return makeIcon(resolver)({ name: "Icon", props, children: [] }) as Element;
}

describe("createLucideResolver", () => {
  it("returns the inner element children for a known name, dropping the comment/text", () => {
    const resolve = createLucideResolver((n) => (n === "rocket" ? ROCKET_SVG : undefined));
    const children = resolve("rocket");
    expect(children).toBeDefined();
    expect(children).toHaveLength(2); // two <path>, no comment/whitespace-text nodes
    expect((children?.[0] as Element).tagName).toBe("path");
  });

  it("returns undefined for an unknown name", () => {
    const resolve = createLucideResolver(() => undefined);
    expect(resolve("nope")).toBeUndefined();
  });

  it("parses each name only once (caches, incl. the undefined miss)", () => {
    const reader = vi.fn((n: string) => (n === "rocket" ? ROCKET_SVG : undefined));
    const resolve = createLucideResolver(reader);
    resolve("rocket");
    resolve("rocket");
    resolve("ghost");
    resolve("ghost");
    expect(reader).toHaveBeenCalledTimes(2); // one per distinct name
  });
});

describe("Icon component", () => {
  const resolver = createLucideResolver((n) => (n === "rocket" ? ROCKET_SVG : undefined));

  it("renders an <svg class=rs-icon> with the resolved children, default size 16, decorative", () => {
    const el = render({ icon: "rocket" }, resolver);
    expect(el.tagName).toBe("svg");
    expect(classes(el)).toContain("rs-icon");
    expect(el.properties?.width).toBe(16);
    expect(el.properties?.height).toBe(16);
    expect(el.properties?.ariaHidden).toBe("true"); // hast key; serializes to aria-hidden
    expect(el.properties?.role).toBeUndefined();
    expect((el.children[0] as Element).tagName).toBe("path");
  });

  it("honors numeric and string size, and appends a custom className", () => {
    expect(render({ icon: "rocket", size: 28 }, resolver).properties?.width).toBe(28);
    expect(render({ icon: "rocket", size: "20" }, resolver).properties?.width).toBe(20);
    expect(classes(render({ icon: "rocket", className: "hero" }, resolver))).toEqual([
      "rs-icon",
      "hero",
    ]);
  });

  it("applies a valid hex color inline and drops a non-hex color", () => {
    expect(render({ icon: "rocket", color: "#0f8b7e" }, resolver).properties?.style).toBe(
      "color:#0f8b7e",
    );
    expect(render({ icon: "rocket", color: "red; content:x" }, resolver).properties?.style).toBe(
      undefined,
    );
  });

  it("becomes an announced role=img when a label is given", () => {
    const el = render({ icon: "rocket", label: "Launch" }, resolver);
    expect(el.properties?.role).toBe("img");
    expect(el.properties?.ariaLabel).toBe("Launch");
    expect(el.properties?.ariaHidden).toBeUndefined();
  });

  it("degrades an unknown name to a fallback glyph carrying data-rs-icon-missing", () => {
    const el = render({ icon: "does-not-exist" }, resolver);
    expect(el.tagName).toBe("svg");
    expect(classes(el)).toContain("rs-icon--missing");
    expect(el.properties?.dataRsIconMissing).toBe("does-not-exist"); // serializes to data-rs-icon-missing
    expect((el.children[0] as Element).tagName).toBe("rect");
  });

  it("renders an external URL icon as an <img>", () => {
    const el = render({ icon: "https://cdn.example/x.svg", label: "External", size: 24 }, resolver);
    expect(el.tagName).toBe("img");
    expect(el.properties?.src).toBe("https://cdn.example/x.svg");
    expect(el.properties?.width).toBe(24);
    expect(el.properties?.alt).toBe("External");
  });

  it("is deterministic: same name yields identical hast", () => {
    expect(render({ icon: "rocket" }, resolver)).toEqual(render({ icon: "rocket" }, resolver));
  });
});

describe("createRegistry wiring", () => {
  it("registers Icon and uses the injected resolver", () => {
    const registry = createRegistry({
      resolveIcon: createLucideResolver((n) => (n === "rocket" ? ROCKET_SVG : undefined)),
    });
    expect(typeof registry.Icon?.render).toBe("function");
    const el = registry.Icon?.render?.({
      name: "Icon",
      props: { icon: "rocket" },
      children: [],
    }) as Element;
    expect(el.tagName).toBe("svg");
    expect((el.children[0] as Element).tagName).toBe("path");
  });

  it("degrades gracefully when no resolver is configured", () => {
    const registry = createRegistry();
    const el = registry.Icon?.render?.({
      name: "Icon",
      props: { icon: "rocket" },
      children: [],
    }) as Element;
    expect(classes(el)).toContain("rs-icon--missing");
  });
});
