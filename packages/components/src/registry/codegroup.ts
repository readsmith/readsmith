import type { Element, ElementContent, Properties } from "hast";
import { h } from "hastscript";
import { type ComponentArgs, collect, findByClass, hasClass, str, textContent } from "./util.js";

/**
 * Multiple code samples behind a switcher. `<CodeGroup>` wraps several fenced
 * code blocks; each becomes a tab labelled by its filename (or language). One
 * sample shows at a time. Marked island; the enhancer wires switching and syncs
 * page-wide by `group` (so a language chosen in Tabs can follow here, and vice
 * versa, when the labels match).
 */
export function codeGroup({ props, children }: ComponentArgs): ElementContent {
  const figures = collect(children, (el) => el.tagName === "figure" && hasClass(el, "rs-code"));
  const group = str(props.group);

  const list = figures.map((figure, i) => {
    const label = figureLabel(figure, i);
    return h(
      "button",
      {
        className: ["rs-codegroup__tab"],
        type: "button",
        role: "tab",
        "data-rs-tab-title": label,
        "aria-selected": i === 0 ? "true" : "false",
        tabindex: i === 0 ? 0 : -1,
      },
      [{ type: "text", value: label }],
    );
  });

  const panels: Element[] = figures.map((figure, i) => {
    const properties: Properties = { ...(figure.properties ?? {}), role: "tabpanel" };
    if (i !== 0) properties.hidden = true;
    return { ...figure, properties };
  });

  const rootProps: Properties = { className: ["rs-codegroup"] };
  if (group) rootProps["data-rs-group"] = group;

  return h("div", rootProps, [
    h("div", { className: ["rs-codegroup__list"], role: "tablist" }, list),
    h("div", { className: ["rs-codegroup__panels"] }, panels),
  ]);
}

/** A code sample's switcher label: its filename, else its language, else a number. */
function figureLabel(figure: Element, index: number): string {
  const file = findByClass(figure, "rs-code__file");
  if (file) {
    const text = textContent(file).trim();
    if (text) return text;
  }
  const lang = figure.properties?.dataLang; // hastscript camelCases data-lang
  if (typeof lang === "string" && lang) return lang;
  return `Tab ${index + 1}`;
}
