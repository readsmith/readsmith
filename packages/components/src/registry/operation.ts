import type { NormalizedSpec } from "@readsmith/model";
import type { Element } from "hast";
import { fromHtml } from "hast-util-from-html";
import { h } from "hastscript";
import {
  renderOperationBar,
  renderOperationConsole,
  renderOperationSections,
} from "../api/operation.js";
import { type ComponentArgs, str } from "./util.js";

/*
 * <Operation op="POST /sandboxes" /> embeds one operation's generated
 * reference (method bar, parameters, request body, responses, auth, and the
 * console with request samples) inline in any prose page. This is how a
 * hand-written API walkthrough gets the spec-derived material per endpoint
 * without splitting into one page per operation. The registry is built with
 * the site's normalized spec (createRegistry({ apiSpec })); without one, or
 * with a reference that matches nothing, the embed degrades to a danger
 * callout instead of eating the page.
 */

export function operationEmbed(spec: NormalizedSpec | null | undefined) {
  return ({ props }: ComponentArgs): Element => {
    const ref = str(props.op).trim();
    const [method = "", path = ""] = ref.split(/\s+/);
    const op = spec?.operations.find((o) => o.method === method.toLowerCase() && o.path === path);
    if (!spec || !op) {
      return h("div", { className: ["rs-callout", "rs-callout--danger"], role: "note" }, [
        h("div", { className: ["rs-callout__body"] }, [
          h("p", { className: ["rs-callout__title"] }, "API embed unavailable"),
          h("p", [
            "The operation reference ",
            h("code", ref || "(missing `op`)"),
            " could not be resolved from the configured OpenAPI spec.",
          ]),
        ]),
      ]);
    }
    const html = `<div class="rs-op-embed">${renderOperationBar(op, spec)}${renderOperationSections(
      op,
      spec,
    )}${renderOperationConsole(op, spec)}</div>`;
    return fromHtml(html, { fragment: true }).children[0] as Element;
  };
}
