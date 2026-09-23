// packages/query-planner/src/sql-builder.ts
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
