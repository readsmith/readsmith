import type { Props } from "@readsmith/mdx";
import type { Element, ElementContent } from "hast";

/** The arguments every registry component render receives from the P6 pipeline. */
export interface ComponentArgs {
  name: string;
  props: Props;
  children: ElementContent[];
}

export function isElement(node: ElementContent): node is Element {
  return node.type === "element";
}

/** The element children of a component, dropping whitespace text nodes. */
export function elementChildren(children: ElementContent[]): Element[] {
  return children.filter(isElement);
}

/**
 * Collect a container's matching child elements, unwrapping paragraphs. MDX
 * parses adjacent components without blank lines between them as inline elements
 * inside a paragraph, so a `<CardGroup>` can arrive as one `<p>` of cards rather
 * than the cards directly. Descending through paragraphs makes the containers
 * forgiving of that common authoring style.
 */
export function collect(children: ElementContent[], match: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const consider = (el: Element): void => {
    if (match(el)) {
      out.push(el);
      return;
    }
    if (el.tagName === "p") {
      for (const inner of el.children) {
        if (inner.type === "element") consider(inner);
      }
    }
  };
  for (const child of children) {
    if (child.type === "element") consider(child);
  }
  return out;
}

export function classList(el: Element): string[] {
  const c = el.properties?.className;
  return Array.isArray(c) ? (c as string[]) : [];
}

export function hasClass(el: Element, cls: string): boolean {
  return classList(el).includes(cls);
}

/** Flatten the text of a hast subtree (for reading a label out of rendered children). */
export function textContent(node: ElementContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textContent).join("");
  return "";
}

/** Find the first descendant (or self) element carrying a class. */
export function findByClass(node: ElementContent, cls: string): Element | undefined {
  if (node.type !== "element") return undefined;
  if (hasClass(node, cls)) return node;
  for (const child of node.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A simple anchor slug for in-page component anchors (changelog entries). */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
