import type { Operation, Server } from "@readsmith/model";
import { esc } from "../shell/util.js";
import { type HarSource, buildHarRequest, exampleString } from "./code-samples.js";
import { formToCurl } from "./playground.js";

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

/**
 * Server-render the interactive "Try It" form for an operation. Hydrated by the
 * `Playground` island: editing any input rebuilds the live curl. The Send button
 * (wiring to the proxy) lands in the next slice.
 */
export function renderPlaygroundForm(op: Operation, servers: Server[]): string {
  const seed = playgroundSeed(op);
  const baseUrl = servers[0]?.url ?? "";
  const initialCurl = formToCurl(seed, { baseUrl });

  const serverControl =
    servers.length > 1
      ? `<select class="rs-pf__input" data-rs-pf="server">${servers
          .map((s) => `<option value="${esc(s.url)}">${esc(s.url)}</option>`)
          .join("")}</select>`
      : `<input type="hidden" data-rs-pf="server" value="${esc(baseUrl)}">`;

  const path = seed.parameters.filter((p) => p.in === "path");
  const query = seed.parameters.filter((p) => p.in === "query");
  const header = seed.parameters.filter((p) => p.in === "header");

  const bodyText = buildHarRequest(seed, { baseUrl }).postData?.text;
  const bodyField =
    bodyText !== undefined
      ? field(
          "Body",
          `<textarea class="rs-pf__input rs-pf__body" data-rs-pf="body" rows="6" spellcheck="false">${esc(bodyText)}</textarea>`,
        )
      : "";

  const authField = `<fieldset class="rs-pf__group"><legend>Authorization</legend>${field(
    "Scheme",
    `<select class="rs-pf__input" data-rs-pf="auth-kind"><option value="none">None</option><option value="bearer">Bearer token</option><option value="apiKey">API key</option><option value="basic">Basic</option></select>`,
  )}<input class="rs-pf__input" data-rs-pf="auth-token" placeholder="token" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-name" placeholder="key name" hidden autocomplete="off"><select class="rs-pf__input" data-rs-pf="auth-in" hidden><option value="header">header</option><option value="query">query</option><option value="cookie">cookie</option></select><input class="rs-pf__input" data-rs-pf="auth-value" placeholder="key value" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-user" placeholder="username" hidden autocomplete="off"><input class="rs-pf__input" data-rs-pf="auth-pass" type="password" placeholder="password" hidden autocomplete="off"></fieldset>`;

  return `<div class="rs-playground" data-island="Playground"><script type="application/json" data-rs-pf-seed>${jsonScript(
    seed,
  )}</script><form class="rs-pf__form" data-rs-pf-form>${serverControl}${paramGroup(
    "Path",
    path,
  )}${paramGroup("Query", query)}${paramGroup(
    "Headers",
    header,
  )}${bodyField}${authField}</form><div class="rs-pf__actions"><button type="button" class="rs-pf__send" data-rs-pf-send>Send</button><label class="rs-pf__direct" title="If the API allows CORS, send from your browser so your credentials never reach Readsmith. Falls back to the proxy otherwise."><input type="checkbox" data-rs-pf-direct> Direct from browser</label></div><pre class="rs-pf__curl" data-rs-pf-curl>${esc(
    initialCurl,
  )}</pre><div class="rs-pf__response" data-rs-pf-response hidden></div></div>`;
}
