import type {
  CSDBDocument,
  DeletePlan,
  Expr,
  InsertPlan,
  MutationResult,
  QueryPlan,
  Row,
  RowValue,
  SelectPlan,
  Table,
  UpdatePlan
} from "./types.js";
import { normalizeSchema, storedColumnNames, validateDocument, validateRows } from "./catalog.js";
import { CSDBError, ValidationError } from "./errors.js";
import { evaluate, type EvalContext } from "./expression.js";
import { IndexManager } from "./indexes.js";
import { decodeCell, encodeValue } from "./typeRegistry.js";
import { columnNames } from "./util/identifiers.js";

interface JoinedContext extends EvalContext {
  outputScopes: { scope: string; row: Row }[];
  relations: { name: string; row: Row | null }[];
}

export class Executor {
  readonly indexes: IndexManager;

  constructor(readonly document: CSDBDocument) {
    this.indexes = new IndexManager(document);
  }

  execute(plan: QueryPlan): Row[] | MutationResult {
    switch (plan.kind) {
      case "select":
        return this.select(plan);
      case "insert":
        return this.insert(plan);
      case "update":
        return this.update(plan);
      case "delete":
        return this.delete(plan);
      case "create-table":
        return this.transact(() => {
          const schema = normalizeSchema(plan.schema);
          if (this.document.tables.has(schema.name)) throw new ValidationError(`Table "${schema.name}" already exists.`);
          this.document.tables.set(schema.name, { name: schema.name, schema, rows: [] });
          this.document.tableOrder.push(schema.name);
          this.document.metadata.tables = [...this.document.tableOrder];
          return { rowsAffected: 0 };
        });
      case "drop-table":
        return this.transact(() => {
          this.mustTable(plan.table);
          for (const table of this.document.tables.values()) {
            for (const fk of table.schema.foreign_keys) {
              if (fk.references.table === plan.table) throw new ValidationError(`Cannot drop "${plan.table}"; foreign key "${fk.name}" references it.`);
            }
          }
          this.document.tables.delete(plan.table);
          this.document.tableOrder = this.document.tableOrder.filter((name) => name !== plan.table);
          this.document.metadata.tables = [...this.document.tableOrder];
          return { rowsAffected: 0 };
        });
    }
  }

  private select(plan: SelectPlan): Row[] {
    const base = this.mustTable(plan.table);
    const baseScope = plan.alias ?? plan.table;
    let contexts: JoinedContext[] = base.rows.map((row) => ({
      baseTable: baseScope,
      rows: { [plan.table]: row, [baseScope]: row },
      outputScopes: [{ scope: baseScope, row }],
      relations: []
    }));

    for (const join of plan.joins) {
      const joined: JoinedContext[] = [];
      if (join.relationship) {
        for (const context of contexts) {
          const sourceRow = context.rows[baseScope]!;
          const relation = this.indexes.findRelationship(base, join.relationship, sourceRow);
          const targetRow = relation.row ?? null;
          joined.push(addJoinContext(context, join.relationship, relation.table, join.alias, targetRow));
        }
      } else {
        const target = this.mustTable(join.table);
        const scope = join.alias ?? join.table;
        for (const context of contexts) {
          for (const row of target.rows) {
            const candidate = addJoinContext(context, scope, join.table, join.alias, row);
            if (!join.on || Boolean(evaluate(join.on, candidate))) joined.push(candidate);
          }
        }
      }
      contexts = joined;
    }

    contexts = contexts.filter((context) => Boolean(evaluate(plan.where, context)));
    for (const order of [...plan.orderBy].reverse()) {
      contexts.sort((a, b) => compareForSort(evaluate({ type: "identifier", name: order.column }, a), evaluate({ type: "identifier", name: order.column }, b), order.direction));
    }
    if (plan.limit !== undefined) contexts = contexts.slice(0, plan.limit);
    return contexts.map((context) => projectContext(context, plan));
  }

  private insert(plan: InsertPlan): MutationResult {
    return this.transact(() => {
      const table = this.mustTable(plan.table);
      const rows = plan.rows.map((row) => coerceRow(table, row));
      table.rows.push(...rows);
      validateRows(table);
      return { rowsAffected: rows.length };
    });
  }

  private update(plan: UpdatePlan): MutationResult {
    return this.transact(() => {
      const table = this.mustTable(plan.table);
      let count = 0;
      for (const row of table.rows) {
        if (!matches(table.name, row, plan.where)) continue;
        const patched = coerceRow(table, { ...row, ...plan.set });
        Object.keys(row).forEach((key) => delete row[key]);
        Object.assign(row, patched);
        count++;
      }
      validateRows(table);
      return { rowsAffected: count };
    });
  }

