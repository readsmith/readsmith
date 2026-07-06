import type { Element } from "hast";
import { describe, expect, it } from "vitest";
import { callout, createRegistry } from "../src/registry/index.js";

function txt(value: string): { type: "text"; value: string } {
  return { type: "text", value };
}

function classes(el: Element): string[] {
  return (el.properties?.className as string[]) ?? [];
}

describe("callout", () => {
  it("renders a semantic callout with kind class, icon, and body", () => {
    const el = callout({
      name: "Callout",
      props: { type: "warning", title: "Heads up" },
      children: [txt("Careful.")],
    }) as Element;

    expect(el.tagName).toBe("aside");
    expect(classes(el)).toContain("rs-callout");
    expect(classes(el)).toContain("rs-callout--warning");
    expect(el.properties?.role).toBe("note");

    const icon = el.children[0] as Element;
    const body = el.children[1] as Element;
    expect(icon.tagName).toBe("svg");
    expect(classes(body)).toContain("rs-callout__body");
    expect(classes(body.children[0] as Element)).toContain("rs-callout__title");
  });

  it("falls back to note for an unknown type", () => {
    const el = callout({ name: "Callout", props: { type: "bogus" }, children: [] }) as Element;
    expect(classes(el)).toContain("rs-callout--note");
  });

  it("omits the title paragraph when no title is given", () => {
    const el = callout({ name: "Callout", props: {}, children: [txt("body")] }) as Element;
    const body = el.children[1] as Element;
    expect((body.children[0] as { type: string }).type).toBe("text");
  });
});

describe("createRegistry", () => {
  it("exposes Callout and the shorthand kinds", () => {
    const registry = createRegistry();
    for (const name of ["Callout", "Note", "Info", "Tip", "Warning", "Danger", "Check"]) {
      expect(typeof registry[name]?.render).toBe("function");
    }
  });

  it("binds a shorthand component to its kind", () => {
    const registry = createRegistry();
    const el = registry.Warning?.render?.({
      name: "Warning",
      props: {},
      children: [],
    }) as Element;
    expect(classes(el)).toContain("rs-callout--warning");
  });
});
