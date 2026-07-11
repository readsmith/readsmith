import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  ModelNotConfiguredError,
  SkillGenError,
  type SkillGenInput,
  createMockProvider,
  generateSkill,
  skillGates,
} from "../src/index.js";

const input: SkillGenInput = {
  site: { name: "Pets API", description: "The pets docs.", url: "https://pets.dev" },
  pages: [
    { url: "/", title: "Home", rawMd: "# Home\n\nWelcome to Pets." },
    { url: "/auth", title: "Auth", rawMd: "# Auth\n\nUse the X-Key header. Never share it." },
  ],
  name: "pets-api",
  inputHash: "hash123",
};

const EXTRACTION = JSON.stringify({
  facts: [{ fact: "Auth uses the X-Key header", url: "/auth" }],
  gotchas: [{ gotcha: "Sharing the key leaks access", url: "/auth" }],
  procedures: [{ task: "Authenticate", steps: ["Get a key", "Send X-Key"], url: "/auth" }],
  decisions: [],
});

// What the model replies with (the Description-line contract; no YAML).
const REDUCE_REPLY = [
  "Description: Pets API docs. Use when integrating pets, auth, or the X-Key header.",
  "",
  "# Pets API Skill",
  "",
  "## Product summary",
  "Pets API, documented at [Auth](/auth).",
  "",
  "## Common gotchas",
  "- Sharing the key leaks access.",
  "",
  "## Resources",
  "- [Auth](https://pets.dev/auth)",
  "- [Index](/llms.txt)",
].join("\n");

const BAD_LINK_REPLY = REDUCE_REPLY.replace("(/auth)", "(/ghost)");

// A fully composed document (what composeSkill emits), for gating directly.
const GOOD_DRAFT = [
  "---",
  "name: pets-api",
  "description: Pets API docs. Use when integrating pets, auth, or the X-Key header.",
  "metadata:",
  "  readsmith-proj: pets-api",
  '  version: "1.0"',
  "---",
  "",
  "# Pets API Skill",
  "",
  "## Product summary",
  "Pets API, documented at [Auth](/auth).",
  "",
  "## Common gotchas",
  "- Sharing the key leaks access.",
  "",
  "## Resources",
  "- [Auth](https://pets.dev/auth)",
  "- [Index](/llms.txt)",
].join("\n");

const BAD_LINK_DRAFT = GOOD_DRAFT.replace("(/auth)", "(/ghost)");

/** A chat model that replies with `answers` in call order. */
function scripted(answers: string[]): LanguageModel {
  type MockOpts = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
  let call = 0;
  const options = {
    provider: "mock",
    modelId: "mock-chat",
    doGenerate: async () => {
      const text = answers[call] ?? "";
      call += 1;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      };
    },
  };
  return new MockLanguageModelV4(options as unknown as MockOpts) as unknown as LanguageModel;
}

const providerOf = (answers: string[]) =>
  createMockProvider({ chatModel: scripted(answers), hasEmbedding: false });

