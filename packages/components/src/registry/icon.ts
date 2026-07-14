import type { ElementContent } from "hast";
import { h, s } from "hastscript";
import type { IconResolver } from "../lucide/resolve.js";
import { type ComponentArgs, str } from "./util.js";

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function iconSize(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 16;
}

/**
 * Build the `<Icon>` render, bound to an optional icon resolver. Renders a named
 * Lucide icon as inline, build-time SVG (zero JS, no CDN); an `http(s)` name is
 * an external image; an unknown name degrades to a neutral glyph rather than
 * throwing (the render pipeline never throws). Decorative by default; a `label`
 * makes it an announced `role="img"`.
 */
export function makeIcon(resolve?: IconResolver): (args: ComponentArgs) => ElementContent {
  return ({ props }: ComponentArgs): ElementContent => {
    const name = str(props.icon);
    const px = iconSize(props.size);
    const colorRaw = str(props.color);
    const style = HEX.test(colorRaw) ? { style: `color:${colorRaw}` } : {};
    const label = str(props.label) || str(props["aria-label"]);
    const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" };
    const cls = str(props.className);
    const className = cls ? ["rs-icon", cls] : ["rs-icon"];

    if (/^https?:\/\//i.test(name)) {
      return h("img", {
        className,
        src: name,
        width: px,
        height: px,
        alt: label,
        ...style,
      });
    }

    const children = resolve?.(name);
    if (!children || children.length === 0) {
      return s(
        "svg",
        {
          className: [...className, "rs-icon--missing"],
          width: px,
          height: px,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          "data-rs-icon-missing": name,
          ...style,
          ...a11y,
        },
        [s("rect", { x: 4, y: 4, width: 16, height: 16, rx: 3 })],
      );
    }

    return s(
      "svg",
      {
        className,
        width: px,
        height: px,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        ...style,
        ...a11y,
      },
      children,
    );
  };
}
