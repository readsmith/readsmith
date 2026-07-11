import { readFile } from "node:fs/promises";
import { h } from "hastscript";
import { describe, expect, it } from "vitest";
import {
  type AssembleInput,
  type AuthoredSkill,
  type SiteConfig,
  assembleSite,
} from "../src/assemble.js";
import type { ComponentRegistry } from "../src/render.js";

const registry: ComponentRegistry = {
  Callout: { render: ({ children }) => h("aside", { className: ["callout"] }, children) },
};

function inputOf(skills?: AuthoredSkill[], extra: Partial<AssembleInput> = {}): AssembleInput {
  const config: SiteConfig = {
    site: { name: "Pets API Docs", description: "Docs for the Pets API." },
    pages: [{ path: "index.md", slug: "" }],
    nav: [{ type: "page", slug: "" }],
  };
  return {
    config,
    readPage: () => "---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n",
    registry,
    skills,
    ...extra,
  };
}

function skill(
  dir: string | null,
  source: string,
  content: string,
  extras: [string, string][] = [],
): AuthoredSkill {
  return {
    dir,
    source,
    files: [{ path: "SKILL.md", content }, ...extras.map(([path, c]) => ({ path, content: c }))],
  };
}

const GOOD =
  "---\nname: pets\ndescription: Use when integrating the Pets API.\n---\n\n# Pets\n\nInstructions.\n";

