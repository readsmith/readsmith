import { resolveConfig } from "@readsmith/config";
import { type CompileSiteInput, type CompileSiteResult, compileSite } from "./compile.js";

/** One version's compiled bundle plus its routing identity. */
export interface CompiledVersion {
  id: string;
  /** Selector label; defaults to the id. */
  label: string;
  /** URL segment prefix: "" for the default version, else "/{id}". */
  prefix: string;
  /** True for the version served at the un-prefixed path. */
  isDefault: boolean;
  tag?: "latest" | "beta" | "deprecated";
  hidden: boolean;
  result: CompileSiteResult;
}

/** The multi-version compile output: one content-addressed bundle per version. */
export interface CompileVersionedResult {
  /** The default version's id (served at the un-prefixed path). Empty on a
   * single-version site with no `versions` block. */
  default: string;
  versions: CompiledVersion[];
}

/**
 * Compile every declared documentation version into its own content-addressed
 * bundle. Each version builds from its own content tree with its own URL prefix
 * ("" for the default, "/{id}" otherwise), so the bundles never share a hash or
 * a render-cache entry. A site with no `versions` block builds exactly one
 * bundle, byte-identical to a direct `compileSite`, under an implicit default.
 *
 * A shared `renderCache` is safe across versions: the cache key carries the base
 * path (and therefore the version prefix), so unchanged pages are reused while
 * distinct-prefix renders never collide.
 */
export async function compileVersionedSite(
  input: CompileSiteInput,
): Promise<CompileVersionedResult> {
  const config = await resolveConfig(input.contentDir);
  const declared = config.versions;

  if (!declared) {
    const result = await compileSite(input);
    return {
      default: "",
      versions: [
        { id: "", label: config.site.name, prefix: "", isDefault: true, hidden: false, result },
      ],
    };
  }

  const versions: CompiledVersion[] = [];
  // Config order is authored order and deterministic, so the fan-out is stable.
  for (const v of declared.list) {
    const result = await compileSite({
      ...input,
      contentRootOverride: v.content,
      versionPrefix: v.prefix,
    });
    versions.push({
      id: v.id,
      label: v.label,
      prefix: v.prefix,
      isDefault: v.isDefault,
      ...(v.tag ? { tag: v.tag } : {}),
      hidden: v.hidden,
      result,
    });
  }
  return { default: declared.default, versions };
}
