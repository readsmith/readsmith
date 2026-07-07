import type { NormalizedSpec, Operation } from "@readsmith/model";

/**
 * Structural diff between two versions of a spec, surfacing breaking changes:
 * removed endpoints and parameters that became required. Feeds changelog/RSS
 * (wired in M5) and, later, the drift baseline. Deterministic and pure.
 */

export interface SpecChange {
  kind: "endpoint-removed" | "param-now-required";
  operation: string;
  detail: string;
  breaking: boolean;
}

function operationKey(op: Operation): string {
  return `${op.method} ${op.path}`;
}

export function diffSpecs(prev: NormalizedSpec, next: NormalizedSpec): SpecChange[] {
  const changes: SpecChange[] = [];
  const nextByKey = new Map(next.operations.map((op) => [operationKey(op), op]));

  for (const prevOp of prev.operations) {
    const nextOp = nextByKey.get(operationKey(prevOp));
    if (!nextOp) {
      changes.push({
        kind: "endpoint-removed",
        operation: prevOp.id,
        detail: `${prevOp.method.toUpperCase()} ${prevOp.path} was removed.`,
        breaking: true,
      });
      continue;
    }
    const prevParams = new Map(prevOp.parameters.map((p) => [`${p.in}:${p.name}`, p]));
    for (const nextParam of nextOp.parameters) {
      const before = prevParams.get(`${nextParam.in}:${nextParam.name}`);
      if (nextParam.required && (!before || !before.required)) {
        changes.push({
          kind: "param-now-required",
          operation: nextOp.id,
          detail: `${nextParam.in} parameter "${nextParam.name}" is now required.`,
          breaking: true,
        });
      }
    }
  }
  return changes;
}
