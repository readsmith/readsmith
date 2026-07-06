import type { ElementContent, Properties } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, str } from "./util.js";

/**
 * A media wrapper with consistent styling and an optional caption.
 * `<Frame caption="..." ratio="16/9"><img .../></Frame>`. A declared ratio
 * reserves space so an image cannot shift the layout as it loads (zero CLS).
 */
export function frame({ props, children }: ComponentArgs): ElementContent {
  const caption = str(props.caption);
  const ratio = str(props.ratio);

  const mediaProps: Properties = { className: ["rs-frame__media"] };
  if (ratio) mediaProps.style = `aspect-ratio:${ratio.replace("/", " / ")}`;

  const inner: ElementContent[] = [h("div", mediaProps, children)];
  if (caption) {
    inner.push(
      h("figcaption", { className: ["rs-frame__caption"] }, [{ type: "text", value: caption }]),
    );
  }
  return h("figure", { className: ["rs-frame"] }, inner);
}
