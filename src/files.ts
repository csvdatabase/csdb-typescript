import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SerializeOptions } from "./storage/document.js";
import { CSDBDatabase, type DatabaseOptions } from "./database.js";

export type OpenCSDBOptions = Omit<DatabaseOptions, "path">;

export async function openCSDB(path: string, options: OpenCSDBOptions = {}): Promise<CSDBDatabase> {
  return CSDBDatabase.parse(await readFile(path, "utf8"), { ...options, path });
}

export async function saveCSDB(db: CSDBDatabase, path: string, options?: SerializeOptions): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.csdb.tmp`);
  await writeFile(temp, db.toString(options), "utf8");
  await rename(temp, path);
}
