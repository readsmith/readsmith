import { z } from "zod";

/**
 * A source position, used to anchor diagnostics back to a file location.
 * offset is optional (byte or char offset) for editors that want it.
 */
export const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional(),
});
export type Position = z.infer<typeof positionSchema>;

/**
 * A build or validation diagnostic. Diagnostics are data, not exceptions:
 * a malformed input produces a diagnostic and the pipeline continues.
 */
export const diagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  pos: positionSchema.optional(),
  source: z.string(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
