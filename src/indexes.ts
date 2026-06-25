import type { CSDBDocument, Row, Table } from "./types.js";
import { keyFor } from "./util/identifiers.js";

export class IndexManager {
  private readonly primary = new Map<string, Map<string, Row>>();

  constructor(private readonly document: CSDBDocument) {
    this.rebuild();
  }

  rebuild(): void {
    this.primary.clear();
    for (const table of this.document.tables.values()) {
      const pk = table.schema.primary_key;
      if (!pk) continue;
      const map = new Map<string, Row>();
      for (const row of table.rows) map.set(keyFor(pk.columns.map((column) => row[column] ?? null)), row);
      this.primary.set(table.name, map);
    }
  }

  findByPrimaryKey(tableName: string, values: unknown[]): Row | undefined {
    return this.primary.get(tableName)?.get(keyFor(values));
  }

  findRelationship(sourceTable: Table, relationship: string, sourceRow: Row): { table: string; row?: Row } {
    const fk = sourceTable.schema.foreign_keys.find((candidate) => candidate.relationship === relationship || candidate.name === relationship);
    if (!fk) return { table: relationship };
    const row = this.findByPrimaryKey(fk.references.table, fk.columns.map((column) => sourceRow[column] ?? null));
    return row ? { table: fk.references.table, row } : { table: fk.references.table };
  }
}
