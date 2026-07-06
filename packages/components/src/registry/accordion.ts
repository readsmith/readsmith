import type { ElementContent, Properties } from "hast";
import { h, s } from "hastscript";
import { type ComponentArgs, collect, hasClass, str } from "./util.js";

/**
 * Progressive disclosure built on the native <details>/<summary>, so it is
 * keyboard-operable and screen-reader-correct with zero JavaScript. An optional
 * enhancer adds smooth height animation later; the component works without it.
 * `<Accordion title="..." open>body</Accordion>`.
 */
export function accordion({ props, children }: ComponentArgs): ElementContent {
  const title = str(props.title, "Details");
  const open = props.open === true || props.open === "true";
  const attrs: Properties = { className: ["rs-accordion"] };
  if (open) attrs.open = true;

  return h("details", attrs, [
    h("summary", { className: ["rs-accordion__summary"] }, [
      chevron(),
      h("span", {}, [{ type: "text", value: title }]),
    ]),
    h("div", { className: ["rs-accordion__body"] }, children),
  ]);
}

export function accordionGroup({ children }: ComponentArgs): ElementContent {
  const items = collect(children, (el) => hasClass(el, "rs-accordion"));
  return h("div", { className: ["rs-accordions"] }, items);
}

function chevron() {
  return s(
    "svg",
    {
      className: ["rs-accordion__chevron"],
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
