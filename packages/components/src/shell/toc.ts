import type { TocNode } from "@readsmith/mdx";
import { esc } from "./util.js";

/**
 * Render the on-this-page table of contents from the page's TOC. Flattened to a
 * single list with a depth attribute for indentation, which keeps the scroll-spy
 * marker and active tracking simple. Returns "" when the page has no headings.
 */
export function renderToc(toc: TocNode[], label = "On this page"): string {
  if (toc.length === 0) return "";
  return (
    `<aside class="rs-toc"><span class="rs-toc__label">${esc(label)}</span>` +
    `<nav class="rs-toc__list" aria-label="${esc(label)}">` +
    `<span class="rs-toc__marker" aria-hidden="true"></span>${tocLinks(toc)}</nav></aside>`
  );
}

function tocLinks(nodes: TocNode[]): string {
  return nodes
    .map(
      (node) =>
        `<a class="rs-toc__link" data-depth="${node.depth}" href="#${esc(node.anchor)}">${esc(
          node.text,
        )}</a>${node.children.length > 0 ? tocLinks(node.children) : ""}`,
    )
    .join("");
}
