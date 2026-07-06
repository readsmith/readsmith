import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // A self-contained IIFE of the island runtime (no external deps) that the
    // serving app ships as runtime.js. Exposes the RSIslands global (hydrate).
    entry: { "readsmith-islands": "src/islands/index.ts" },
    format: ["iife"],
    globalName: "RSIslands",
    minify: true,
    sourcemap: false,
  },
]);
