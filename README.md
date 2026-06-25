# csdb-javascript

> This library is currently under development and will have major changes.

TypeScript implementation of the CSDB v1 single-file relational database format.

The library has one execution engine and two public surfaces:

- a fluent JavaScript API for direct table manipulation
- a SQL subset that compiles into the same internal query and mutation plans

```ts
import { openCSDB } from "@csdb/javascript";

const db = await openCSDB("payroll.csdb");

db.table("workers").insert({
  id: "w_001",
  name: "Ada Lovelace",
  email: "ada@example.com"
});

const workers = db.sql(
  "SELECT id, email FROM workers WHERE email = ?",
  ["ada@example.com"]
);
```

## Current SQL Support

- `SELECT ... FROM ...`
- `JOIN ... ON ...`
- `WHERE` with comparisons, `AND`, `OR`, `NOT`, `IS NULL`
- `ORDER BY`, `LIMIT`
- `INSERT INTO ... VALUES ...`
- `UPDATE ... SET ... WHERE ...`
- `DELETE FROM ... WHERE ...`
- compact `CREATE TABLE` and `DROP TABLE`

## Architecture

The implementation follows a small database-kernel layout:

- `storage` parses and serializes CSDB sections, YAML schemas, CSV rows, and machine indexes
- `catalog` normalizes schemas and validates relational metadata
- `typeRegistry` decodes and encodes CSDB values
- `expression` parses/evaluates predicates and constraints
- `executor` applies select/insert/update/delete/create/drop plans with rollback-on-validation-failure
- `sql` compiles SQL text into executor plans
- `table` exposes the fluent API over those same plans

## Scripts

```bash
npm install
npm test
npm run typecheck
npm run build
```
