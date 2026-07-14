import { isExecError } from "@readsmith/exec";
import type { NormalizedSpec, Server } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { execServiceForBundle, resolveServerUrl } from "../src/exec.js";
import type { Bundle } from "../src/site.js";

describe("resolveServerUrl (resolve-defaults)", () => {
  it("substitutes each variable's default", () => {
    const server: Server = {
      url: "https://{region}.api.example.com/{ver}",
      variables: { region: { default: "us" }, ver: { default: "v1" } },
    };
    expect(resolveServerUrl(server)).toBe("https://us.api.example.com/v1");
  });

  it("passes a plain URL through", () => {
    expect(resolveServerUrl({ url: "https://api.example.com" })).toBe("https://api.example.com");
  });
});

function bundleWithServers(servers: Server[]): Bundle {
  const spec = { servers } as unknown as NormalizedSpec;
  return {
    site: {} as Bundle["site"],
    apiReference: { spec, path: "/api-reference", label: "API" },
  };
}

describe("execServiceForBundle", () => {
  it("is disabled for a docs-only site (no api reference)", () => {
    expect(execServiceForBundle(null).enabled).toBe(false);
    expect(execServiceForBundle({ site: {} as Bundle["site"], apiReference: null }).enabled).toBe(
      false,
    );
  });

  it("is enabled and allowlists the resolved server, denying anything else", async () => {
    const svc = execServiceForBundle(
      bundleWithServers([
        { url: "https://{region}.api.example.com", variables: { region: { default: "us" } } },
      ]),
    );
    expect(svc.enabled).toBe(true);
    // Off the allowlist -> denied without any network.
    const denied = await svc.run({ method: "GET", url: "https://evil.com/" });
    expect(isExecError(denied) && denied.code).toBe("DENIED_NOT_ALLOWLISTED");
  });
});
