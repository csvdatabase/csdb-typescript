export type Primitive = string | number | bigint | boolean | null;
export type RowValue = Primitive | Record<string, unknown> | unknown[];
export type Row = Record<string, RowValue>;

export type ColumnType =
  | string
  | ({
      type: string;
    } & Record<string, unknown>);

export interface MachineIndexingOptions {
  enabled: boolean;
  machine_key_width?: number;
  machine_value_width?: number;
  section_title_length?: number;
  footer_entry_count?: number;
}

export interface CSDBMetadata {
  format: "CSDB";
  version: 1;
  name: string;
  machine_indexing?: MachineIndexingOptions;
  tables: string[];
  comments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PrimaryKey {
  columns: string[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  references: {
    table: string;
    columns: string[];
  };
  on_delete?: ReferentialAction;
  on_update?: ReferentialAction;
  relationship?: string;
}

export type ReferentialAction =
  | "restrict"
  | "cascade"
  | "set_null"
  | "set_default"
  | "no_action";

export interface Constraint {
  name: string;
  expression: string;
}

export interface SchemaIndex {
  name: string;
  columns?: string[];
  expression?: string;
  where?: string;
  unique?: boolean;
}

export interface ComputedField {
  type: ColumnType;
  expression: string;
  stored?: boolean;
}

export interface TableSchema {
  name: string;
  columns: Record<string, ColumnType>;
  required?: string[];
  defaults?: Record<string, unknown>;
  primary_key?: PrimaryKey | null;
  unique?: string[][];
  foreign_keys?: ForeignKey[];
  constraints?: Constraint[];
  indexes?: SchemaIndex[];
  computed_fields?: Record<string, ComputedField>;
  comments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NormalizedTableSchema extends TableSchema {
  required: string[];
  defaults: Record<string, unknown>;
  primary_key: PrimaryKey | null;
  unique: string[][];
  foreign_keys: ForeignKey[];
  constraints: Constraint[];
  indexes: SchemaIndex[];
  computed_fields: Record<string, ComputedField>;
  comments: Record<string, unknown>;
}

export interface Table {
  name: string;
  schema: NormalizedTableSchema;
  rows: Row[];
}

export interface MachineSection {
  name: string;
  raw: string;
}

export interface CSDBDocument {
  metadata: CSDBMetadata;
  tableOrder: string[];
  tables: Map<string, Table>;
  machineSections: MachineSection[];
}

export type ComparisonOp = "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=";

export type Expr =
  | { type: "literal"; value: RowValue }
  | { type: "identifier"; name: string }
  | { type: "comparison"; op: ComparisonOp; left: Expr; right: Expr }
  | { type: "is-null"; expr: Expr; not: boolean }
  | { type: "and"; left: Expr; right: Expr }
  | { type: "or"; left: Expr; right: Expr }
  | { type: "not"; expr: Expr };

export interface JoinPlan {
  table: string;
  alias?: string;
  relationship?: string;
  on?: Expr;
}

export interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

export interface SelectPlan {
  kind: "select";
  table: string;
  alias?: string;
  columns: string[] | "*";
  joins: JoinPlan[];
  where?: Expr;
  orderBy: OrderBy[];
  limit?: number;
  output?: "objects" | "flat";
}

export interface InsertPlan {
  kind: "insert";
  table: string;
  rows: Row[];
}

export interface UpdatePlan {
  kind: "update";
  table: string;
  set: Row;
  where?: Expr;
}

export interface DeletePlan {
  kind: "delete";
  table: string;
  where?: Expr;
}

export interface CreateTablePlan {
  kind: "create-table";
  schema: TableSchema;
}

export interface DropTablePlan {
  kind: "drop-table";
  table: string;
}

export type QueryPlan =
  | SelectPlan
  | InsertPlan
  | UpdatePlan
  | DeletePlan
  | CreateTablePlan
  | DropTablePlan;

export interface MutationResult {
  rowsAffected: number;
}

export type SQLResult = Row[] | MutationResult;
