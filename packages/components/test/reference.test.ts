import type { NormalizedSpec, Operation } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { operationSamples, renderCodeSamples } from "../src/api/code-samples.js";
import {
  operationAnchor,
  operationPath,
  referenceGroups,
  renderApiNav,
  renderOperation,
  renderOperationConsole,
  renderReferenceBody,
} from "../src/api/reference.js";
import type { ShellSite } from "../src/shell/index.js";

const spec: NormalizedSpec = {
  specId: "s1",
  siteId: "default",
  version: 1,
  sourceHash: "h",
  info: { title: "Payments", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  securitySchemes: {
    bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
  },
  tags: [{ name: "Customers" }, { name: "Payments" }],
  operations: [
    {
      id: "listCustomers",
      method: "get",
      path: "/customers",
      summary: "List customers",
      deprecated: false,
      tags: ["Customers"],
      parameters: [{ name: "limit", in: "query", required: false, schema: { type: ["integer"] } }],
      responses: [
        {
          status: "200",
          description: "OK",
          content: {
            "application/json": {
              schema: { type: ["array"], items: { ref: "Customer" } },
              examples: [{ name: "ok", value: [{ id: "cus_1" }] }],
            },
          },
        },
      ],
      security: [{ bearer: [] }],
    },
    {
      id: "createCharge",
      method: "post",
      path: "/charges",
      summary: "Create a charge",
      deprecated: true,
      tags: ["Payments"],
      parameters: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: ["object"],
              properties: {
                amount: { type: ["integer"] },
                cvc: { type: ["string"], writeOnly: true },
                id: { type: ["string"], readOnly: true },
              },
              example: { amount: 4200 },
            },
          },
        },
      },
      responses: [{ status: "402", description: "Payment required" }],
      codeSamples: [{ lang: "curl", label: "cURL", source: "AUTHORED CURL" }],
    },
  ],
  schemas: {
    Customer: { type: ["object"], properties: { id: { type: ["string"], readOnly: true } } },
  },
};

const site: ShellSite = { name: "Payments", nav: [] };
const listOp = spec.operations[0] as Operation;
const chargeOp = spec.operations[1] as Operation;

describe("reference nav", () => {
  it("groups operations by tag in spec order and marks the active one", () => {
    const groups = referenceGroups(spec);
    expect(groups.map((g) => g.tag)).toEqual(["Customers", "Payments"]);
    const nav = renderApiNav(spec, "listCustomers");
    expect(nav).toContain("Customers");
    expect(nav).toContain('href="#listCustomers"'); // in-page anchor (continuous page)
    expect(nav).toContain("is-active");
    expect(nav).toContain("rs-method--get");
  });

  it("derives a stable anchor and a cross-page path from the operation id", () => {
    expect(operationAnchor(chargeOp)).toBe("#createCharge");
    expect(operationPath(chargeOp)).toBe("/api-reference/createCharge");
    expect(operationPath(chargeOp, { basePath: "/ref" })).toBe("/ref/createCharge");
  });
});

describe("renderOperation", () => {
  it("renders the method, path, parameters, and responses with badges", () => {
    const html = renderOperation(listOp, spec);
    expect(html).toContain("rs-method--get");
    expect(html).toContain("/customers");
    expect(html).toContain("limit"); // parameter
    expect(html).toContain("rs-status--ok"); // 200 badge
    expect(html).toContain("bearer"); // auth doc
    expect(html).toContain("HTTP bearer");
  });

  it("shows a deprecated banner and honors readOnly/writeOnly per role", () => {
    const html = renderOperation(chargeOp, spec);
    expect(html).toContain("rs-op__deprecated");
    // request body shows writeOnly (cvc), omits readOnly (id)
    expect(html).toContain("cvc");
    expect(html).toContain("amount");
    expect(html).toContain("rs-status--client"); // 402
  });
});

describe("code samples", () => {
  it("builds curl/js/python from the HAR seed; curl matches the request", () => {
    const samples = operationSamples(listOp, "https://api.example.com");
    const langs = samples.map((s) => s.lang);
    expect(langs).toContain("curl");
    expect(langs).toContain("javascript");
    expect(langs).toContain("python");
    const curl = samples.find((s) => s.lang === "curl");
    expect(curl?.source).toContain("https://api.example.com/customers");
  });

  it("lets authored x-codeSamples override the generated language", () => {
    const samples = operationSamples(chargeOp, "https://api.example.com");
    const curl = samples.find((s) => s.lang === "curl");
    expect(curl?.source).toBe("AUTHORED CURL");
    // the POST curl for a generated language still reflects the body
    const python = samples.find((s) => s.lang === "python");
    expect(python?.source).toContain("requests.post");
  });

  it("renders samples as a CodeGroup island", () => {
    const html = renderCodeSamples(operationSamples(chargeOp, "https://api.example.com"));
    expect(html).toContain('data-island="CodeGroup"');
    expect(html).toContain('data-rs-group="rs-api-lang"');
    expect(html).toContain("rs-code__lang");
  });
});

describe("renderOperationConsole", () => {
  it("renders a dark console with a request line and code-sample island", () => {
    const html = renderOperationConsole(listOp, spec);
    expect(html).toContain("rs-console");
    expect(html).toContain("rs-console__reqline");
    expect(html).toContain('data-island="CodeGroup"');
    expect(html).toContain("cus_1"); // response example in the console
    expect(html).toContain("rs-console__status"); // 200 readout
    expect(html).toContain('data-island="Playground"'); // the interactive Try-It form
    expect(html).toContain("data-rs-pf-curl"); // its live curl
  });
});

describe("renderReferenceBody", () => {
  it("renders one continuous page: chrome, nav, intro, and every operation", () => {
    const html = renderReferenceBody(site, spec);
    expect(html).toContain("rs-header"); // reused shell header
    expect(html).toContain("rs-apinav"); // left nav
    expect(html).toContain('id="rs-content"'); // main
    expect(html).toContain("data-rs-apiref"); // scroll-spy hook
    expect(html).toContain("rs-apiintro"); // front-door overview
    expect(html).toContain("rs-apigroup__title"); // tag section headers in the flow
    expect(html).toContain('id="listCustomers"'); // both operations as sections
    expect(html).toContain('id="createCharge"');
    expect(html).toContain("rs-console"); // per-operation console
    expect(html).toContain("data-rs-palette"); // reused command palette
  });

  it("is deterministic", () => {
    expect(renderReferenceBody(site, spec)).toBe(renderReferenceBody(site, spec));
  });
});
