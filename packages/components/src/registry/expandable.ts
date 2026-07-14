import type { ElementContent, Properties } from "hast";
import { h, s } from "hastscript";
import { type ComponentArgs, str } from "./util.js";

/**
 * A lightweight progressive-disclosure block on the native <details>/<summary>,
 * so it is keyboard-operable and screen-reader-correct with zero JavaScript.
 * Distinct from Accordion: no card surface, just a hairline left rule and a
 * chevron, tuned for nesting details (e.g. the sub-fields of an API parameter)
 * inline in prose. `<Expandable title="properties" defaultOpen>body</Expandable>`.
 */
export function expandable({ props, children }: ComponentArgs): ElementContent {
  const title = str(props.title, "Show more");
  const open =
    props.defaultOpen === true ||
    props.defaultOpen === "true" ||
    props.open === true ||
    props.open === "true";
  const attrs: Properties = { className: ["rs-expandable"] };
  if (open) attrs.open = true;

  return h("details", attrs, [
    h("summary", { className: ["rs-expandable__summary"] }, [
      chevron(),
      h("span", { className: ["rs-expandable__title"] }, [{ type: "text", value: title }]),
    ]),
    h("div", { className: ["rs-expandable__body"] }, children),
  ]);
}

function chevron() {
  return s(
    "svg",
    {
      className: ["rs-expandable__chevron"],
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    [s("path", { d: "M9 6l6 6-6 6" })],
  );
}