  private delete(plan: DeletePlan): MutationResult {
    return this.transact(() => {
      const table = this.mustTable(plan.table);
      const before = table.rows.length;
      table.rows = table.rows.filter((row) => !matches(table.name, row, plan.where));
      return { rowsAffected: before - table.rows.length };
    });
  }

  private transact<T extends MutationResult>(operation: () => T): T {
    const snapshot = cloneDocument(this.document);
    try {
      const result = operation();
      validateDocument(this.document);
      this.indexes.rebuild();
      return result;
    } catch (error) {
      restoreDocument(this.document, snapshot);
      this.indexes.rebuild();
      throw error;
    }
  }

  private mustTable(name: string): Table {
    const table = this.document.tables.get(name);
    if (!table) throw new CSDBError(`Unknown table "${name}".`);
    return table;
  }
}

function coerceRow(table: Table, input: Row): Row {
  const schema = table.schema;
  const columns = storedColumnNames(schema);
  const normal = new Set(columns);
  for (const key of Object.keys(input)) {
    if (!normal.has(key)) throw new ValidationError(`Unknown column "${key}" for table "${table.name}".`);
  }

  const required = new Set(schema.required);
  const row: Row = {};
  for (const column of columns) {
    const definition = schema.columns[column] ?? schema.computed_fields[column]?.type;
    if (!definition) throw new ValidationError(`Unknown column "${column}" for table "${table.name}".`);
    const value = (input[column] ?? schema.defaults[column] ?? null) as RowValue;
    const encoded = encodeValue(column, definition, value, required.has(column));
    row[column] = decodeCell(column, definition, { text: encoded, quoted: value === "" }, required.has(column));
  }
  return row;
}

function matches(table: string, row: Row, where: Expr | undefined): boolean {
  return Boolean(evaluate(where, { baseTable: table, rows: { [table]: row } }));
}

function addJoinContext(context: JoinedContext, scope: string, table: string, alias: string | undefined, row: Row | null): JoinedContext {
  if (!row) return { ...context, relations: [...context.relations, { name: scope, row: null }] };
  return {
    baseTable: context.baseTable,
    rows: { ...context.rows, [table]: row, [scope]: row, ...(alias ? { [alias]: row } : {}) },
    outputScopes: [...context.outputScopes, { scope, row }],
    relations: [...context.relations, { name: scope, row }]
  };
}

function projectContext(context: JoinedContext, plan: SelectPlan): Row {
  if (plan.output === "objects") {
    const base = { ...context.outputScopes[0]!.row };
    for (const relation of context.relations) base[relation.name] = relation.row ? { ...relation.row } : null;
    return selectColumns(base, plan.columns);
  }

  if (plan.columns === "*") {
    if (context.outputScopes.length === 1) return { ...context.outputScopes[0]!.row };
    const row: Row = {};
    for (const scope of context.outputScopes) {
      for (const [column, value] of Object.entries(scope.row)) row[`${scope.scope}.${column}`] = value;
    }
    return row;
  }

  const row: Row = {};
  for (const column of plan.columns) row[column] = evaluate({ type: "identifier", name: column }, context) as RowValue;
  return row;
}

function selectColumns(row: Row, columns: string[] | "*"): Row {
  if (columns === "*") return row;
  const selected: Row = {};
  for (const column of columns) selected[column] = row[column] ?? null;
  return selected;
}

function compareForSort(left: RowValue | boolean, right: RowValue | boolean, direction: "asc" | "desc"): number {
  const a = left === null ? "" : String(left);
  const b = right === null ? "" : String(right);
  const result = a.localeCompare(b, undefined, { numeric: true });
  return direction === "asc" ? result : -result;
}

interface DocumentSnapshot {
  tableOrder: string[];
  metadataTables: string[];
  tables: Map<string, Table>;
}

function cloneDocument(document: CSDBDocument): DocumentSnapshot {
  const tables = new Map<string, Table>();
  for (const [name, table] of document.tables) {
    tables.set(name, { ...table, rows: table.rows.map((row) => ({ ...row })) });
  }
  return {
    tableOrder: [...document.tableOrder],
    metadataTables: [...document.metadata.tables],
    tables
  };
}

function restoreDocument(document: CSDBDocument, snapshot: DocumentSnapshot): void {
  document.tableOrder = snapshot.tableOrder;
  document.metadata.tables = snapshot.metadataTables;
  document.tables = snapshot.tables;
}
