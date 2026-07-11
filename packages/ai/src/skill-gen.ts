import { generateText } from "ai";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ModelProvider } from "./provider.js";

/**
 * The skill generator (spec agent-skills SK-30..SK-36): a bounded map/reduce/
 * verify loop over the BUILT bundle that writes one SKILL.md following the
 * template the research validated. This never runs inside a build; the command
 * layer invokes it offline on the operator's own key, and the output enters the
 * site through git like any other content change.
 *
 * Shape of the loop:
 * - map: token-budgeted page batches, one extraction call each (facts, gotchas,
 *   procedures, decision points, all with source URLs)
 * - reduce: one synthesis call that sees ONLY the extracted material, never the
 *   raw pages, which is the main defense against invented endpoints
 * - verify: mechanical gates first (frontmatter, links against the real URL
 *   set, budgets), then one traceability call; any failure loops back through
 *   exactly one repair round, then the gates decide
 */

export interface SkillGenPage {
  url: string;
  title: string;
  description?: string;
  rawMd: string;
}

export interface SkillGenSite {
  name: string;
  description?: string;
  url?: string;
}

export interface SkillGenInput {
  site: SkillGenSite;
  /** Visible pages only (no hidden, no pages-mode mirrors). */
  pages: SkillGenPage[];
  /** The spec-valid skill name (the fallback's name; write target must match). */
  name: string;
  /** Deterministic hash of these inputs; stamped as `readsmith-generated`. */
  inputHash: string;
}

export interface SkillGenOptions {
  /** Approximate character budget per map batch (default 48000, ~12k tokens). */
  batchChars?: number;
  logger?: { info(message: string): void };
}

export interface SkillGenResult {
  /** The final SKILL.md, frontmatter re-stamped deterministically. */
  content: string;
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  repaired: boolean;
}

/** Every quality-gate failure, so the operator sees the full list at once. */
export class SkillGenError extends Error {
  readonly failures: string[];
  /** The failing draft, for diagnosis; never written anywhere. */
  readonly draft?: string;
  constructor(failures: string[], draft?: string) {
    super(`Generated skill failed quality gates:\n- ${failures.join("\n- ")}`);
    this.name = "SkillGenError";
    this.failures = failures;
    this.draft = draft;
  }
}

const extractionSchema = z.object({
  facts: z.array(z.object({ fact: z.string(), url: z.string() })).default([]),
  gotchas: z.array(z.object({ gotcha: z.string(), url: z.string() })).default([]),
  procedures: z
    .array(z.object({ task: z.string(), steps: z.array(z.string()), url: z.string() }))
    .default([]),
  decisions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.object({ option: z.string(), when: z.string() })),
        url: z.string(),
      }),
    )
    .default([]),
});

type Extraction = z.infer<typeof extractionSchema>;

const SKILL_LINE_MAX = 500;
/** ~5000 tokens at 4 chars/token, the agentskills "instructions" budget. */
const SKILL_CHAR_MAX = 20000;
const DESCRIPTION_MAX = 1024;