// Spec agent-skills SK-30/SK-32/SK-33 (AC-5): the happy path.
describe("generateSkill", () => {
  it("runs map, reduce, verify and composes the frontmatter deterministically", async () => {
    const provider = providerOf([EXTRACTION, REDUCE_REPLY, '{"problems": []}']);
    const result = await generateSkill(input, provider);
    expect(result.calls).toBe(3);
    expect(result.repaired).toBe(false);
    expect(result.usage.outputTokens).toBe(15);
    expect(result.content).toContain("readsmith-generated: hash123");
    expect(result.content).toContain("readsmith-proj: pets-api");
    expect(result.content).toContain("## Common gotchas");
    expect(skillGates(result.content, input)).toEqual([]);
  });

  it("tolerates a reply wrapped in a code fence", async () => {
    const fenced = `\`\`\`markdown\n${REDUCE_REPLY}\n\`\`\``;
    const provider = providerOf([EXTRACTION, fenced, '{"problems": []}']);
    const result = await generateSkill(input, provider);
    expect(result.repaired).toBe(false);
    expect(result.content).toContain("name: pets-api");
    expect(result.content).not.toContain("```markdown");
  });

  it("composes YAML-safe frontmatter from a description full of colons", async () => {
    const tricky = REDUCE_REPLY.replace(
      "Description: Pets API docs.",
      "Description: Pets API: the store: everything.",
    );
    const provider = providerOf([EXTRACTION, tricky, '{"problems": []}']);
    const result = await generateSkill(input, provider);
    expect(skillGates(result.content, input)).toEqual([]);
    expect(result.content).toContain("Pets API: the store: everything.");
  });

  it("repairs a mechanically failing draft once, skipping the verify call", async () => {
    const provider = providerOf([EXTRACTION, BAD_LINK_REPLY, REDUCE_REPLY]);
    const result = await generateSkill(input, provider);
    expect(result.calls).toBe(3); // map, reduce, repair; no verify on a bad draft
    expect(result.repaired).toBe(true);
    expect(result.content).toContain("(/auth)");
  });

  it("treats a reply without the Description line as a repairable failure", async () => {
    const provider = providerOf([EXTRACTION, "# Just a document\n\nNo header.", REDUCE_REPLY]);
    const result = await generateSkill(input, provider);
    expect(result.calls).toBe(3);
    expect(result.repaired).toBe(true);
    expect(skillGates(result.content, input)).toEqual([]);
  });

  it("repairs verifier-flagged problems through the same single round", async () => {
    const provider = providerOf([
      EXTRACTION,
      REDUCE_REPLY,
      '{"problems": ["The rate limit table is not traceable."]}',
      REDUCE_REPLY,
    ]);
    const result = await generateSkill(input, provider);
    expect(result.calls).toBe(4);
    expect(result.repaired).toBe(true);
  });

  it("throws with every gate failure when the repair round also fails", async () => {
    const provider = providerOf([EXTRACTION, BAD_LINK_REPLY, BAD_LINK_REPLY]);
    await expect(generateSkill(input, provider)).rejects.toThrow(SkillGenError);
    await expect(
      generateSkill(input, providerOf([EXTRACTION, BAD_LINK_REPLY, BAD_LINK_REPLY])),
    ).rejects.toThrow(/\/ghost/);
  });

  it("retries a malformed extraction once, then fails hard", async () => {
    const ok = await generateSkill(
      input,
      providerOf(["not json", EXTRACTION, REDUCE_REPLY, '{"problems": []}']),
    );
    expect(ok.calls).toBe(4);

    await expect(generateSkill(input, providerOf(["nope", "still nope"]))).rejects.toThrow(
      /malformed JSON twice/,
    );
  });

  it("surfaces the provider's missing-model error before any call", async () => {
    const provider = createMockProvider({ hasChat: false, hasEmbedding: false });
    provider.chat = () => {
      throw new ModelNotConfiguredError("chat");
    };
    await expect(generateSkill(input, provider)).rejects.toThrow(ModelNotConfiguredError);
  });
});

// Spec agent-skills SK-35: the gates themselves.
describe("skillGates", () => {
  it("passes the good draft and catches name, trigger, and link violations", () => {
    expect(skillGates(GOOD_DRAFT, input)).toEqual([]);
    expect(skillGates(GOOD_DRAFT.replace("name: pets-api", "name: other"), input)).toMatchObject([
      expect.stringContaining('"pets-api"'),
    ]);
    expect(skillGates(GOOD_DRAFT.replace("Use when", "For"), input)).toMatchObject([
      expect.stringContaining("Use when"),
    ]);
    expect(skillGates(BAD_LINK_DRAFT, input)).toMatchObject([expect.stringContaining("/ghost")]);
    expect(skillGates("no frontmatter at all", input)).toHaveLength(1);
  });

  it("ignores external links and anchors on valid pages", () => {
    const draft = GOOD_DRAFT.replace(
      "- [Index](/llms.txt)",
      "- [Index](/llms.txt)\n- [GitHub](https://github.com/x/y)\n- [Anchor](/auth#keys)",
    );
    expect(skillGates(draft, input)).toEqual([]);
  });

  it("catches a docs page linked through the wrong host", () => {
    const draft = GOOD_DRAFT.replace("(https://pets.dev/auth)", "(http://127.0.0.1:7878/auth)");
    expect(skillGates(draft, input)).toMatchObject([expect.stringContaining("wrong host")]);
  });

  it("enforces the line budget", () => {
    const long = `${GOOD_DRAFT}\n${"filler\n".repeat(500)}`;
    expect(skillGates(long, input)).toMatchObject([expect.stringContaining("lines")]);
  });
});
