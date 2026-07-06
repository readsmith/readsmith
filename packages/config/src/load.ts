import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Diagnostic } from "@readsmith/model";
import { parse as parseYaml } from "yaml";
import { type ConfigInput, configInputSchema } from "./schema.js";

const CONFIG_FILENAMES = ["docs.yaml", "docs.yml", "docs.json"];

export interface LoadedConfig {
  config: ConfigInput | null;
  file: string | null;
  diagnostics: Diagnostic[];
}

/**
 * Find and parse the site config in `root`. Returns `config: null` when no
 * config file exists (the caller then applies full defaults and auto-discovery).
 * Parse and validation failures become diagnostics rather than thrown errors.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
  const diagnostics: Diagnostic[] = [];

  for (const name of CONFIG_FILENAMES) {
    const path = join(root, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // not present, try the next candidate
    }

    let data: unknown;
    try {
      data = name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "config-parse",
        message: `Could not parse ${name}: ${(err as Error).message}`,
        source: name,
      });
      return { config: null, file: path, diagnostics };
    }

    const parsed = configInputSchema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        diagnostics.push({
          severity: "error",
          code: "config-invalid",
          message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          source: name,
        });
      }
      return { config: null, file: path, diagnostics };
    }

    return { config: parsed.data, file: path, diagnostics };
  }

  return { config: null, file: null, diagnostics };
}

/** Derive a default site name from the content directory name. */
export function defaultSiteName(root: string): string {
  const base = basename(root);
  return base && base !== "." ? base : "Docs";
}
