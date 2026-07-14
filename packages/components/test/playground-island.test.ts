// @vitest-environment happy-dom
import type { Operation, Server } from "@readsmith/model";
import { describe, expect, it } from "vitest";
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
