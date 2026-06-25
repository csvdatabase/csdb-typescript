import type { ColumnType, QueryPlan, Row, RowValue, TableSchema } from "../types.js";
import { parseExpression } from "../expression.js";
import { SQLError } from "../errors.js";

export function parseSQL(statement: string, params: RowValue[] = []): QueryPlan {
  const sql = statement.trim().replace(/;$/, "");
  const command = sql.match(/^\w+/)?.[0]?.toUpperCase();
  let paramIndex = 0;
  const takeParams = (fragment: string) => {
    const count = countParams(fragment);
    const taken = params.slice(paramIndex, paramIndex + count);
    paramIndex += count;
    return taken;
  };
  const literal = (fragment: string) => parseLiteral(fragment, () => params[paramIndex++] ?? null);

  switch (command) {
    case "SELECT":
      return parseSelect(sql, takeParams);
    case "INSERT":
      return parseInsert(sql, literal);
    case "UPDATE":
      return parseUpdate(sql, takeParams, literal);
    case "DELETE":
      return parseDelete(sql, takeParams);
    case "CREATE":
      return parseCreateTable(sql);
    case "DROP":
      return parseDropTable(sql);
    default:
      throw new SQLError(`Unsupported SQL statement "${command ?? sql}".`);
  }
}

function parseSelect(sql: string, takeParams: (fragment: string) => RowValue[]): QueryPlan {
  const fromAt = findClause(sql, "FROM");
  if (fromAt < 0) throw new SQLError("SELECT requires FROM.");
  const columnsText = sql.slice("SELECT".length, fromAt).trim();
  const tail = sql.slice(fromAt + "FROM".length).trim();
  const whereAt = findClause(tail, "WHERE");
  const orderAt = findClause(tail, "ORDER BY");
  const limitAt = findClause(tail, "LIMIT");
  const firstClause = minPositive(whereAt, orderAt, limitAt, tail.length);
  const fromText = tail.slice(0, firstClause).trim();
  const whereText = whereAt >= 0 ? tail.slice(whereAt + "WHERE".length, minPositive(orderAt, limitAt, tail.length)).trim() : undefined;
  const orderText = orderAt >= 0 ? tail.slice(orderAt + "ORDER BY".length, minPositive(limitAt, tail.length)).trim() : undefined;
  const limitText = limitAt >= 0 ? tail.slice(limitAt + "LIMIT".length).trim() : undefined;
  const { table, alias, joins } = parseFrom(fromText);

  return {
    kind: "select",
    table,
    ...(alias ? { alias } : {}),
    columns: columnsText === "*" ? "*" : splitComma(columnsText).map((column) => column.trim()),
    joins,
    ...(whereText ? { where: parseExpression(whereText, takeParams(whereText)) } : {}),
    orderBy: orderText
      ? splitComma(orderText).map((item) => {
          const [column, direction] = item.trim().split(/\s+/);
          if (!column) throw new SQLError("ORDER BY column is required.");
          return { column, direction: direction?.toLowerCase() === "desc" ? "desc" : "asc" };
        })
      : [],
    ...(limitText ? { limit: Number.parseInt(limitText, 10) } : {}),
    output: "flat"
  };
}

function parseInsert(sql: string, literal: (fragment: string) => RowValue): QueryPlan {
  const match = sql.match(/^INSERT\s+INTO\s+([A-Za-z0-9_.$-]+)\s*(?:\((.*?)\))?\s+VALUES\s+(.+)$/i);
  if (!match) throw new SQLError("INSERT syntax: INSERT INTO table [(columns)] VALUES (...).");
  const table = match[1]!;
  const columns = match[2]?.trim() ? splitComma(match[2]).map((column) => column.trim()) : undefined;
  const tuples = splitTuples(match[3]!);
  const rows = tuples.map((tuple) => {
    const values = splitComma(tuple).map((value) => literal(value.trim()));
    if (columns && values.length !== columns.length) throw new SQLError("INSERT column count does not match VALUES count.");
    if (!columns) return Object.fromEntries(values.map((value, index) => [String(index), value]));
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]));
  });
  return { kind: "insert", table, rows };
}

