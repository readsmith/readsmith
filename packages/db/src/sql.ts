/**
 * A composed SQL statement: parameterized query text with its ordered values.
 * The only thing the client executes. Because values are carried separately and
 * never spliced into the text, there is no path for string-interpolated SQL,
 * which is the injection guard the persistence spec requires.
 */
export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function isSqlQuery(value: unknown): value is SqlQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SqlQuery).text === "string" &&
    Array.isArray((value as SqlQuery).values)
  );
}

/**
 * Tagged-template builder. Interpolated values become bound `$n` parameters, not
 * text, so `sql`SELECT ... WHERE id = ${userInput}`` is always safe. Nested
 * `SqlQuery` fragments compose (their placeholders are renumbered), which lets
 * repos build dynamic-but-parameterized statements without ever concatenating
 * raw SQL. Literal identifiers (table/column names) live in the template string,
 * which is authored code, never caller input.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  const parts: string[] = [];
  const out: unknown[] = [];

  strings.forEach((chunk, i) => {
    parts.push(chunk);
    if (i >= values.length) return;
    const value = values[i];
    if (isSqlQuery(value)) {
      const offset = out.length;
      parts.push(value.text.replace(/\$(\d+)/g, (_m, n: string) => `$${offset + Number(n)}`));
      out.push(...value.values);
    } else {
      out.push(value);
      parts.push(`$${out.length}`);
    }
  });

  return { text: parts.join(""), values: out };
}

/** Join SQL fragments with a separator (for example, bulk `VALUES` rows). */
export function joinSql(fragments: readonly SqlQuery[], separator: string): SqlQuery {
  const parts: string[] = [];
  const out: unknown[] = [];
  fragments.forEach((frag, i) => {
    if (i > 0) parts.push(separator);
    const offset = out.length;
    parts.push(frag.text.replace(/\$(\d+)/g, (_m, n: string) => `$${offset + Number(n)}`));
    out.push(...frag.values);
  });
  return { text: parts.join(""), values: out };
}
