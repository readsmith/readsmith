import type { Element, ElementContent } from "hast";
import { fromHtml } from "hast-util-from-html";

/** Resolves an icon name to the inner SVG children (paths), or undefined if unknown. */
export type IconResolver = (name: string) => ElementContent[] | undefined;

/**
 * A pure icon resolver over a raw-SVG reader. The reader supplies the SVG string
 * for a name (fs/bundle access lives with the caller, out of this package, so
 * the component library stays edge-safe). This parses a Lucide-style SVG once
 * per name and returns the root `<svg>`'s element children (the shapes), or
 * `undefined` when the reader has none. Results are cached, so a repeated icon
 * is parsed once and identical input yields identical output (determinism).
 */
export function createLucideResolver(readSvg: (name: string) => string | undefined): IconResolver {
  const cache = new Map<string, ElementContent[] | undefined>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const svg = readSvg(name);
    let children: ElementContent[] | undefined;
    if (svg) {
      const tree = fromHtml(svg, { fragment: true, space: "svg" });
      const root = tree.children.find(
        (node): node is Element => node.type === "element" && node.tagName === "svg",
      );
      if (root) children = root.children.filter((node) => node.type === "element");
    }
    cache.set(name, children);
    return children;
  };
}
