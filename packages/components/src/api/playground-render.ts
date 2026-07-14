import type { NormalizedSchema, Operation, Server } from "@readsmith/model";
import { esc } from "../shell/util.js";
import { type HarSource, exampleString } from "./code-samples.js";
import { formToCurl } from "./playground.js";
import { sampleBodySkeleton } from "./schema-sample.js";

/**
 * The trimmed operation the playground island embeds and rebuilds the request
 * from, so the browser needs only what `buildHarRequest` reads, not the whole
 * spec. A full `Operation` is a superset of this shape.
 */
export function playgroundSeed(op: Operation): HarSource {
  return {
    method: op.method,
    path: op.path,
    parameters: op.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      example: p.example,
      schema: { example: p.schema.example, default: p.schema.default },
    })),
    requestBody: op.requestBody
      ? {
          content: Object.fromEntries(
            Object.entries(op.requestBody.content).map(([media, value]) => [
              media,
              { schema: { example: value.schema.example } },
            ]),
          ),
        }
      : undefined,
  };
}

function paramExample(p: HarSource["parameters"][number]): string {
  return exampleString(p.example ?? p.schema.example ?? p.schema.default);
}

// The seed is embedded in a JSON script; escaping `<` as < keeps a stray
// `</script>` in an example from breaking out (HTML entities are not decoded
// inside a script element, so ordinary html-escaping would corrupt the JSON).
function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function field(label: string, control: string): string {
  return `<label class="rs-pf__field"><span class="rs-pf__label">${esc(label)}</span>${control}</label>`;
}

function paramGroup(title: string, params: HarSource["parameters"]): string {
  if (params.length === 0) return "";
  const rows = params
    .map((p) =>
      field(
        `${p.name}${p.in === "path" ? " *" : ""}`,
        `<input class="rs-pf__input" data-rs-pf-param="${esc(`${p.in}:${p.name}`)}" value="${esc(paramExample(p))}" spellcheck="false" autocomplete="off">`,
      ),
    )
    .join("");
  return `<fieldset class="rs-pf__group"><legend>${esc(title)}</legend>${rows}</fieldset>`;
}

const PLAY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 3.3v9.4l8-4.7-8-4.7Z" fill="currentColor"/></svg>';

/**
 * Server-render the "Try it" affordance for an operation: a polished trigger
 * button plus a focused two-pane modal (request builder on the left, live
 * response on the right). Hydrated by the `Playground` island, which reveals the
 * trigger, opens the dialog, keeps the curl live, and sends the request. The
 * trigger stays hidden until hydration since the whole flow needs JavaScript.
 */
export function renderPlaygroundForm(
  op: Operation,
  servers: Server[],
  schemas: Record<string, NormalizedSchema> = {},
): string {
  const seed = playgroundSeed(op);
  const baseUrl = servers[0]?.url ?? "";
  const method = op.method.toUpperCase();
  const label = `Try ${method} ${op.path}`;

  // The editable body: required keys filled with placeholders, optional keys
  // left as `//` commented lines (jsoncToJson normalizes it before it is sent).
  const bodySchema = op.requestBody?.content["application/json"]?.schema;
  const bodyText = bodySchema ? sampleBodySkeleton(bodySchema, schemas) : undefined;
  // The curl and every sent request run through the same body, so they match.
  const initialCurl = formToCurl(seed, { baseUrl, body: bodyText });

  const serverControl =
    servers.length > 1
      ? field(
          "Server",
          `<select class="rs-pf__input" data-rs-pf="server">${servers
            .map((s) => `<option value="${esc(s.url)}">${esc(s.url)}</option>`)
            .join("")}</select>`,
        )
      : `<input type="hidden" data-rs-pf="server" value="${esc(baseUrl)}">`;

  const path = seed.parameters.filter((p) => p.in === "path");
  const query = seed.parameters.filter((p) => p.in === "query");
  const header = seed.parameters.filter((p) => p.in === "header");

  const bodyRows = bodyText ? Math.min(Math.max(bodyText.split("\n").length + 1, 4), 18) : 6;
  const bodyField =
    bodyText !== undefined
      ? field(
          "Body",
          `<textarea class="rs-pf__input rs-pf__body" data-rs-pf="body" rows="${bodyRows}" spellcheck="false">${esc(bodyText)}</textarea>`,
        )
      : "";

  const authField = `<fieldset class="rs-pf__group"><legend>Authorization</legend>${field(
    "Scheme",
    `<select class="rs-pf__input" data-rs-pf="auth-kind"><option value="none">None</option><option value="bearer">Bearer token</option><option value="apiKey">API key</option><option value="basic">Basic</option></select>`,
  )}<input class="rs-pf__input" data-rs-pf="auth-token" placeholder="token" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-name" placeholder="key name" hidden autocomplete="off"><select class="rs-pf__input" data-rs-pf="auth-in" hidden><option value="header">header</option><option value="query">query</option><option value="cookie">cookie</option></select><input class="rs-pf__input" data-rs-pf="auth-value" placeholder="key value" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-user" placeholder="username" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-pass" type="password" placeholder="password" hidden autocomplete="off"></fieldset>`;

  const requestPane = `<section class="rs-pf__pane rs-pf__reqpane"><div class="rs-pf__panelabel">Request</div><form class="rs-pf__form" data-rs-pf-form>${serverControl}${paramGroup(
    "Path",
    path,
  )}${paramGroup("Query", query)}${paramGroup(
    "Headers",
    header,
  )}${bodyField}${authField}</form><div class="rs-pf__actions"><button type="button" class="rs-pf__send" data-rs-pf-send>Send</button><label class="rs-pf__direct" title="If the API allows CORS, send from your browser so your credentials never reach Readsmith. Falls back to the proxy otherwise."><input type="checkbox" data-rs-pf-direct> Direct from browser</label><button type="button" class="rs-pf__copy" data-rs-pf-copy>Copy as cURL</button></div><pre class="rs-pf__curl" data-rs-pf-curl>${esc(
    initialCurl,
  )}</pre></section>`;

  const responsePane = `<section class="rs-pf__pane rs-pf__respane"><div class="rs-pf__panelabel">Response</div><div class="rs-pf__response" data-rs-pf-response><div class="rs-pf__empty">Send a request to see the response.</div></div></section>`;

  const dialog = `<dialog class="rs-pf__dialog" data-rs-pf-dialog aria-label="${esc(
    label,
  )}"><div class="rs-pf__modal"><header class="rs-pf__dhead"><span class="rs-pf__dmeth">${esc(
    method,
  )}</span><span class="rs-pf__dpath">${esc(
    op.path,
  )}</span><button type="button" class="rs-pf__dclose" data-rs-pf-close aria-label="Close">&#215;</button></header><div class="rs-pf__panes">${requestPane}${responsePane}</div></div></dialog>`;

  return `<div class="rs-playground" data-island="Playground"><script type="application/json" data-rs-pf-seed>${jsonScript(
    seed,
  )}</script><button type="button" class="rs-pf__trigger" data-rs-pf-open aria-haspopup="dialog" hidden>${PLAY_ICON}<span>Try it</span></button>${dialog}</div>`;
}
