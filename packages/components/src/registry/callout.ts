import type { Props } from "@readsmith/mdx";
import type { ElementContent } from "hast";
import { h } from "hastscript";
import { calloutIcon } from "./icons.js";

const KINDS = new Set(["note", "info", "tip", "warning", "danger", "check"]);

export interface ComponentArgs {
  name: string;
  props: Props;
  children: ElementContent[];
}

/**
 * A callout / admonition. `<Callout type="warning" title="...">body</Callout>`,
 * or the shorthands Note / Info / Tip / Warning / Danger / Check. Renders a
 * tinted panel with a semantic left rule, an icon, an optional title, and the
 * authored body. Kind falls back to "note" for an unknown type.
 */
export function callout({ props, children }: ComponentArgs): ElementContent {
  const type = typeof props.type === "string" ? props.type : "note";
  const kind = KINDS.has(type) ? type : "note";
  const title = typeof props.title === "string" && props.title.trim() ? props.title : undefined;

  const body: ElementContent[] = [];
  if (title) {
    body.push(h("p", { className: ["rs-callout__title"] }, [{ type: "text", value: title }]));
  }
  body.push(...children);

  return h("aside", { className: ["rs-callout", `rs-callout--${kind}`], role: "note" }, [
    calloutIcon(kind),
    h("div", { className: ["rs-callout__body"] }, body),
  ]);
}

/** Build a callout render bound to a fixed kind (for the Note/Warning shorthands). */
export function calloutOfKind(kind: string) {
  return (args: ComponentArgs): ElementContent =>
    callout({ ...args, props: { ...args.props, type: kind } });
}
