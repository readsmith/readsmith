import type { HarSource } from "../api/code-samples.js";
import {
  type AuthInput,
  type PlaygroundForm,
  formToCurl,
  formToFetch,
  formToWireRequest,
} from "../api/playground.js";

/**
 * Hydrate an API-playground form. Editing any input rebuilds the live curl from
 * the embedded operation seed and the current form state, using the same request
 * model the console will POST (so the curl is always what "Try It" would send).
 * Reader credentials live only in these inputs and are never persisted.
 */
export function enhancePlayground(mount: HTMLElement): void {
  const seedEl = mount.querySelector("[data-rs-pf-seed]");
  const curlEl = mount.querySelector<HTMLElement>("[data-rs-pf-curl]");
  if (!seedEl || !curlEl) return;

  let seed: HarSource;
  try {
    seed = JSON.parse(seedEl.textContent ?? "{}") as HarSource;
  } catch {
    return;
  }

  const value = (key: string): string =>
    mount.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-rs-pf="${key}"]`,
    )?.value ?? "";

  const readForm = (): PlaygroundForm => {
    const params: Record<string, string> = {};
    for (const input of mount.querySelectorAll<HTMLInputElement>("[data-rs-pf-param]")) {
      const key = input.dataset.rsPfParam;
      if (key) params[key] = input.value;
    }
    const body = value("body");
    return {
      baseUrl: value("server"),
      params,
      body: body === "" ? undefined : body,
      auth: readAuth(value),
    };
  };

  const update = (): void => {
    curlEl.textContent = formToCurl(seed, readForm());
  };

  syncAuthVisibility(mount);
  mount.addEventListener("input", update);
  mount.addEventListener("change", () => {
    syncAuthVisibility(mount);
    update();
  });
  update();

  const sendBtn = mount.querySelector<HTMLButtonElement>("[data-rs-pf-send]");
  const responseEl = mount.querySelector<HTMLElement>("[data-rs-pf-response]");
  if (sendBtn && responseEl) {
    sendBtn.addEventListener(
      "click",
      () => void send(mount, seed, readForm(), sendBtn, responseEl),
    );
  }
}

function proxyUrl(): string {
  const base = document.documentElement.dataset.rsBase ?? "";
  return `${base}/_readsmith/api/proxy`;
}

interface ProxyResult {
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  truncated?: boolean;
  timing?: { totalMs?: number };
  error?: string | { code?: string; message?: string };
}

interface Rendered {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  timing?: number;
  truncated?: boolean;
  mode: "direct" | "proxy";
  note?: string;
}

async function send(
  mount: HTMLElement,
  seed: HarSource,
  form: PlaygroundForm,
  btn: HTMLButtonElement,
  host: HTMLElement,
): Promise<void> {
  const wantDirect = mount.querySelector<HTMLInputElement>("[data-rs-pf-direct]")?.checked ?? false;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Sending…";
  try {
    // Direct mode (FR-9): try the browser fetch first; a CORS/CSP block throws,
    // and we transparently fall back to the proxy (NF-3: never fail silently).
    if (wantDirect) {
      const direct = await tryDirect(seed, form);
      if (direct) {
        renderResult(host, direct);
        return;
      }
    }
    await viaProxy(seed, form, host, wantDirect);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function tryDirect(seed: HarSource, form: PlaygroundForm): Promise<Rendered | null> {
  const req = formToFetch(seed, form);
  const started = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      mode: "cors",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      status: res.status,
      headers,
      bodyText: prettyIfJson(await res.text(), headers),
      timing: performance.now() - started,
      mode: "direct",
    };
  } catch {
    return null; // CORS or CSP blocked the direct fetch; fall back to the proxy
  }
}

async function viaProxy(
  seed: HarSource,
  form: PlaygroundForm,
  host: HTMLElement,
  directFellBack: boolean,
): Promise<void> {
  const note = directFellBack
    ? "Direct request was blocked; sent via the Readsmith proxy."
    : undefined;
  try {
    const res = await fetch(proxyUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formToWireRequest(seed, form)),
    });
    const data = (await res.json().catch(() => null)) as ProxyResult | null;
    if (!data || data.error !== undefined) {
      renderError(host, res.status, data, note);
      return;
    }
    renderResult(host, {
      status: typeof data.status === "number" ? data.status : res.status,
      headers: data.headers ?? {},
      bodyText: prettyIfJson(decodeBody(data.bodyBase64 ?? ""), data.headers),
      timing: data.timing?.totalMs,
      truncated: data.truncated,
      mode: "proxy",
      note,
    });
  } catch {
    renderError(host, 0, { error: "The request could not be sent." }, note);
  }
}

function modeLabel(mode: "direct" | "proxy"): string {
  return mode === "direct" ? "Sent directly from your browser" : "Sent via the Readsmith proxy";
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // untrusted content stays inert (SR-13/NF-4)
  return node;
}

function decodeBody(base64: string): string {
  if (base64 === "") return "";
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function prettyIfJson(text: string, headers?: Record<string, string>): string {
  const type = headers?.["content-type"] ?? "";
  if (!type.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Render a normalized result as inert, escaped DOM (the response body is untrusted). */
function renderResult(host: HTMLElement, r: Rendered): void {
  host.hidden = false;
  host.replaceChildren(el("div", "rs-pf__rlabel", "Response"));
  const ok = r.status >= 200 && r.status < 400;
  const card = el("div", "rs-pf__rcard");
  const status = el("div", `rs-pf__rstatus ${ok ? "is-ok" : "is-error"}`);
  status.append(el("b", undefined, String(r.status)));
  if (typeof r.timing === "number") {
    status.append(el("span", "rs-pf__rtime", `${Math.round(r.timing)} ms`));
  }
  card.append(status, el("div", "rs-pf__rmode", r.note ?? modeLabel(r.mode)));
  if (Object.keys(r.headers).length > 0) {
    const lines = Object.entries(r.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
    card.append(el("pre", "rs-pf__rheaders", lines));
  }
  card.append(el("pre", "rs-pf__rbody", r.bodyText));
  if (r.truncated) card.append(el("div", "rs-pf__rnote", "Response truncated at the size cap."));
  host.append(card);
}

/** Render a proxy/network error, with an optional direct-fallback note. */
function renderError(
  host: HTMLElement,
  httpStatus: number,
  data: ProxyResult | null,
  note?: string,
): void {
  host.hidden = false;
  host.replaceChildren(el("div", "rs-pf__rlabel", "Response"));
  const message = !data
    ? "The server returned an unreadable response."
    : typeof data.error === "string"
      ? data.error
      : (data.error?.message ?? "The request failed.");
  const card = el("div", "rs-pf__rcard is-error");
  card.append(
    el(
      "div",
      "rs-pf__rstatus is-error",
      httpStatus === 503 ? "Unavailable" : `Error ${httpStatus || ""}`.trim(),
    ),
    el("div", "rs-pf__rmsg", message),
  );
  if (note) card.append(el("div", "rs-pf__rmode", note));
  host.append(card);
}

function readAuth(value: (key: string) => string): AuthInput {
  switch (value("auth-kind")) {
    case "bearer":
      return { kind: "bearer", token: value("auth-token") };
    case "basic":
      return { kind: "basic", username: value("auth-user"), password: value("auth-pass") };
    case "apiKey": {
      const where = value("auth-in");
      const location = where === "query" || where === "cookie" ? where : "header";
      return { kind: "apiKey", in: location, name: value("auth-name"), value: value("auth-value") };
    }
    default:
      return { kind: "none" };
  }
}

/** Show only the auth inputs relevant to the chosen scheme. */
function syncAuthVisibility(mount: HTMLElement): void {
  const kind = mount.querySelector<HTMLSelectElement>('[data-rs-pf="auth-kind"]')?.value ?? "none";
  const shown: Record<string, string[]> = {
    none: [],
    bearer: ["auth-token"],
    apiKey: ["auth-in", "auth-name", "auth-value"],
    basic: ["auth-user", "auth-pass"],
  };
  const visible = new Set(shown[kind] ?? []);
  for (const key of [
    "auth-token",
    "auth-in",
    "auth-name",
    "auth-value",
    "auth-user",
    "auth-pass",
  ]) {
    const el = mount.querySelector<HTMLElement>(`[data-rs-pf="${key}"]`);
    if (el) el.hidden = !visible.has(key);
  }
}
