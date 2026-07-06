import type { ElementContent } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, slugify, str } from "./util.js";

/**
 * A dated changelog entry. `<Update label="2026-07-06" title="Release">body</Update>`.
 * The date is stamped in mono in the gauge margin; the entry carries an id so it
 * is deep-linkable. Feeding the TOC (P4) and the RSS feed (P7) from these entries
 * is a later integration; the visual component is here now.
 */
export function update({ props, children }: ComponentArgs): ElementContent {
  const label = str(props.label);
  const title = str(props.title);

  const meta: ElementContent[] = [];
  if (label) {
    meta.push(h("span", { className: ["rs-update__date"] }, [{ type: "text", value: label }]));
  }

  const body: ElementContent[] = [];
  if (title) {
    body.push(
      h("h3", { className: ["rs-update__title"], id: slugify(title) }, [
        { type: "text", value: title },
      ]),
    );
  }
  body.push(...children);

  return h("section", { className: ["rs-update"] }, [
    h("div", { className: ["rs-update__meta"] }, meta),
    h("div", { className: ["rs-update__body"] }, body),
  ]);
}
