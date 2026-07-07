import SwaggerParser from "@apidevtools/swagger-parser";
import type { Diagnostic } from "@readsmith/model";
import { parse as parseYaml } from "yaml";

/**
 * Parse (YAML or JSON), sanity-check the version, and bundle external `$ref`s
 * into internal ones, leaving internal refs intact for the normalizer to resolve.
 * Parse-hardened against untrusted input (size cap, bundle timeout). Errors are
 * data: a bad spec yields diagnostics and a best-effort doc, never a throw.
 */

const MAX_BYTES = 5_000_000;
const BUNDLE_TIMEOUT_MS = 15_000;

export interface ParsedSpec {
  doc: Record<string, unknown> | null;
  version: string | null;
  diagnostics: Diagnostic[];
}

export interface ParseInput {
  raw: string;
  /** Optional path on disk; enables bundling external multi-file refs. */
  path?: string;
  source: string;
}

export async function parseAndBundle(input: ParseInput): Promise<ParsedSpec> {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string): void => {
    diagnostics.push({ severity: "error", code, message, source: input.source });
  };
  const warn = (code: string, message: string): void => {
    diagnostics.push({ severity: "warning", code, message, source: input.source });
  };

  if (input.raw.length > MAX_BYTES) {
    error("spec-too-large", `Spec exceeds the ${MAX_BYTES}-byte limit and was rejected.`);
    return { doc: null, version: null, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(input.raw);
  } catch (err) {
    error("parse-error", `Could not parse spec: ${(err as Error).message}`);
    return { doc: null, version: null, diagnostics };
  }

  const doc = asObject(parsed);
  if (!doc) {
    error("parse-error", "Spec did not parse to an object.");
    return { doc: null, version: null, diagnostics };
  }

  const version = typeof doc.openapi === "string" ? doc.openapi : null;
  if (version === null || !/^3\.(0|1)\./.test(version)) {
    warn("unsupported-version", `Expected OpenAPI 3.0 or 3.1; found ${version ?? "no version"}.`);
  }

  let bundled = doc;
  try {
    const target: unknown = input.path ?? structuredClone(doc);
    const bundle = SwaggerParser.bundle as (api: unknown) => Promise<unknown>;
    const result = await withTimeout(bundle(target), BUNDLE_TIMEOUT_MS);
    const bundledObj = asObject(result);
    if (bundledObj) bundled = bundledObj;
  } catch (err) {
    warn("bundle-failed", `External references were not bundled: ${(err as Error).message}`);
  }

  return { doc: bundled, version, diagnostics };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bundle timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
