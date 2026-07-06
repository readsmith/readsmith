import type { Element, ElementContent, Properties } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, collect, hasClass, str } from "./util.js";

/**
 * A single tab panel. `<Tab title="Python">...</Tab>`. Renders a panel carrying
 * its title on a data attribute; the parent Tabs reads those to build the
 * tablist. The title lives in the markup so the panel is meaningful on its own.
 */
export function tab({ props, children }: ComponentArgs): ElementContent {
  return h(
    "div",
    { className: ["rs-tab"], "data-rs-tab-title": str(props.title, "Tab") },
    children,
  );
}

/**
 * In-place variant switcher. `<Tabs group="lang"><Tab .../></Tabs>`. Builds an
 * ARIA tablist from the child panels; the first tab is selected and the rest are
 * hidden for the SSR (no-JS) reading. The island enhancer wires ids, keyboard
 * navigation, and page-wide sync by `group`. Marked island so the pipeline lists
 * it in the hydration manifest.
 */
export function tabs({ props, children }: ComponentArgs): ElementContent {
  const panels = collect(children, (el) => hasClass(el, "rs-tab"));
  const group = str(props.group);

  const list = panels.map((panel, i) => {
    // hastscript stores data-* as camelCase hast properties (dataRsTabTitle).
    const title = str(panel.properties?.dataRsTabTitle, `Tab ${i + 1}`);
    return h(
      "button",
      {
        className: ["rs-tabs__tab"],
        type: "button",
        role: "tab",
        "aria-selected": i === 0 ? "true" : "false",
        tabindex: i === 0 ? 0 : -1,
      },
      [{ type: "text", value: title }],
    );
  });

  const panelEls: Element[] = panels.map((panel, i) => {
    const properties: Properties = { ...(panel.properties ?? {}), role: "tabpanel", tabindex: 0 };
    if (i !== 0) properties.hidden = true;
    return { ...panel, properties };
  });

  const rootProps: Properties = { className: ["rs-tabs"] };
  if (group) rootProps["data-rs-group"] = group;

  return h("div", rootProps, [
    h("div", { className: ["rs-tabs__list"], role: "tablist" }, list),
    h("div", { className: ["rs-tabs__panels"] }, panelEls),
  ]);
}
