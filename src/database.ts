import type { CSDBDocument, QueryPlan, Row, RowValue, SQLResult, TableSchema } from "./types.js";
import { validateDocument } from "./catalog.js";
import { Executor } from "./executor.js";
import { parseSQL } from "./sql/parser.js";
import { parseDocument, serializeDocument, type ParseOptions, type SerializeOptions } from "./storage/document.js";
import { TableQuery } from "./table.js";

export class CSDBDatabase {
  readonly executor: Executor;

  constructor(readonly document: CSDBDocument) {
    this.executor = new Executor(document);
  }

  static parse(text: string, options?: ParseOptions): CSDBDatabase {
    return new CSDBDatabase(parseDocument(text, options));
  }

  table(name: string): TableQuery {
    return new TableQuery(this, name);
  }

  sql(statement: string, params: RowValue[] = []): SQLResult {
    return this.execute(parseSQL(statement, params)) as SQLResult;
  }

  execute(plan: QueryPlan): Row[] | { rowsAffected: number } {
    return this.executor.execute(plan);
  }

  createTable(schema: TableSchema): { rowsAffected: number } {
    return this.execute({ kind: "create-table", schema }) as { rowsAffected: number };
  }

  dropTable(name: string): { rowsAffected: number } {
    return this.execute({ kind: "drop-table", table: name }) as { rowsAffected: number };
  }

  validate(): void {
    validateDocument(this.document);
  }

  toString(options?: SerializeOptions): string {
    return serializeDocument(this.document, options);
  }
}
