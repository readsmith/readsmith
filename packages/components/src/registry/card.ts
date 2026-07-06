import type { ElementContent, Properties } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, collect, hasClass, str } from "./util.js";

/**
 * A linked tile. `<Card title="..." href="/guide">body</Card>`. Renders an
 * anchor when `href` is set (the whole tile is the link), otherwise a plain
 * panel. Hover and focus lift the border to the accent.
 */
export function card({ props, children }: ComponentArgs): ElementContent {
  const href = str(props.href);
  const title = str(props.title);
  const tag = href ? "a" : "div";
  const attrs: Properties = { className: ["rs-card"] };
  if (href) attrs.href = href;

  const body: ElementContent[] = [];
  if (title) body.push(h("p", { className: ["rs-card__title"] }, [{ type: "text", value: title }]));
  body.push(h("div", { className: ["rs-card__body"] }, children));

  return h(tag, attrs, body);
}

/**
 * A responsive grid of cards. `<CardGroup cols="3">...</CardGroup>`; defaults to
 * two columns, collapsing to one on narrow screens.
 */
export function cardGroup({ props, children }: ComponentArgs): ElementContent {
  const cols = str(props.cols, "2");
  const cards = collect(children, (el) => hasClass(el, "rs-card"));
  return h("div", { className: ["rs-cards"], "data-cols": cols }, cards);
}
