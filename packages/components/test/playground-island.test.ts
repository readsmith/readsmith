// @vitest-environment happy-dom
import type { Operation, Server } from "@readsmith/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPlaygroundForm } from "../src/api/playground-render.js";
import { enhancePlayground } from "../src/islands/playground.js";

const op = {
  method: "post",
  path: "/pets/{id}",
  operationId: "updatePet",
  tags: [],
  parameters: [
    { name: "id", in: "path", required: true, schema: { type: "string" }, example: "p1" },
    { name: "verbose", in: "query", required: false, schema: { type: "boolean" }, example: "true" },
  ],
  requestBody: {
    required: true,
    content: { "application/json": { schema: { example: { name: "Rex" } } } },
  },
  responses: [],
} as unknown as Operation;

const servers: Server[] = [{ url: "https://api.example.com" }];

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function mountForm(): HTMLElement {
  document.body.innerHTML = renderPlaygroundForm(op, servers);
  const mount = q<HTMLElement>(document, ".rs-playground");
  enhancePlayground(mount);
  return mount;
}

describe("playground island (focused modal)", () => {
  it("keeps the trigger hidden until hydration, then reveals it", () => {
    document.body.innerHTML = renderPlaygroundForm(op, servers);
    const trigger = q<HTMLButtonElement>(document, "[data-rs-pf-open]");
    expect(trigger.hidden).toBe(true); // no JS yet
    enhancePlayground(q<HTMLElement>(document, ".rs-playground"));
    expect(trigger.hidden).toBe(false);
    expect(trigger.textContent).toContain("Try it");
  });

  it("opens the dialog on the trigger and closes it on the close button", () => {
    const mount = mountForm();
    const dialog = q<HTMLDialogElement>(mount, "[data-rs-pf-dialog]");
    expect(dialog.open).toBeFalsy();
    q<HTMLButtonElement>(mount, "[data-rs-pf-open]").click();
    expect(dialog.hasAttribute("open") || dialog.open).toBeTruthy();
    q<HTMLButtonElement>(mount, "[data-rs-pf-close]").click();
    expect(dialog.open).toBeFalsy();
  });

  it("copies the live curl to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const mount = mountForm();
    q<HTMLButtonElement>(mount, "[data-rs-pf-copy]").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("https://api.example.com/pets/p1"),
    );
    vi.unstubAllGlobals();
  });

  it("shows an empty-state before the first send", () => {
    const mount = mountForm();
    expect(q(mount, "[data-rs-pf-response]").textContent).toContain(
      "Send a request to see the response",
    );
  });
});

describe("playground island (hydration + live curl)", () => {
  it("renders inputs prefilled from examples and an initial curl", () => {
    const mount = mountForm();
    expect(q<HTMLInputElement>(mount, '[data-rs-pf-param="path:id"]').value).toBe("p1");
    expect(q(mount, "[data-rs-pf-curl]").textContent).toContain("https://api.example.com/pets/p1");
  });

  it("updates the live curl when a parameter changes", () => {
    const mount = mountForm();
    const idInput = q<HTMLInputElement>(mount, '[data-rs-pf-param="path:id"]');
    idInput.value = "p42";
    idInput.dispatchEvent(new Event("input", { bubbles: true }));
    const curl = q(mount, "[data-rs-pf-curl]").textContent ?? "";
    expect(curl).toContain("/pets/p42");
    expect(curl).not.toContain("/pets/p1");
  });

  it("reveals the token field and injects the bearer header when auth is chosen", () => {
    const mount = mountForm();
    const kind = q<HTMLSelectElement>(mount, '[data-rs-pf="auth-kind"]');
    const token = q<HTMLInputElement>(mount, '[data-rs-pf="auth-token"]');
    expect(token.hidden).toBe(true); // hidden by default (None)
    kind.value = "bearer";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(token.hidden).toBe(false); // shown after choosing bearer
    token.value = "TK";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    expect(q(mount, "[data-rs-pf-curl]").textContent).toContain("Authorization: Bearer TK");
  });
});

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status, json: async () => body }) as unknown as Response),
  );
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("playground island (Send -> proxy -> response)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the proxy and renders the decoded response", async () => {
    const mount = mountForm();
    stubFetch(200, {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: btoa('{"ok":true}'),
      truncated: false,
      timing: { totalMs: 12 },
    });
    q<HTMLButtonElement>(mount, "[data-rs-pf-send]").click();
    await flush();
    const resp = q<HTMLElement>(mount, "[data-rs-pf-response]");
    expect(resp.hidden).toBe(false);
    const text = resp.textContent ?? "";
    expect(text).toContain("200");
    expect(text).toContain('"ok": true'); // pretty-printed JSON body
    expect(text).toContain("content-type: application/json");
  });

  it("renders a typed proxy error message", async () => {
    const mount = mountForm();
    stubFetch(403, {
      error: { code: "DENIED_NOT_ALLOWLISTED", message: "This server isn't declared." },
    });
    q<HTMLButtonElement>(mount, "[data-rs-pf-send]").click();
    await flush();
    expect(q(mount, "[data-rs-pf-response]").textContent).toContain("This server isn't declared.");
  });

  it("handles the playground-disabled 503", async () => {
    const mount = mountForm();
    stubFetch(503, { error: "The API playground is not available on this site." });
    q<HTMLButtonElement>(mount, "[data-rs-pf-send]").click();
    await flush();
    const text = q(mount, "[data-rs-pf-response]").textContent ?? "";
    expect(text).toContain("Unavailable");
    expect(text).toContain("not available");
  });
});

describe("playground island (direct mode, FR-9)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches from the browser and labels it direct when CORS allows", async () => {
    const mount = mountForm();
    q<HTMLInputElement>(mount, "[data-rs-pf-direct]").checked = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/_readsmith/api/proxy"))
          throw new Error("proxy must not be hit");
        return new Response('{"direct":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    q<HTMLButtonElement>(mount, "[data-rs-pf-send]").click();
    await flush();
    const text = q<HTMLElement>(mount, "[data-rs-pf-response]").textContent ?? "";
    expect(text).toContain("Sent directly from your browser");
    expect(text).toContain('"direct": true');
  });

  it("falls back to the proxy when the direct fetch is blocked", async () => {
    const mount = mountForm();
    q<HTMLInputElement>(mount, "[data-rs-pf-direct]").checked = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/_readsmith/api/proxy")) {
          return {
            status: 200,
            json: async () => ({
              status: 200,
              headers: {},
              bodyBase64: btoa("from-proxy"),
              truncated: false,
              timing: { totalMs: 5 },
            }),
          } as unknown as Response;
        }
        throw new TypeError("Failed to fetch"); // CORS/CSP blocks the direct request
      }),
    );
    q<HTMLButtonElement>(mount, "[data-rs-pf-send]").click();
    await flush();
    const text = q<HTMLElement>(mount, "[data-rs-pf-response]").textContent ?? "";
    expect(text).toContain("Direct request was blocked");
    expect(text).toContain("from-proxy");
  });
});
