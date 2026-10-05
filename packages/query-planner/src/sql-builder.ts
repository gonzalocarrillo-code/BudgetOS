// packages/query-planner/src/sql-builder.ts

/**
 * Escape LIKE/ILIKE wildcards (%, _) and the escape character (\) with a backslash,
 * so they are treated literally in LIKE/ILIKE expressions.
 * Must be used with `ESCAPE '\'` clause in the query (e.g., `LIKE $1 ESCAPE '\'`).
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export class SqlBuilder {
  private params: unknown[] = [];
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get values(): unknown[] {
    return this.params;
  }
}
