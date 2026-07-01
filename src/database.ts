import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { renameSync, writeFileSync } from "node:fs";
import type { CSDBDocument, QueryPlan, Row, RowValue, SQLResult, TableSchema } from "./types.js";
import { validateDocument } from "./catalog.js";
import { CSDBError } from "./errors.js";
import { Executor } from "./executor.js";
import { parseSQL } from "./sql/parser.js";
import { parseDocument, serializeDocument, type ParseOptions, type SerializeOptions } from "./storage/document.js";
import { TableQuery } from "./table.js";

export interface DatabaseOptions {
  path?: string;
  autoSave?: boolean;
  serializeOptions?: SerializeOptions;
}

export interface DatabaseParseOptions extends ParseOptions, DatabaseOptions {}

export class CSDBDatabase {
  readonly executor: Executor;
  readonly path: string | undefined;
  autoSave: boolean;
  private readonly serializeOptions: SerializeOptions | undefined;

  constructor(readonly document: CSDBDocument, options: DatabaseOptions = {}) {
    if (options.autoSave === true && !options.path) {
      throw new CSDBError("autoSave requires a database path.");
    }
    this.executor = new Executor(document);
    this.path = options.path;
    this.autoSave = options.autoSave ?? false;
    this.serializeOptions = options.serializeOptions;
  }

  static parse(text: string, options: DatabaseParseOptions = {}): CSDBDatabase {
    return new CSDBDatabase(parseDocument(text, options), options);
  }

  table(name: string): TableQuery {
    return new TableQuery(this, name);
  }

  sql(statement: string, params: RowValue[] = []): SQLResult {
    return this.execute(parseSQL(statement, params)) as SQLResult;
  }

  execute(plan: QueryPlan): Row[] | { rowsAffected: number } {
    const result = this.executor.execute(plan);
    if (plan.kind !== "select") this.autoSaveIfEnabled();
    return result;
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

  saveSync(path = this.path, options: SerializeOptions = this.serializeOptions ?? {}): void {
    if (!path) throw new CSDBError("Cannot save CSDB database without a path.");
    const temp = join(dirname(path), `.${randomUUID()}.csdb.tmp`);
    writeFileSync(temp, this.toString(options), "utf8");
    renameSync(temp, path);
  }

  private autoSaveIfEnabled(): void {
    if (this.autoSave) this.saveSync();
  }
}
