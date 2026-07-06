import type { ElementContent } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, str } from "./util.js";

/** A keyboard key. `<Kbd>Ctrl</Kbd>`, rendered as a stamped key. */
export function kbd({ children }: ComponentArgs): ElementContent {
  return h("kbd", { className: ["rs-kbd"] }, children);
}

/** A small status pill. `<Badge variant="new">Beta</Badge>`. */
export function badge({ props, children }: ComponentArgs): ElementContent {
  const variant = str(props.variant);
  const classes = ["rs-badge"];
  if (variant) classes.push(`rs-badge--${variant}`);
  return h("span", { className: classes }, children);
}

/**
 * An inline tooltip. `<Tooltip tip="...">term</Tooltip>`. The trigger is
 * focusable and carries the tip as its accessible name; the visual bubble
 * reveals on hover and focus via CSS, so it works on keyboard and touch with no
 * JavaScript and no layout shift.
 */
export function tooltip({ props, children }: ComponentArgs): ElementContent {
  const tip = str(props.tip);
  return h("span", { className: ["rs-tooltip"], tabindex: 0, "aria-label": tip }, [
    h("span", { className: ["rs-tooltip__label"] }, children),
    h("span", { className: ["rs-tooltip__pop"], role: "tooltip", "aria-hidden": "true" }, [
      { type: "text", value: tip },
    ]),
  ]);
}
