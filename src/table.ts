import type { ComparisonOp, Expr, InsertPlan, OrderBy, Row, RowValue, SelectPlan } from "./types.js";
import type { CSDBDatabase } from "./database.js";
import { andExpr, comparison, parseExpression } from "./expression.js";

export class TableQuery {
  private predicate?: Expr;
  private joins: SelectPlan["joins"] = [];
  private ordering: OrderBy[] = [];
  private maxRows?: number;
  private projection: string[] | "*" = "*";

  constructor(private readonly db: CSDBDatabase, private readonly tableName: string) {}

  where(column: string, op: ComparisonOp, value: RowValue): TableQuery;
  where(match: Row): TableQuery;
  where(expression: string): TableQuery;
  where(columnOrMatch: string | Row, op?: ComparisonOp, value?: RowValue): TableQuery {
    if (typeof columnOrMatch === "string" && op) {
      this.predicate = andExpr(this.predicate, comparison(columnOrMatch, op, value ?? null));
    } else if (typeof columnOrMatch === "string") {
      this.predicate = andExpr(this.predicate, parseExpression(columnOrMatch));
    } else {
      for (const [column, expected] of Object.entries(columnOrMatch)) {
        this.predicate = andExpr(this.predicate, comparison(column, "=", expected as RowValue));
      }
    }
    return this;
  }

  select(columns: string[] | "*"): TableQuery {
    this.projection = columns;
    return this;
  }

  join(relationship: string): TableQuery {
    this.joins.push({ table: relationship, relationship });
    return this;
  }

  orderBy(column: string, direction: "asc" | "desc" = "asc"): TableQuery {
    this.ordering.push({ column, direction });
    return this;
  }

  limit(count: number): TableQuery {
    this.maxRows = count;
    return this;
  }

  all(): Row[] {
    return this.db.execute(this.selectPlan()) as Row[];
  }

  first(): Row | undefined {
    return this.limit(1).all()[0];
  }

  insert(row: Row | Row[]): { rowsAffected: number } {
    const rows = Array.isArray(row) ? row : [row];
    return this.db.execute({ kind: "insert", table: this.tableName, rows } satisfies InsertPlan) as { rowsAffected: number };
  }

  update(values: Row): { rowsAffected: number } {
    return this.db.execute({ kind: "update", table: this.tableName, set: values, ...(this.predicate ? { where: this.predicate } : {}) }) as { rowsAffected: number };
  }

  delete(): { rowsAffected: number } {
    return this.db.execute({ kind: "delete", table: this.tableName, ...(this.predicate ? { where: this.predicate } : {}) }) as { rowsAffected: number };
  }

  byPrimaryKey(value: RowValue | RowValue[]): Row | undefined {
    const table = this.db.document.tables.get(this.tableName);
    const pk = table?.schema.primary_key;
    if (!table || !pk) return undefined;
    const values = Array.isArray(value) ? value : [value];
    return this.db.executor.indexes.findByPrimaryKey(this.tableName, values);
  }

  private selectPlan(): SelectPlan {
    return {
      kind: "select",
      table: this.tableName,
      columns: this.projection,
      joins: this.joins,
      ...(this.predicate ? { where: this.predicate } : {}),
      orderBy: this.ordering,
      ...(this.maxRows !== undefined ? { limit: this.maxRows } : {}),
      output: "objects"
    };
  }
}
