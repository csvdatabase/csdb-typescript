import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CSDBDatabase, openCSDB, parseSQL } from "../src/index.js";

const payroll = `--- csdb
format: CSDB
version: 1
name: payroll
tables:
  - workers
  - sessions

--- table:workers:schema
name: workers
columns:
  id: text
  name: text
  email: text
required:
  - id
  - name
  - email
primary_key:
  columns: [id]
unique:
  - [email]

--- table:workers:data
id,name,email
w_001,Ada Lovelace,ada@example.com
w_002,Grace Hopper,grace@example.com

--- table:sessions:schema
name: sessions
columns:
  id: text
  worker_id: text
  start_time: timestamp
  end_time: timestamp
  hourly_pay: numeric
  metadata: json
required:
  - id
  - worker_id
  - start_time
  - hourly_pay
primary_key:
  columns: [id]
foreign_keys:
  - name: sessions_worker_fk
    columns: [worker_id]
    references:
      table: workers
      columns: [id]
    on_delete: restrict
    on_update: cascade
    relationship: worker
constraints:
  - name: pay_nonnegative
    expression: hourly_pay >= 0
indexes:
  - name: sessions_worker_id_idx
    columns: [worker_id]
    unique: false

--- table:sessions:data
id,worker_id,start_time,end_time,hourly_pay,metadata
s_001,w_001,2026-01-01T09:00:00Z,2026-01-01T17:00:00Z,25.00,"{""source"":""manual""}"
s_002,w_001,2026-01-02T09:00:00Z,,25.00,"{""source"":""timer""}"
`;

test("parses, queries, mutates, and serializes CSDB", () => {
  const db = CSDBDatabase.parse(payroll);
  assert.equal(db.table("workers").where({ id: "w_001" }).first()?.name, "Ada Lovelace");

  db.table("workers").insert({ id: "w_003", name: "Katherine Johnson", email: "kj@example.com" });
  assert.equal(db.table("workers").byPrimaryKey("w_003")?.email, "kj@example.com");

  db.table("workers").where("id", "=", "w_003").update({ email: "katherine@example.com" });
  assert.equal(db.table("workers").where("email = 'katherine@example.com'").all().length, 1);

  const text = db.toString({ machineIndexes: "omit" });
  assert.match(text, /--- table:workers:data/);
  assert.match(text, /katherine@example.com/);
});

test("SQL and fluent APIs share behavior", () => {
  const db = CSDBDatabase.parse(payroll);
  db.sql("INSERT INTO workers (id, name, email) VALUES (?, ?, ?)", ["w_003", "Katherine Johnson", "kj@example.com"]);

  const viaSql = db.sql("SELECT id, email FROM workers WHERE id = ?", ["w_003"]);
  const viaApi = db.table("workers").where("id", "=", "w_003").select(["id", "email"]).all();
  assert.deepEqual(viaSql, viaApi);

  db.sql("UPDATE workers SET email = 'kat@example.com' WHERE id = 'w_003'");
  assert.equal(db.table("workers").byPrimaryKey("w_003")?.email, "kat@example.com");
});

test("relationship joins attach nested rows in method API", () => {
  const db = CSDBDatabase.parse(payroll);
  const session = db.table("sessions").join("worker").where("id", "=", "s_001").first();
  assert.equal((session?.worker as { name?: string } | null)?.name, "Ada Lovelace");
});

test("SQL parser supports DDL plan generation", () => {
  assert.deepEqual(parseSQL("CREATE TABLE tags (label text primary key)").kind, "create-table");
  assert.deepEqual(parseSQL("DROP TABLE tags"), { kind: "drop-table", table: "tags" });
});

test("openCSDB stores path and auto-saves successful mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "csdb-autosave-"));
  const path = join(dir, "payroll.csdb");
  await writeFile(path, payroll, "utf8");

  const db = await openCSDB(path, { autoSave: true });
  assert.equal(db.path, path);
  assert.equal(db.autoSave, true);

  db.table("workers").insert({ id: "w_003", name: "Katherine Johnson", email: "kj@example.com" });

  const saved = await readFile(path, "utf8");
  assert.match(saved, /Katherine Johnson/);
  assert.match(saved, /kj@example.com/);
});

test("autoSave false keeps mutations in memory until explicit save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "csdb-manual-save-"));
  const path = join(dir, "payroll.csdb");
  await writeFile(path, payroll, "utf8");

  const db = await openCSDB(path);
  db.table("workers").insert({ id: "w_003", name: "Katherine Johnson", email: "kj@example.com" });

  const beforeSave = await readFile(path, "utf8");
  assert.doesNotMatch(beforeSave, /Katherine Johnson/);

  db.saveSync();
  const afterSave = await readFile(path, "utf8");
  assert.match(afterSave, /Katherine Johnson/);
});

test("all supported types accept nullable CSV fields and round-trip null", () => {
  const nullableTypes = `--- csdb
format: CSDB
version: 1
name: nullable_types
tables:
  - values

--- table:values:schema
name: values
columns:
  text_col: text
  varchar_col:
    type: varchar
    length: 20
  integer_col: integer
  bigint_col: bigint
  real_col: real
  numeric_col: numeric
  boolean_col: boolean
  date_col: date
  timestamp_col: timestamp
  json_col: json
  custom_col:
    type: custom
    type_name: demo_type

--- table:values:data
text_col,varchar_col,integer_col,bigint_col,real_col,numeric_col,boolean_col,date_col,timestamp_col,json_col,custom_col
,,,,,,,,,,
`;

  const db = CSDBDatabase.parse(nullableTypes);
  const row = db.table("values").first();
  assert.ok(row);
  for (const value of Object.values(row)) assert.equal(value, null);

  const serialized = db.toString({ machineIndexes: "omit" });
  assert.match(serialized, /^,,,,,,,,,,$/m);

  const reparsed = CSDBDatabase.parse(serialized);
  const reparsedRow = reparsed.table("values").first();
  assert.ok(reparsedRow);
  for (const value of Object.values(reparsedRow)) assert.equal(value, null);
});

test("empty strings remain distinct from null when serializing", () => {
  const db = CSDBDatabase.parse(`--- csdb
format: CSDB
version: 1
name: strings
tables:
  - values

--- table:values:schema
name: values
columns:
  text_col: text
  integer_col: integer

--- table:values:data
text_col,integer_col
`);

  db.table("values").insert({ text_col: "", integer_col: null });
  const serialized = db.toString({ machineIndexes: "omit" });
  assert.match(serialized, /^"",$/m);

  const row = CSDBDatabase.parse(serialized).table("values").first();
  assert.equal(row?.text_col, "");
  assert.equal(row?.integer_col, null);
});

test("explicit null assignment is not replaced by defaults", () => {
  const db = CSDBDatabase.parse(`--- csdb
format: CSDB
version: 1
name: defaults
tables:
  - events

--- table:events:schema
name: events
columns:
  id: text
  happened_at: timestamp
required:
  - id
defaults:
  happened_at: 2026-01-01T00:00:00Z

--- table:events:data
id,happened_at
`);

  db.table("events").insert({ id: "explicit-null", happened_at: null });
  db.table("events").insert({ id: "defaulted" });

  assert.equal(db.table("events").where("id", "=", "explicit-null").first()?.happened_at, null);
  assert.equal(db.table("events").where("id", "=", "defaulted").first()?.happened_at, "2026-01-01T00:00:00Z");
});
