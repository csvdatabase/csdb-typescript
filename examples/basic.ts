import { CSDBDatabase } from "../src/index.js";

const db = CSDBDatabase.parse(`--- csdb
format: CSDB
version: 1
name: demo
tables:
  - notes

--- table:notes:schema
name: notes
columns:
  id: text
  body: text
required:
  - id
primary_key:
  columns: [id]

--- table:notes:data
id,body
n_001,hello
`);

db.table("notes").insert({ id: "n_002", body: "from the fluent API" });
db.sql("UPDATE notes SET body = 'from SQL' WHERE id = 'n_001'");

console.log(db.table("notes").orderBy("id").all());
