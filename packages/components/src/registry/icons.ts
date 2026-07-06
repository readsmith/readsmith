import type { Element } from "hast";
import { s } from "hastscript";

/** A line-icon set matched to the callout kinds. Decorative (aria-hidden). */
export function calloutIcon(kind: string): Element {
  return s(
    "svg",
    {
      className: ["rs-callout__icon"],
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    shapes(kind),
  );
}

function shapes(kind: string): Element[] {
  switch (kind) {
    case "info":
      return [circle(), s("path", { d: "M12 11v5" }), s("path", { d: "M12 8h.01" })];
    case "tip":
      return [
        s("path", {
          d: "M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 17.9l-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z",
        }),
      ];
    case "warning":
      return [
        s("path", { d: "M12 3l9 16H3z" }),
        s("path", { d: "M12 10v4" }),
        s("path", { d: "M12 17h.01" }),
      ];
    case "danger":
      return [circle(), s("path", { d: "M15 9l-6 6" }), s("path", { d: "M9 9l6 6" })];
    case "check":
      return [circle(), s("path", { d: "M8.5 12.2l2.5 2.5 4.5-5" })];
    default: // note
      return [
        s("path", { d: "M5 7h10" }),
        s("path", { d: "M5 12h14" }),
        s("path", { d: "M5 17h8" }),
      ];
  }
}

function circle(): Element {
  return s("circle", { cx: 12, cy: 12, r: 9 });
}
