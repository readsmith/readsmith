import type { HarSource } from "../api/code-samples.js";
import {
  type AuthInput,
  type PlaygroundForm,
  formToCurl,
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
    sendBtn.addEventListener("click", () => void send(seed, readForm(), sendBtn, responseEl));
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

async function send(
  seed: HarSource,
  form: PlaygroundForm,
  btn: HTMLButtonElement,
  host: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Sending…";
  try {
    const res = await fetch(proxyUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formToWireRequest(seed, form)),
    });
    const data = (await res.json().catch(() => null)) as ProxyResult | null;
    renderResponse(host, res.status, data);
  } catch {
    renderResponse(host, 0, { error: "The request could not be sent." });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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

/** Render the proxy result as inert, escaped DOM (the response body is untrusted). */
function renderResponse(host: HTMLElement, httpStatus: number, data: ProxyResult | null): void {
  host.hidden = false;
  host.replaceChildren(el("div", "rs-pf__rlabel", "Response"));

  if (!data || data.error !== undefined) {
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
    host.append(card);
    return;
  }

  const upstream = typeof data.status === "number" ? data.status : httpStatus;
  const ok = upstream >= 200 && upstream < 400;
  const card = el("div", "rs-pf__rcard");
  const status = el("div", `rs-pf__rstatus ${ok ? "is-ok" : "is-error"}`);
  status.append(el("b", undefined, String(upstream)));
  if (typeof data.timing?.totalMs === "number") {
    status.append(el("span", "rs-pf__rtime", `${Math.round(data.timing.totalMs)} ms`));
  }
  card.append(status);

  if (data.headers && Object.keys(data.headers).length > 0) {
    const lines = Object.entries(data.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
    card.append(el("pre", "rs-pf__rheaders", lines));
  }
  card.append(
    el("pre", "rs-pf__rbody", prettyIfJson(decodeBody(data.bodyBase64 ?? ""), data.headers)),
  );
  if (data.truncated) card.append(el("div", "rs-pf__rnote", "Response truncated at the size cap."));
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