// Spec agent-skills SK-1/SK-2/SK-4 (AC-2 build half): authored round-trip + validation.
describe("authored skills", () => {
  it("carries valid skills into the build verbatim, SKILL.md first, extras sorted", async () => {
    const build = await assembleSite(
      inputOf([
        skill("pets", ".readsmith/skills/pets", GOOD, [
          ["references/z.md", "Z"],
          ["references/a.md", "A"],
        ]),
      ]),
    );
    expect(build.skills).toHaveLength(1);
    const s = build.skills[0];
    expect(s?.name).toBe("pets");
    expect(s?.description).toBe("Use when integrating the Pets API.");
    expect(s?.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md", "references/z.md"]);
    expect(s?.files[0]?.content).toBe(GOOD);
    expect(build.diagnostics).toHaveLength(0);
  });

  it("drops invalid names with a diagnostic (uppercase, consecutive hyphens, dir mismatch)", async () => {
    const cases: [AuthoredSkill, string][] = [
      [skill("pets", "s/pets", "---\nname: Pets\ndescription: d\n---\n"), "skill-invalid-name"],
      [skill("a--b", "s/a--b", "---\nname: a--b\ndescription: d\n---\n"), "skill-invalid-name"],
      [skill("dir", "s/dir", "---\nname: other\ndescription: d\n---\n"), "skill-invalid-name"],
    ];
    for (const [authored, code] of cases) {
      const build = await assembleSite(inputOf([authored]));
      expect(build.diagnostics).toMatchObject([{ severity: "error", code }]);
      // The fallback fills in, so the surface never goes empty.
      expect(build.skills.map((s) => s.name)).toEqual(["pets-api-docs"]);
    }
  });

  it("drops overlong descriptions and missing or unparseable frontmatter", async () => {
    const long = "x".repeat(1025);
    const overlong = await assembleSite(
      inputOf([skill("pets", "s/pets", `---\nname: pets\ndescription: ${long}\n---\n`)]),
    );
    expect(overlong.diagnostics).toMatchObject([
      { severity: "error", code: "skill-invalid-description" },
    ]);

    const missing = await assembleSite(inputOf([skill("pets", "s/pets", "# No frontmatter\n")]));
    expect(missing.diagnostics).toMatchObject([{ severity: "error", code: "skill-frontmatter" }]);

    const noSkillMd = await assembleSite(
      inputOf([{ dir: "pets", source: "s/pets", files: [{ path: "notes.md", content: "x" }] }]),
    );
    expect(noSkillMd.diagnostics).toMatchObject([{ severity: "error", code: "skill-frontmatter" }]);
  });

  it("keeps the first of two same-named skills and diagnoses the duplicate", async () => {
    const build = await assembleSite(
      inputOf([
        skill(null, "skill.md", "---\nname: pets\ndescription: root\n---\n"),
        skill("pets", ".readsmith/skills/pets", GOOD),
      ]),
    );
    // Sorted by source: ".readsmith/skills/pets" precedes "skill.md".
    expect(build.skills.map((s) => s.name)).toEqual(["pets"]);
    expect(build.skills[0]?.description).toBe("Use when integrating the Pets API.");
    expect(build.diagnostics).toMatchObject([
      { severity: "error", code: "duplicate-skill", source: "skill.md" },
    ]);
  });

  it("names a frontmatter-less root skill.md after the site (Mintlify parity)", async () => {
    const build = await assembleSite(inputOf([skill(null, "skill.md", "# My own skill\n")]));
    expect(build.skills).toHaveLength(1);
    expect(build.skills[0]?.name).toBe("pets-api-docs");
    expect(build.skills[0]?.description).toBe("Docs for the Pets API.");
    expect(build.skills[0]?.files[0]?.content).toBe("# My own skill\n");
    expect(build.diagnostics).toHaveLength(0);
  });

  it("notes the .mintlify migration dir and drops oversized extra files", async () => {
    const big = "x".repeat(262145);
    const build = await assembleSite(
      inputOf([skill("pets", ".mintlify/skills/pets", GOOD, [["assets/big.txt", big]])]),
    );
    expect(build.skills[0]?.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(build.diagnostics).toMatchObject([
      { severity: "info", code: "skills-mintlify-dir" },
      { severity: "warning", code: "skill-file-too-large" },
    ]);
  });
});

// Spec agent-skills SK-3 (AC-3 build half): the mechanical fallback.
describe("fallback skill", () => {
  it("synthesizes a spec-valid fallback when no skills are authored", async () => {
    const build = await assembleSite(inputOf(undefined, { baseUrl: "https://pets.dev" }));
    expect(build.skills).toHaveLength(1);
    const s = build.skills[0];
    expect(s?.name).toBe("pets-api-docs");
    expect(s?.description).toContain("Use when working with Pets API Docs");
    const md = s?.files[0]?.content ?? "";
    expect(md).toContain("readsmith-generated: fallback");
    expect(md).toContain("[Home](https://pets.dev/)");
  });
});

// Spec agent-skills SK-4 / AC-6: skills participate in the deterministic hash.
describe("determinism", () => {
  it("hashes identically for identical skills and differently when one changes", async () => {
    const a = await assembleSite(inputOf([skill("pets", "s/pets", GOOD)]));
    const b = await assembleSite(inputOf([skill("pets", "s/pets", GOOD)]));
    const c = await assembleSite(inputOf([skill("pets", "s/pets", `${GOOD}\nMore.\n`)]));
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(JSON.stringify(a.skills)).toBe(JSON.stringify(b.skills));
    expect(c.bundleHash).not.toBe(a.bundleHash);
  });
});

// Spec agent-skills SK-36: the build path is AI-free. The generator lives in
// @readsmith/ai and only the offline command invokes it.
describe("determinism guard (SK-36)", () => {
  it("takes no AI dependency and builds identically with and without AI keys", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps).not.toContain("@readsmith/ai");

    const buildScript = new URL("../../../apps/web/scripts/build-content.mjs", import.meta.url);
    const source = await readFile(buildScript, "utf8");
    expect(source).not.toContain("@readsmith/ai");

    // Reflect.deleteProperty rather than assignment: setting a process.env key
    // to undefined coerces it to the string "undefined".
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-fake-for-test";
    try {
      const withKey = await assembleSite(inputOf([skill("pets", "s/pets", GOOD)]));
      Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      const withoutKey = await assembleSite(inputOf([skill("pets", "s/pets", GOOD)]));
      expect(withKey.bundleHash).toBe(withoutKey.bundleHash);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    }
  });
});

// Spec subpath-hosting AC-1: a site.url with a path prefixes every path once;
// absolute URLs use the origin.
describe("subpath hosting", () => {
  it("prefixes page, nav, and agent-output URLs exactly once", async () => {
    const input = inputOf(undefined, { baseUrl: "https://readsmith.dev/docs" });
    input.config = {
      ...input.config,
      site: { ...input.config.site, url: "https://readsmith.dev/docs" },
    };
    const build = await assembleSite(input);
    const home = build.pages.find((p) => p.slug === "");
    expect(home?.url).toBe("/docs");
    expect(build.llmsTxt).toContain("(https://readsmith.dev/docs)");
    expect(build.llmsTxt).not.toContain("/docs/docs");
    expect(build.sitemap).toContain("<loc>https://readsmith.dev/docs</loc>");
    const skillMd = build.skills[0]?.files[0]?.content ?? "";
    expect(skillMd).toContain("(https://readsmith.dev/docs)");
    expect(skillMd).not.toContain("/docs/docs");
  });

  it("leaves no-path sites unchanged", async () => {
    const build = await assembleSite(inputOf(undefined, { baseUrl: "https://pets.dev" }));
    expect(build.pages.find((p) => p.slug === "")?.url).toBe("/");
  });
});