function parseUpdate(sql: string, takeParams: (fragment: string) => RowValue[], literal: (fragment: string) => RowValue): QueryPlan {
  const setAt = findClause(sql, "SET");
  if (setAt < 0) throw new SQLError("UPDATE requires SET.");
  const table = sql.slice("UPDATE".length, setAt).trim().split(/\s+/)[0];
  if (!table) throw new SQLError("UPDATE table name is required.");
  const tail = sql.slice(setAt + "SET".length).trim();
  const whereAt = findClause(tail, "WHERE");
  const setText = tail.slice(0, whereAt >= 0 ? whereAt : tail.length).trim();
  const whereText = whereAt >= 0 ? tail.slice(whereAt + "WHERE".length).trim() : undefined;
  const set: Row = {};
  for (const assignment of splitComma(setText)) {
    const eq = assignment.indexOf("=");
    if (eq < 0) throw new SQLError(`Invalid assignment "${assignment}".`);
    set[assignment.slice(0, eq).trim()] = literal(assignment.slice(eq + 1).trim());
  }
  return {
    kind: "update",
    table,
    set,
    ...(whereText ? { where: parseExpression(whereText, takeParams(whereText)) } : {})
  };
}

function parseDelete(sql: string, takeParams: (fragment: string) => RowValue[]): QueryPlan {
  const match = sql.match(/^DELETE\s+FROM\s+([A-Za-z0-9_.$-]+)(?:\s+WHERE\s+(.+))?$/i);
  if (!match) throw new SQLError("DELETE syntax: DELETE FROM table [WHERE ...].");
  const where = match[2]?.trim();
  return {
    kind: "delete",
    table: match[1]!,
    ...(where ? { where: parseExpression(where, takeParams(where)) } : {})
  };
}

function parseCreateTable(sql: string): QueryPlan {
  const match = sql.match(/^CREATE\s+TABLE\s+([A-Za-z0-9_.$-]+)\s*\((.+)\)$/i);
  if (!match) throw new SQLError("CREATE TABLE syntax: CREATE TABLE name (...).");
  const schema: TableSchema = {
    name: match[1]!,
    columns: {},
    required: [],
    defaults: {},
    primary_key: null,
    unique: [],
    foreign_keys: [],
    constraints: [],
    indexes: [],
    computed_fields: {},
    comments: {}
  };

  for (const item of splitComma(match[2]!)) {
    const part = item.trim();
    const pk = part.match(/^PRIMARY\s+KEY\s*\((.+)\)$/i);
    if (pk) {
      schema.primary_key = { columns: splitComma(pk[1]!).map((column) => column.trim()) };
      schema.required!.push(...schema.primary_key.columns.filter((column) => !schema.required!.includes(column)));
      continue;
    }
    const unique = part.match(/^UNIQUE\s*\((.+)\)$/i);
    if (unique) {
      schema.unique!.push(splitComma(unique[1]!).map((column) => column.trim()));
      continue;
    }

    const [name, ...rest] = part.split(/\s+/);
    if (!name || rest.length === 0) throw new SQLError(`Invalid column definition "${part}".`);
    const definitionText = rest.join(" ");
    schema.columns[name] = parseTypeDefinition(definitionText);
    if (/\bNOT\s+NULL\b/i.test(definitionText)) schema.required!.push(name);
    if (/\bPRIMARY\s+KEY\b/i.test(definitionText)) {
      schema.primary_key = { columns: [name] };
      if (!schema.required!.includes(name)) schema.required!.push(name);
    }
    if (/\bUNIQUE\b/i.test(definitionText)) schema.unique!.push([name]);
  }
  return { kind: "create-table", schema };
}

function parseDropTable(sql: string): QueryPlan {
  const match = sql.match(/^DROP\s+TABLE\s+([A-Za-z0-9_.$-]+)$/i);
  if (!match) throw new SQLError("DROP TABLE syntax: DROP TABLE name.");
  return { kind: "drop-table", table: match[1]! };
}

