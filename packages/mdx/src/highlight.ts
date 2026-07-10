import type { Diagnostic } from "@readsmith/model";
import { type ShikiTransformer, type ThemeRegistrationAny, codeToHtml } from "shiki";

export interface HighlightOptions {
  /** Light and dark themes (Shiki bundled theme names, or theme objects). Dual themes render once, with CSS variables. */
  themes?: { light: string | ThemeRegistrationAny; dark: string | ThemeRegistrationAny };
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

/*
 * The "assay" syntax palette: five roles per mode, nothing else. Plain code is
 * ink, keywords recede to gray, strings carry the teal, types/functions/numbers
 * carry the gold, comments are faint. A restrained palette is what makes code
 * read as typeset rather than decorated; the two hues echo the product's accent
 * (teal links) and hallmark (gold marking), so code belongs to the same page.
 */
function assayTheme(
  mode: "light" | "dark",
  c: { fg: string; bg: string; comment: string; keyword: string; string: string; gold: string },
): ThemeRegistrationAny {
  return {
    name: `assay-${mode}`,
    type: mode,
    colors: { "editor.background": c.bg, "editor.foreground": c.fg },
    settings: [
      { settings: { foreground: c.fg, background: c.bg } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.comment } },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "keyword.operator",
          "entity.other.attribute-name",
          "punctuation.definition.tag",
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "punctuation.definition.string",
          "constant.other.symbol",
          "string.regexp",
          "markup.inline.raw",
        ],
        settings: { foreground: c.string },
      },
      {
        scope: [
          "entity.name.function",
          "entity.name.type",
          "entity.name.class",
          "entity.name.tag",
          "entity.name.namespace",
          "support.function",
          "support.class",
          "support.type",
          "support.type.property-name",
          "constant.numeric",
          "constant.language",
          "constant.character",
          "variable.other.constant",
          "markup.heading",
        ],
        settings: { foreground: c.gold },
      },
    ],
  };
}

const ASSAY_LIGHT = assayTheme("light", {
  fg: "#24262b",
  bg: "#ffffff",
  comment: "#9a958a",
  keyword: "#6a7077",
  string: "#0c6e6e",
  gold: "#8a6a1e",
});

const ASSAY_DARK = assayTheme("dark", {
  fg: "#e4e2dc",
  bg: "#0c0c0c",
  comment: "#67645c",
  keyword: "#99958c",
  string: "#7ccfc4",
  gold: "#d8a24a",
});

const DEFAULT_THEMES = { light: ASSAY_LIGHT, dark: ASSAY_DARK };
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
