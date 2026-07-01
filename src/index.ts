import { CSDBDatabase } from "./database.js";
import type { DatabaseParseOptions } from "./database.js";

export { CSDBDatabase } from "./database.js";
export { openCSDB, saveCSDB } from "./files.js";
export { parseSQL } from "./sql/parser.js";
export { parseDocument, serializeDocument } from "./storage/document.js";
export { CSDBError, SQLError, ValidationError } from "./errors.js";
export type {
  CSDBDocument,
  CSDBMetadata,
  ColumnType,
  ComputedField,
  Constraint,
  DeletePlan,
  Expr,
  ForeignKey,
  InsertPlan,
  MachineIndexingOptions,
  MachineSection,
  MutationResult,
  OrderBy,
  PrimaryKey,
  QueryPlan,
  Row,
  RowValue,
  SchemaIndex,
  SelectPlan,
  SQLResult,
  Table,
  TableSchema,
  UpdatePlan
} from "./types.js";
export type { DatabaseOptions, DatabaseParseOptions } from "./database.js";
export type { OpenCSDBOptions } from "./files.js";

export function parseCSDB(text: string, options?: DatabaseParseOptions): CSDBDatabase {
  return CSDBDatabase.parse(text, options);
}

export function serializeCSDB(db: CSDBDatabase): string {
  return db.toString();
}