/** Group pages into batches under the character budget (one page minimum). */
function batchPages(pages: SkillGenPage[], batchChars: number): SkillGenPage[][] {
  const batches: SkillGenPage[][] = [];
  let current: SkillGenPage[] = [];
  let size = 0;
  for (const page of pages) {
    const cost = page.rawMd.length + 200;
    if (current.length > 0 && size + cost > batchChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Strip one wrapping code fence of any label; models fence replies anyway. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-z]*\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/**
 * The reduce/repair reply contract: a `Description:` first line, a blank line,
 * then the markdown body. The model never writes YAML; the generator composes
 * the frontmatter itself (a serializer never mis-quotes a colon, a small model
 * regularly does).
 */
function parseDocReply(text: string): { description: string; body: string } | null {
  const match = /^Description:\s*(.+?)\r?\n\r?\n([\s\S]+)$/.exec(stripFence(text));
  if (!match || !match[1] || !match[2]) return null;
  return { description: match[1].trim(), body: match[2].trim() };
}

/** Compose the final document: our frontmatter, the model's body. */
function composeSkill(input: SkillGenInput, description: string, body: string): string {
  const frontmatter = {
    name: input.name,
    description,
    metadata: {
      "readsmith-proj": input.name,
      version: "1.0",
      "readsmith-generated": input.inputHash,
    },
  };
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Parse a model reply as JSON, tolerating a fenced code block around it. */
function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const raw = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapPrompt(batch: SkillGenPage[]): string {
  const docs = batch
    .map((p) => `<page url="${p.url}" title="${p.title}">\n${p.rawMd}\n</page>`)
    .join("\n\n");
  return [
    "You are extracting material for an agent skill from documentation pages.",
    "From the pages below, extract ONLY what is stated (never infer or invent):",
    '- "facts": hard technical facts an agent needs (base URLs, auth headers and schemes, parameter names with types and constraints, limits, defaults, environment variables, commands)',
    '- "gotchas": every warning, caveat, or "note that" style footgun, phrased as the concrete failure',
    '- "procedures": step-by-step task sequences (task name plus ordered steps)',
    '- "decisions": places where the docs present alternatives (question, each option, and when to pick it)',
    'Attach to every item the "url" of the page it came from, exactly as given.',
    "Reply with ONLY a JSON object of shape:",
    '{"facts":[{"fact":"...","url":"..."}],"gotchas":[{"gotcha":"...","url":"..."}],"procedures":[{"task":"...","steps":["..."],"url":"..."}],"decisions":[{"question":"...","options":[{"option":"...","when":"..."}],"url":"..."}]}',
    "",
    docs,
  ].join("\n");
}

const REPLY_FORMAT = [
  "Reply in EXACTLY this format, with no code fences and no YAML frontmatter:",
  'Line 1: `Description: ` followed by one sentence of what the product does, then "Use when ..." trigger conditions with specific keywords (under 900 characters total).',
  "Line 2: blank.",
  "Line 3 onward: the complete markdown document, starting with the `# <title>` heading.",
].join("\n");

function reducePrompt(input: SkillGenInput, merged: Extraction): string {
  const siteBase = input.site.url?.replace(/\/+$/, "");
  const urls = input.pages
    .map((p) => (siteBase ? `${siteBase}${p.url === "/" ? "" : p.url}` : p.url))
    .join("\n");
  return [
    `Write the body of an agent skill for "${input.site.name}" (Agent Skills format, agentskills.io).`,
    "Use ONLY the extracted material below. Never invent endpoints, parameters, or facts.",
    siteBase
      ? `The documentation site itself lives at ${siteBase} (do NOT confuse it with any API base URL the docs describe).`
      : "",
    "",
    "Document structure, exactly in this order:",
    "`# <title>` heading, then these sections:",
    "   ## Product summary - one dense paragraph: what the product is, the primary docs URL, the two or three load-bearing technical facts",
    "   ## When to use - bulleted trigger conditions",
    "   ## Quick reference - markdown tables of hard facts only (URLs, auth, key parameters, limits); no prose restating the docs",
    "   ## Decision guidance - one table per extracted decision (omit the section if there are none)",
    "   ## Workflow - numbered procedures for the top tasks",
    "   ## Common gotchas - one bullet per gotcha, each stating the concrete failure",
    "   ## Verification checklist - `- [ ]` items an agent checks before declaring success",
    "   ## Resources - deep links into the docs; end with the llms.txt pointer",
    "",
    `Budgets: at most ${SKILL_LINE_MAX - 20} lines and roughly 4000 tokens. Dense beats long.`,
    "Link ONLY to these documentation URLs, EXACTLY as written (plus the llms.txt on the same host):",
    urls,
    "",
    "Extracted material:",
    JSON.stringify(merged),
    "",
    REPLY_FORMAT,
  ].join("\n");
}

function verifyPrompt(draft: string, merged: Extraction): string {
  return [
    "You are verifying a generated SKILL.md against the material it was built from.",
    "List every factual claim in the draft (endpoints, parameters, limits, commands, auth details) that is NOT traceable to the extracted material below.",
    'Reply with ONLY a JSON object: {"problems": ["..."]} (empty array when everything traces).',
    "",
    "Draft:",
    draft,
    "",
    "Extracted material:",
    JSON.stringify(merged),
  ].join("\n");
}

function repairPrompt(description: string, body: string, failures: string[]): string {
  return [
    "This agent-skill draft failed quality gates. Fix every problem listed. Keep everything else unchanged, and keep the COMPLETE document (every section).",
    "",
    "Problems:",
    ...failures.map((f) => `- ${f}`),
    "",
    "Current description:",
    description,
    "",
    "Current document:",
    body,
    "",
    REPLY_FORMAT,
  ].join("\n");
}

interface ParsedDraft {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseDraft(content: string): ParsedDraft | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content.trim());
  if (!match || typeof match[1] !== "string") return null;
  try {
    const fm: unknown = parseYaml(match[1]);
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) return null;
    return {
      frontmatter: fm as Record<string, unknown>,
      body: content.trim().slice(match[0].length),
    };
  } catch {
    return null;
  }
}

/** The mechanical gates (SK-35). Returns human-readable failures, empty = pass. */
export function skillGates(content: string, input: SkillGenInput): string[] {
  const failures: string[] = [];
  if (!/^---\r?\n/.test(content.trim())) {
    return ['The file must start with a "---" YAML frontmatter block.'];
  }
  const draft = parseDraft(content);
  if (!draft) {
    return [
      "The frontmatter YAML failed to parse. A common cause is an unquoted colon; wrap the description value in double quotes.",
    ];
  }
  const { frontmatter } = draft;
  if (frontmatter.name !== input.name) {
    failures.push(`Frontmatter name must be exactly "${input.name}".`);
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.length === 0) {
    failures.push("Frontmatter must carry a non-empty description.");
  } else {
    if (description.length > DESCRIPTION_MAX) {
      failures.push(`The description exceeds ${DESCRIPTION_MAX} characters.`);
    }
    if (!/use when/i.test(description)) {
      failures.push('The description must contain a "Use when ..." trigger phrase.');
    }
  }
  const lines = content.split("\n").length;
  if (lines > SKILL_LINE_MAX) failures.push(`The file has ${lines} lines (max ${SKILL_LINE_MAX}).`);
  if (content.length > SKILL_CHAR_MAX) {
    failures.push(`The file has ${content.length} characters (max ${SKILL_CHAR_MAX}).`);
  }

  // Every internal link must resolve to a page the site actually serves.
  const valid = new Set<string>(["/", "/llms.txt"]);
  const siteBase = input.site.url?.replace(/\/+$/, "");
  for (const page of input.pages) {
    valid.add(page.url);
    if (siteBase) valid.add(`${siteBase}${page.url === "/" ? "" : page.url}`);
  }
  if (siteBase) {
    valid.add(siteBase);
    valid.add(`${siteBase}/llms.txt`);
  }
  const pagePaths = new Set<string>(["/", "/llms.txt", ...input.pages.map((p) => p.url)]);
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (match[1] ?? "").replace(/[#?].*$/, "");
    if (!target || valid.has(target)) continue;
    if (target.startsWith("/") || (siteBase ? target.startsWith(siteBase) : false)) {
      failures.push(`Link target "${target}" is not a page this site serves.`);
      continue;
    }
    // A docs path reached through some other host (a model conflating the
    // documented API's base URL with the docs site) is a broken link too.
    if (siteBase && /^https?:\/\//.test(target)) {
      try {
        const path = new URL(target).pathname.replace(/\/+$/, "") || "/";
        if (pagePaths.has(path)) {
          failures.push(
            `Link target "${target}" points at a docs page through the wrong host; use ${siteBase}${path === "/" ? "" : path}.`,
          );
        }
      } catch {
        // not a parseable URL: leave external strings alone
      }
    }
  }
  return failures;
}

/** Run the bounded generation loop. Throws SkillGenError when the gates lose. */
export async function generateSkill(
  input: SkillGenInput,
  provider: ModelProvider,
  options: SkillGenOptions = {},
): Promise<SkillGenResult> {
  const model = provider.chat(); // throws with the exact missing-key remedy
  const log = options.logger ?? { info: () => {} };
  const usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;

  const ask = async (prompt: string): Promise<string> => {
    calls += 1;
    const result = await generateText({ model, prompt, temperature: 0, maxRetries: 2 });
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    return result.text;
  };

  // Map: extract from every batch, a few in flight at once (batches are
  // independent; results merge in batch order, so concurrency cannot reorder
  // the output). One retry per malformed reply, then fail.
  const batches = batchPages(input.pages, options.batchChars ?? 48000);
  log.info(`extracting from ${input.pages.length} page(s) in ${batches.length} batch(es)`);
  const extractBatch = async (batch: SkillGenPage[]): Promise<Extraction> => {
    let parsed = extractionSchema.safeParse(parseJsonReply(await ask(mapPrompt(batch))));
    if (!parsed.success) {
      parsed = extractionSchema.safeParse(parseJsonReply(await ask(mapPrompt(batch))));
    }
    if (!parsed.success) {
      throw new SkillGenError([
        `Extraction returned malformed JSON twice for the batch starting at "${batch[0]?.url}".`,
      ]);
    }
    return parsed.data;
  };
  const results = new Array<Extraction>(batches.length);
  const concurrency = Math.min(4, batches.length);
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextBatch < batches.length) {
        const index = nextBatch;
        nextBatch += 1;
        const batch = batches[index];
        if (batch) results[index] = await extractBatch(batch);
      }
    }),
  );
  const merged: Extraction = { facts: [], gotchas: [], procedures: [], decisions: [] };
  for (const result of results) {
    if (!result) continue;
    merged.facts.push(...result.facts);
    merged.gotchas.push(...result.gotchas);
    merged.procedures.push(...result.procedures);
    merged.decisions.push(...result.decisions);
  }
  log.info(
    `extracted ${merged.facts.length} fact(s), ${merged.gotchas.length} gotcha(s), ${merged.procedures.length} procedure(s), ${merged.decisions.length} decision(s)`,
  );

  // Reduce: synthesize from the extraction only. The generator composes the
  // frontmatter itself, so a malformed reply is a format failure, not a YAML one.
  const reply = parseDocReply(await ask(reducePrompt(input, merged)));
  let doc = reply ?? { description: "", body: "" };
  let content = reply ? composeSkill(input, doc.description, doc.body) : "";
  let failures = reply
    ? skillGates(content, input)
    : [
        "The reply was not in the required format (a `Description:` line, a blank line, then the document).",
      ];

  // Verify: the traceability pass only runs on a mechanically sound draft.
  if (failures.length === 0) {
    const verdict = parseJsonReply(await ask(verifyPrompt(content, merged)));
    const problems = z
      .object({ problems: z.array(z.string()).default([]) })
      .safeParse(verdict ?? {});
    if (problems.success) failures = problems.data.problems;
  }

  // Repair: exactly one round, then the mechanical gates decide.
  let repaired = false;
  if (failures.length > 0) {
    log.info(`repairing ${failures.length} problem(s): ${failures.join(" | ")}`);
    repaired = true;
    const fixed = parseDocReply(await ask(repairPrompt(doc.description, doc.body, failures)));
    if (!fixed) {
      throw new SkillGenError(["The repair reply was not in the required format."]);
    }
    doc = fixed;
    content = composeSkill(input, doc.description, doc.body);
    const final = skillGates(content, input);
    if (final.length > 0) throw new SkillGenError(final, content);
  }

  return { content, calls, usage, repaired };
}
