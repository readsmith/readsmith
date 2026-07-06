import type { FinalNavNode } from "@readsmith/mdx";
import { esc } from "./util.js";

/**
 * Render the left navigation from the finalized nav tree. Groups become
 * collapsible sections with a stamped label; pages become links, the current
 * page marked with `is-active` and `aria-current`. Keyboard-navigable by
 * default (links and native disclosure).
 */
export function renderNav(nav: FinalNavNode[], currentSlug: string): string {
  return `<nav class="rs-nav" aria-label="Documentation navigation">${navItems(nav, currentSlug)}</nav>`;
}

function navItems(nodes: FinalNavNode[], current: string): string {
  return nodes
    .map((node) => {
      if (node.type === "page") {
        const active = node.slug === current;
        return `<a class="rs-nav__link${active ? " is-active" : ""}" href="${esc(node.url)}"${
          active ? ' aria-current="page"' : ""
        }>${esc(node.title)}</a>`;
      }
      const open = containsSlug(node.children, current);
      return `<details class="rs-nav__group"${open ? " open" : ""}><summary class="rs-nav__label">${esc(
        node.label,
      )}</summary><div class="rs-nav__children">${navItems(node.children, current)}</div></details>`;
    })
    .join("");
}

function containsSlug(nodes: FinalNavNode[], slug: string): boolean {
  return nodes.some((node) =>
    node.type === "page" ? node.slug === slug : containsSlug(node.children, slug),
  );
}
