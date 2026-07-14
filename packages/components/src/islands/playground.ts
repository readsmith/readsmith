import type { HarSource } from "../api/code-samples.js";
import { type AuthInput, type PlaygroundForm, formToCurl } from "../api/playground.js";

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
