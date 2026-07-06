import type { Diagnostic, Position } from "@readsmith/model";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

/** Guard against pathological inputs (a ref bomb or a giant file). */
const MAX_CHARS = 5_000_000;
const BOM = 0xfeff;

const mdxProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkMdx);
const mdProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

export interface ParseInput {
  /** File path, used as the diagnostic source and to infer kind when omitted. */
  path: string;
  raw: string;
  /** Inferred from the path extension when omitted: `.mdx` is MDX, everything else is Markdown. */
  kind?: "md" | "mdx";
}

export interface ParsedPage {
  path: string;
  frontmatter: Record<string, unknown>;
  body: Root;
  diagnostics: Diagnostic[];
}

/**
 * P1 Parse: normalize input, split frontmatter, and parse the body to an AST.
 * `.mdx` is parsed as MDX (JSX plus expressions); `.md` as CommonMark plus GFM
 * (a `<` is literal HTML, not a component). Never throws: parse and frontmatter
 * failures become positioned diagnostics with a best-effort (possibly empty) AST.
 */
export function parse(input: ParseInput): ParsedPage {
  const kind = input.kind ?? (input.path.toLowerCase().endsWith(".mdx") ? "mdx" : "md");
  const raw = normalize(input.raw);
  const diagnostics: Diagnostic[] = [];

  if (raw.length > MAX_CHARS) {
    diagnostics.push({
      severity: "error",
      code: "file-too-large",
      message: `File exceeds the ${MAX_CHARS} character parse limit.`,
      source: input.path,
    });
    return { path: input.path, frontmatter: {}, body: emptyRoot(), diagnostics };
  }

  let body: Root;
  try {
    body = (kind === "mdx" ? mdxProcessor : mdProcessor).parse(raw) as Root;
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: kind === "mdx" ? "mdx-parse" : "md-parse",
      message: (err as Error).message,
      pos: errorPosition(err),
      source: input.path,
    });
    return { path: input.path, frontmatter: {}, body: emptyRoot(), diagnostics };
  }

  const frontmatter = extractFrontmatter(body, input.path, diagnostics);
  return { path: input.path, frontmatter, body, diagnostics };
}

/** Strip a UTF-8 BOM and normalize CRLF and lone CR to LF, for cross-OS stable positions. */
function normalize(raw: string): string {
  const noBom = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  return noBom.replace(/\r\n?/g, "\n");
}

function emptyRoot(): Root {
  return { type: "root", children: [] };
}

/**
 * Pull the leading YAML frontmatter node out of the tree, parse it, and return
 * the object. Removes the node from the body so the body is content only. An
 * empty or absent frontmatter yields {}; malformed YAML yields a diagnostic.
 */
function extractFrontmatter(
  body: Root,
  path: string,
  diagnostics: Diagnostic[],
): Record<string, unknown> {
  const yamlNode = body.children.find((n) => n.type === "yaml") as
    | { value?: string; position?: { start?: { line: number; column: number } } }
    | undefined;
  if (!yamlNode) return {};

  body.children = body.children.filter((n) => n !== (yamlNode as unknown));

  try {
    const parsed = parseYaml(yamlNode.value ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "frontmatter-parse",
      message: `Invalid frontmatter: ${(err as Error).message}`,
      pos: pointToPosition(yamlNode.position?.start),
      source: path,
    });
    return {};
  }
}

function errorPosition(err: unknown): Position | undefined {
  const e = err as { line?: number; column?: number; place?: { line?: number; column?: number } };
  const line = e.line ?? e.place?.line;
  const column = e.column ?? e.place?.column;
  if (typeof line === "number" && typeof column === "number") return { line, col: column };
  return undefined;
}

function pointToPosition(point?: { line: number; column: number }): Position | undefined {
  if (!point) return undefined;
  return { line: point.line, col: point.column };
}
