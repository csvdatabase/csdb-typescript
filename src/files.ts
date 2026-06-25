import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SerializeOptions } from "./storage/document.js";
import { CSDBDatabase } from "./database.js";

export async function openCSDB(path: string): Promise<CSDBDatabase> {
  return CSDBDatabase.parse(await readFile(path, "utf8"));
}

export async function saveCSDB(db: CSDBDatabase, path: string, options?: SerializeOptions): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.csdb.tmp`);
  await writeFile(temp, db.toString(options), "utf8");
  await rename(temp, path);
}
