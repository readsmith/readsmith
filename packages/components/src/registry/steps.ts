import type { ElementContent } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, collect, hasClass, str } from "./util.js";

/**
 * A numbered procedure. `<Steps><Step title="...">body</Step>...</Steps>`. Steps
 * are a real sequence, so this is an ordered list; the numeral and the connecting
 * rule are drawn from a CSS counter, keeping order as information (not decoration).
 */
export function steps({ children }: ComponentArgs): ElementContent {
  const items = collect(children, (el) => hasClass(el, "rs-step"));
  return h("ol", { className: ["rs-steps"] }, items);
}

export function step({ props, children }: ComponentArgs): ElementContent {
  const title = str(props.title);
  const body: ElementContent[] = [];
  if (title) {
    body.push(h("p", { className: ["rs-step__title"] }, [{ type: "text", value: title }]));
  }
  body.push(...children);
  return h("li", { className: ["rs-step"] }, [h("div", { className: ["rs-step__body"] }, body)]);
}
