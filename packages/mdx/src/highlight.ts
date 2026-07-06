import type { Diagnostic } from "@readsmith/model";
import { type ShikiTransformer, codeToHtml } from "shiki";

export interface HighlightOptions {
  /** Light and dark theme names (Shiki bundled themes). Dual themes render once, with CSS variables. */
  themes?: { light: string; dark: string };
}

export interface HighlightInput {
  code: string;
  /** Language id; unknown or missing languages fall back to plain text. */
  lang?: string;
  /** The code fence meta string, for example `{1,3-5} title="x.js"`. */
  meta?: string;
}

export interface HighlightResult {
  html: string;
  /** The language actually used (may be "text" after a fallback). */
  lang: string;
  diagnostics: Diagnostic[];
}

const DEFAULT_THEMES = { light: "github-light", dark: "github-dark" } as const;
const PLAIN = new Set(["", "text", "txt", "plain", "plaintext"]);

/**
 * P5: highlight one code block to static, dual-theme HTML. Content is escaped by
 * Shiki, so code can never inject markup. An unknown language falls back to plain
 * text with a diagnostic; nothing throws.
 */
export async function highlightCode(
  input: HighlightInput,
  options?: HighlightOptions,
): Promise<HighlightResult> {
  const themes = options?.themes ?? DEFAULT_THEMES;
  const diagnostics: Diagnostic[] = [];

  const { lines, invalid } = parseLineHighlights(input.meta);
  for (const token of invalid) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-line-range",
      message: `Invalid line highlight "${token}".`,
      source: "code",
    });
  }

  const transformers: ShikiTransformer[] = [lineHighlightTransformer(lines)];
  const requested = (input.lang ?? "").toLowerCase();
  const lang = PLAIN.has(requested) ? "text" : requested;

  try {
    const html = await codeToHtml(input.code, { lang, themes, transformers });
    return { html, lang, diagnostics };
  } catch {
    diagnostics.push({
      severity: "warning",
      code: "unknown-language",
      message: `Unknown code language "${input.lang}"; rendered as plain text.`,
      source: "code",
    });
    const html = await codeToHtml(input.code, { lang: "text", themes, transformers });
    return { html, lang: "text", diagnostics };
  }
}

export function parseLineHighlights(meta?: string): { lines: Set<number>; invalid: string[] } {
  const lines = new Set<number>();
  const invalid: string[] = [];
  if (!meta) return { lines, invalid };

  const braces = meta.match(/\{([^}]*)\}/);
  const inner = braces?.[1];
  if (!inner) return { lines, invalid };

  for (const token of inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start >= 1 && end >= start) {
        for (let i = start; i <= end; i++) lines.add(i);
      } else {
        invalid.push(token);
      }
    } else if (/^\d+$/.test(token)) {
      lines.add(Number(token));
    } else {
      invalid.push(token);
    }
  }

  return { lines, invalid };
}

function lineHighlightTransformer(lines: Set<number>): ShikiTransformer {
  return {
    name: "readsmith:line-highlight",
    line(node, lineNumber) {
      if (!lines.has(lineNumber)) return;
      const cls = node.properties.class;
      if (Array.isArray(cls)) cls.push("highlighted");
      else if (typeof cls === "string") node.properties.class = `${cls} highlighted`;
      else node.properties.class = "highlighted";
    },
  };
}
