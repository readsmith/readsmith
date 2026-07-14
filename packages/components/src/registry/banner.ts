import type { ElementContent, Properties } from "hast";
import { h, s } from "hastscript";
import type { IconResolver } from "../lucide/resolve.js";
import { inlineIcon } from "./icon.js";
import { type ComponentArgs, str, textContent } from "./util.js";

/** The named tints a banner can carry; the default is the accent wash. */
const BANNER_VARIANTS = new Set(["info", "tip", "warning", "danger", "accent"]);

/**
 * A prominent announcement strip for the top of a page: a new release, a
 * migration notice, a deprecation. `<Banner icon="megaphone">...</Banner>`, or
 * `<Banner variant="warning" dismissible>...</Banner>`. Static and zero-JS by
 * default; a dismissible banner carries a close control and a stable key that
 * the client enhancer wires to persist the dismissal (see `initBanners`), so a
 * reader who closes it does not see it again.
 */
export function makeBanner(resolve?: IconResolver): (args: ComponentArgs) => ElementContent {
  return ({ props, children }: ComponentArgs): ElementContent => {
    const variant = str(props.variant) || str(props.color);
    const dismissible = props.dismissible === true || props.dismissible === "true";
    const classes = ["rs-banner"];
    if (BANNER_VARIANTS.has(variant)) classes.push(`rs-banner--${variant}`);

    const kids: ElementContent[] = [];
    const icon = inlineIcon(resolve, str(props.icon), 18, "rs-banner__icon");
    if (icon) kids.push(icon);
    kids.push(h("div", { className: ["rs-banner__content"] }, children));

    const attrs: Properties = { className: classes, role: "note" };
    if (dismissible) {
      attrs["data-dismissible"] = "true";
      // A content-derived key so the same banner stays dismissed across pages,
      // and a new announcement (new text) re-appears. Deterministic: no clock.
      attrs["data-banner-key"] = hashKey(children.map((c) => textContent(c)).join(""));
      kids.push(
        h(
          "button",
          { type: "button", className: ["rs-banner__dismiss"], "aria-label": "Dismiss" },
          [closeIcon()],
        ),
      );
    }
    return h("aside", attrs, kids);
  };
}

/** A short, stable, non-cryptographic key (djb2). Deterministic by construction. */
function hashKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function closeIcon() {
  return s(
    "svg",
    {
      className: ["rs-banner__dismiss-icon"],
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    [s("path", { d: "M18 6 6 18" }), s("path", { d: "M6 6l12 12" })],
  );
}
