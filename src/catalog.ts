import type { CSDBDocument, NormalizedTableSchema, Row, Table, TableSchema } from "./types.js";
import { evaluate, parseExpression } from "./expression.js";
import { ValidationError } from "./errors.js";
import { assertSupportedType } from "./typeRegistry.js";
import { assertValidName, columnNames, keyFor } from "./util/identifiers.js";

export function normalizeSchema(schema: TableSchema): NormalizedTableSchema {
  assertValidName("Table name", schema.name);
  if (!schema.columns || typeof schema.columns !== "object" || Array.isArray(schema.columns)) {
    throw new ValidationError(`Table "${schema.name}" must declare ordered columns.`);
  }
  for (const [column, definition] of Object.entries(schema.columns)) {
    assertValidName("Column name", column);
    assertSupportedType(column, definition);
  }

  const normalized: NormalizedTableSchema = {
    ...schema,
    required: schema.required ?? [],
    defaults: schema.defaults ?? {},
    primary_key: schema.primary_key ?? null,
    unique: schema.unique ?? [],
    foreign_keys: schema.foreign_keys ?? [],
    constraints: schema.constraints ?? [],
    indexes: schema.indexes ?? [],
    computed_fields: schema.computed_fields ?? {},
    comments: schema.comments ?? {}
  };

  validateSchemaReferences(normalized);
  return normalized;
}

export function storedColumnNames(schema: NormalizedTableSchema): string[] {
  const storedComputed = Object.entries(schema.computed_fields)
    .filter(([, field]) => field.stored === true)
    .map(([name]) => name);
  return [...columnNames(schema.columns), ...storedComputed];
}

export function validateDocument(document: CSDBDocument): void {
  const { metadata, tableOrder, tables } = document;
  if (metadata.format !== "CSDB") throw new ValidationError("Database metadata format must be CSDB.");
  if (metadata.version !== 1) throw new ValidationError("Only CSDB version 1 is supported.");
  assertValidName("Database name", metadata.name);
  assertNoDuplicates("Database table list", metadata.tables);
  if (metadata.tables.join("\0") !== tableOrder.join("\0")) {
    throw new ValidationError("Database table list must match table section order.");
  }

  for (const name of tableOrder) {
    const table = tables.get(name);
    if (!table) throw new ValidationError(`Missing table "${name}".`);
    if (table.schema.name !== name) throw new ValidationError(`Schema name "${table.schema.name}" does not match table "${name}".`);
    validateSchemaReferences(table.schema);
  }

  for (const table of tables.values()) validateRows(table);
  validateForeignKeys(document);
}

export function validateRows(table: Table): void {
  const schema = table.schema;
  const columns = columnNames(schema.columns);
  const required = new Set(schema.required);

  for (const [rowIndex, row] of table.rows.entries()) {
    for (const column of columns) {
      if (!(column in row)) throw new ValidationError(`Table "${table.name}" row ${rowIndex + 1} is missing "${column}".`);
      if (required.has(column) && row[column] === null) {
        throw new ValidationError(`Table "${table.name}" row ${rowIndex + 1} has null required column "${column}".`);
      }
    }
    for (const constraint of schema.constraints) {
      const ok = Boolean(evaluate(parseExpression(constraint.expression), { baseTable: table.name, rows: { [table.name]: row } }));
      if (!ok) throw new ValidationError(`Constraint "${constraint.name}" failed on ${table.name} row ${rowIndex + 1}.`);
    }
  }

  if (schema.primary_key) validateUnique(table, schema.primary_key.columns, "primary key");
  for (const unique of schema.unique) validateUnique(table, unique, `unique(${unique.join(",")})`);
  for (const index of schema.indexes) {
    if (index.unique && index.columns) validateUnique(table, index.columns, `unique index "${index.name}"`);
  }
}

function validateUnique(table: Table, columns: string[], label: string): void {
  const seen = new Set<string>();
  for (const [rowIndex, row] of table.rows.entries()) {
    const values = columns.map((column) => row[column] ?? null);
    if (values.some((value) => value === null)) continue;
    const key = keyFor(values);
    if (seen.has(key)) throw new ValidationError(`Duplicate ${label} in "${table.name}" at row ${rowIndex + 1}.`);
    seen.add(key);
  }
}

function validateForeignKeys(document: CSDBDocument): void {
  for (const table of document.tables.values()) {
    for (const fk of table.schema.foreign_keys) {
      const target = document.tables.get(fk.references.table);
      if (!target) throw new ValidationError(`Foreign key "${fk.name}" references unknown table "${fk.references.table}".`);
      const targetKeys = new Set(target.rows.map((row) => keyFor(fk.references.columns.map((column) => row[column] ?? null))));
      for (const [rowIndex, row] of table.rows.entries()) {
        const values = fk.columns.map((column) => row[column] ?? null);
        if (values.some((value) => value === null)) continue;
        if (!targetKeys.has(keyFor(values))) {
          throw new ValidationError(`Foreign key "${fk.name}" failed on ${table.name} row ${rowIndex + 1}.`);
        }
      }
    }
  }
}

function validateSchemaReferences(schema: NormalizedTableSchema): void {
  const columns = new Set(columnNames(schema.columns));
  const assertColumns = (label: string, names: string[]) => {
    for (const name of names) {
      if (!columns.has(name)) throw new ValidationError(`${label} references unknown column "${name}" in "${schema.name}".`);
    }
  };

  assertColumns("required", schema.required);
  assertColumns("defaults", Object.keys(schema.defaults));
  if (schema.primary_key) {
    assertColumns("primary_key", schema.primary_key.columns);
    for (const column of schema.primary_key.columns) {
      if (!schema.required.includes(column)) {
        throw new ValidationError(`Primary key column "${column}" must be listed in required for "${schema.name}".`);
      }
    }
  }
  for (const unique of schema.unique) assertColumns("unique", unique);
  for (const fk of schema.foreign_keys) assertColumns(`foreign key "${fk.name}"`, fk.columns);
  for (const index of schema.indexes) {
    if (index.columns) assertColumns(`index "${index.name}"`, index.columns);
  }
}

function assertNoDuplicates(label: string, values: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ValidationError(`${label} contains duplicate "${value}".`);
    seen.add(value);
  }
}