function parseFrom(fromText: string): Pick<Extract<QueryPlan, { kind: "select" }>, "table" | "alias" | "joins"> {
  const joinAt = findClause(fromText, "JOIN");
  const baseText = (joinAt >= 0 ? fromText.slice(0, joinAt) : fromText).trim();
  const base = parseTableRef(baseText);
  const joins = [];
  let rest = joinAt >= 0 ? fromText.slice(joinAt) : "";
  while (rest.trim()) {
    const withoutJoin = rest.trim().replace(/^JOIN\s+/i, "");
    const nextJoin = findClause(withoutJoin, "JOIN");
    const chunk = (nextJoin >= 0 ? withoutJoin.slice(0, nextJoin) : withoutJoin).trim();
    const onAt = findClause(chunk, "ON");
    if (onAt < 0) throw new SQLError("JOIN requires ON.");
    const ref = parseTableRef(chunk.slice(0, onAt).trim());
    const on = chunk.slice(onAt + "ON".length).trim();
    joins.push({ table: ref.table, ...(ref.alias ? { alias: ref.alias } : {}), on: parseExpression(on) });
    rest = nextJoin >= 0 ? withoutJoin.slice(nextJoin) : "";
  }
  return { table: base.table, ...(base.alias ? { alias: base.alias } : {}), joins };
}

function parseTableRef(text: string): { table: string; alias?: string } {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts[0]) throw new SQLError("Table reference is required.");
  const alias = parts[1]?.toUpperCase() === "AS" ? parts[2] : parts[1];
  return { table: parts[0], ...(alias ? { alias } : {}) };
}

function parseTypeDefinition(text: string): ColumnType {
  const clean = text.replace(/\b(?:NOT\s+NULL|PRIMARY\s+KEY|UNIQUE)\b/gi, "").trim();
  const sized = clean.match(/^([A-Za-z ]+)\((\d+)(?:\s*,\s*(\d+))?\)$/);
  if (!sized) return clean.split(/\s+/)[0]!;
  const type = sized[1]!.trim();
  if (sized[3]) return { type, precision: Number(sized[2]), scale: Number(sized[3]) };
  return { type, length: Number(sized[2]) };
}

function parseLiteral(fragment: string, nextParam: () => RowValue): RowValue {
  const text = fragment.trim();
  if (text === "?") return nextParam();
  if (/^NULL$/i.test(text)) return null;
  if (/^TRUE$/i.test(text)) return true;
  if (/^FALSE$/i.test(text)) return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return text;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  throw new SQLError(`Unsupported SQL literal "${fragment}".`);
}

function splitTuples(text: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") i = skipString(text, i);
    else if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) tuples.push(text.slice(start, i));
    }
  }
  if (depth !== 0 || tuples.length === 0) throw new SQLError("VALUES must contain parenthesized tuples.");
  return tuples;
}

function splitComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") i = skipString(text, i);
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim() !== "");
}

function findClause(sql: string, clause: string): number {
  const upper = sql.toUpperCase();
  const target = clause.toUpperCase();
  let depth = 0;
  for (let i = 0; i <= sql.length - target.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      i = skipString(sql, i);
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && upper.slice(i, i + target.length) === target && isBoundary(sql[i - 1]) && isBoundary(sql[i + target.length])) return i;
  }
  return -1;
}

function skipString(sql: string, quoteAt: number): number {
  for (let i = quoteAt + 1; i < sql.length; i++) {
    if (sql[i] === "'" && sql[i + 1] === "'") {
      i++;
      continue;
    }
    if (sql[i] === "'") return i;
  }
  throw new SQLError("Unterminated SQL string literal.");
}

function minPositive(...values: number[]): number {
  return Math.min(...values.filter((value) => value >= 0));
}

function isBoundary(ch: string | undefined): boolean {
  return !ch || /\s|\(|\)/.test(ch);
}

function countParams(fragment: string): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    if (fragment[i] === "'") i = skipString(fragment, i);
    else if (fragment[i] === "?") count++;
  }
  return count;
}
