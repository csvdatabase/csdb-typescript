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
