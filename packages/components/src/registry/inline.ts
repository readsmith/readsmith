import type { ElementContent } from "hast";
import { h } from "hastscript";
import type { IconResolver } from "../lucide/resolve.js";
import { inlineIcon } from "./icon.js";
import { type ComponentArgs, str } from "./util.js";

/** A keyboard key. `<Kbd>Ctrl</Kbd>`, rendered as a stamped key. */
export function kbd({ children }: ComponentArgs): ElementContent {
  return h("kbd", { className: ["rs-kbd"] }, children);
}

/** The named tints a badge can carry; anything else renders as the neutral pill. */
const BADGE_VARIANTS = new Set(["note", "info", "tip", "warning", "danger", "accent", "new"]);

/**
 * Build the `<Badge>` render, bound to an optional icon resolver. A small status
 * pill: `<Badge variant="new">Beta</Badge>`, or with a leading icon
 * `<Badge variant="warning" icon="triangle-alert">Deprecated</Badge>`. `variant`
 * (or its alias `color`) selects a semantic tint; an unknown value is the neutral
 * pill rather than a broken class.
 */
export function makeBadge(resolve?: IconResolver): (args: ComponentArgs) => ElementContent {
  return ({ props, children }: ComponentArgs): ElementContent => {
    const variant = str(props.variant) || str(props.color);
    const classes = ["rs-badge"];
    if (BADGE_VARIANTS.has(variant)) classes.push(`rs-badge--${variant}`);
    const icon = inlineIcon(resolve, str(props.icon), 13, "rs-badge__icon");
    const kids: ElementContent[] = icon ? [icon, ...children] : children;
    return h("span", { className: classes }, kids);
  };
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
