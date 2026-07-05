import YAML from "yaml";
import type { CSDBDocument, CSDBMetadata, ColumnType, MachineSection, Row, Table, TableSchema } from "../types.js";
import { ValidationError } from "../errors.js";
import { normalizeSchema, storedColumnNames, validateDocument } from "../catalog.js";
import { decodeCell, encodeValue } from "../typeRegistry.js";
import { assertCsvWidth, parseCsv, stringifyCsv, type CsvWritableCell } from "../util/csv.js";
import { assertValidName, columnNames, keyFor } from "../util/identifiers.js";

interface RawSection {
  name: string;
  content: string;
}

interface FixedWidths {
  key: number;
  value: number;
  title: number;
  footerEntries: number;
}

export interface ParseOptions {
  validate?: boolean;
}

export interface SerializeOptions {
  machineIndexes?: "auto" | "omit";
}

export function parseDocument(text: string, options: ParseOptions = {}): CSDBDocument {
  const sections = splitSections(text);
  if (sections[0]?.name !== "csdb") throw new ValidationError("First section must be --- csdb.");
  validateSectionOrder(sections);

  const metadata = parseYaml<CSDBMetadata>(sections[0].content, "csdb");
  const tables = new Map<string, Table>();
  const tableOrder: string[] = [];
  const machineSections: MachineSection[] = [];

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]!;
    const parsed = parseTableSectionName(section.name);
    if (!parsed) {
      machineSections.push({ name: section.name, raw: section.content });
      continue;
    }
    if (parsed.kind !== "schema") continue;
    const dataSection = sections[i + 1];
    if (!dataSection || dataSection.name !== `table:${parsed.table}:data`) {
      throw new ValidationError(`Table "${parsed.table}" must have schema followed by data.`);
    }
    const schema = normalizeSchema(parseYaml<TableSchema>(section.content, section.name));
    const rows = parseTableData(parsed.table, schema, dataSection.content);
    tables.set(parsed.table, { name: parsed.table, schema, rows });
    tableOrder.push(parsed.table);
    i++;
  }

  const document: CSDBDocument = {
    metadata,
    tableOrder,
    tables,
    machineSections
  };
  if (options.validate !== false) validateDocument(document);
  return document;
}

export function serializeDocument(document: CSDBDocument, options: SerializeOptions = {}): string {
  validateDocument(document);
  const machineMode = options.machineIndexes ?? "auto";
  const metadata = { ...document.metadata, tables: [...document.tableOrder] };
  if (machineMode === "omit" && metadata.machine_indexing) {
    metadata.machine_indexing = { ...metadata.machine_indexing, enabled: false };
  }

  const human = [
    section("csdb", stringifyYaml(metadata)),
    ...document.tableOrder.flatMap((name) => {
      const table = mustTable(document, name);
      return [
        section(`table:${name}:schema`, stringifyYaml(table.schema)),
        section(`table:${name}:data`, stringifyTableData(table))
      ];
    })
  ];

  if (machineMode === "omit" || metadata.machine_indexing?.enabled !== true) {
    return human.join("");
  }
  return [...human, ...buildMachineSections(document, human.map((text, index) => sectionRecordName(document, index, text)))].join("");
}

function parseTableData(tableName: string, schema: TableSchema, text: string): Row[] {
  const normalized = normalizeSchema(schema);
  const records = parseCsv(text.replace(/\n+$/, ""));
  if (records.length === 0) throw new ValidationError(`Table "${tableName}" data must include a CSV header.`);
  const expected = storedColumnNames(normalized);
  const header = records[0]!.map((cell) => cell.text);
  if (header.join("\0") !== expected.join("\0")) {
    throw new ValidationError(`Table "${tableName}" CSV header must match schema order.`);
  }

  const required = new Set(normalized.required);
  return records.slice(1).filter((row) => row.length > 1 || row[0]?.text !== "").map((record, index) => {
    assertCsvWidth(record, expected.length, `Table "${tableName}" row ${index + 1}`);
    const row: Row = {};
    expected.forEach((column, columnIndex) => {
      const definition = columnDefinition(normalized, column);
      row[column] = decodeCell(column, definition, record[columnIndex]!, required.has(column));
    });
    return row;
  });
}

export function stringifyTableData(table: Table): string {
  const columns = storedColumnNames(table.schema);
  const required = new Set(table.schema.required);
  const records: CsvWritableCell[][] = [
    columns,
    ...table.rows.map((row) =>
      columns.map((column) => {
        const value = row[column] ?? null;
        const text = encodeValue(column, columnDefinition(table.schema, column), value, required.has(column));
        return { text, quoted: value !== null && text === "" };
      })
    )
  ];
  return stringifyCsv(records);
}

function columnDefinition(schema: TableSchema, column: string): ColumnType {
  const direct = schema.columns[column];
  if (direct) return direct;
  const computed = schema.computed_fields?.[column];
  if (computed) return computed.type;
  throw new ValidationError(`Unknown column "${column}".`);
}

function splitSections(text: string): RawSection[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const sections: RawSection[] = [];
  let current: RawSection | undefined;

  for (const line of lines) {
    const header = line.match(/^---\s+(.+?)\s*$/);
    if (header) {
      if (current) current.content = current.content.replace(/\n$/, "");
      current = { name: header[1]!.trimEnd(), content: "" };
      sections.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() !== "") throw new ValidationError("CSDB content before first section header.");
      continue;
    }
    current.content += `${line}\n`;
  }
  if (current) current.content = current.content.replace(/\n$/, "");
  return sections;
}

function validateSectionOrder(sections: RawSection[]): void {
  let phase: "tables" | "row-index" | "section-index" | "footer" = "tables";
  const completed = new Set<string>();
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]!;
    const table = parseTableSectionName(section.name);
    if (table) {
      if (phase !== "tables") throw new ValidationError("Human table sections must appear before machine sections.");
      assertValidName("Table name", table.table);
      if (table.kind !== "schema") throw new ValidationError(`Table "${table.table}" data appeared before schema.`);
      if (completed.has(table.table)) throw new ValidationError(`Table "${table.table}" appears more than once.`);
      const next = sections[i + 1];
      if (!next || next.name !== `table:${table.table}:data`) throw new ValidationError(`Table "${table.table}" schema must be followed by data.`);
      completed.add(table.table);
      i++;
      continue;
    }

    if (section.name.startsWith("row_index:")) {
      if (phase === "section-index" || phase === "footer") throw new ValidationError("row_index sections must precede section_index.");
      phase = "row-index";
      continue;
    }
    if (section.name === "section_index") {
      if (phase === "footer") throw new ValidationError("section_index must precede footer.");
      phase = "section-index";
      continue;
    }
    if (section.name === "footer") {
      phase = "footer";
      continue;
    }
    throw new ValidationError(`Unknown section "${section.name}".`);
  }
}

function parseTableSectionName(name: string): { table: string; kind: "schema" | "data" } | undefined {
  const match = name.match(/^table:([^:]+):(schema|data)$/);
  if (!match) return undefined;
  return { table: match[1]!, kind: match[2] as "schema" | "data" };
}

function parseYaml<T>(source: string, label: string): T {
  try {
    return YAML.parse(source) as T;
  } catch (error) {
    throw new ValidationError(`Invalid YAML in ${label}: ${(error as Error).message}`);
  }
}

function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 }).trimEnd();
}

function section(name: string, content: string): string {
  return `--- ${name}\n${content.trimEnd()}\n\n`;
}

function mustTable(document: CSDBDocument, name: string): Table {
  const table = document.tables.get(name);
  if (!table) throw new ValidationError(`Unknown table "${name}".`);
  return table;
}

function machineWidths(document: CSDBDocument): FixedWidths {
  const options = document.metadata.machine_indexing;
  return {
    key: options?.machine_key_width ?? 80,
    value: options?.machine_value_width ?? 40,
    title: options?.section_title_length ?? 80,
    footerEntries: options?.footer_entry_count ?? 1
  };
}

function buildMachineSections(document: CSDBDocument, human: { name: string; text: string }[]): string[] {
  const widths = machineWidths(document);
  const rowIndexes = buildRowIndexSections(document, widths);
  const count = human.length + rowIndexes.length + 2;
  const sectionIndexLength = widths.title + 1 + count * (widths.key + widths.value + 1) + 1;
  const footerLength = widths.title + 1 + widths.footerEntries * (widths.key + widths.value + 1);
  const records = [
    ...human.map(({ name, text }) => [name, String(byteLength(text))] as const),
    ...rowIndexes.map(({ name, text }) => [name, String(byteLength(text))] as const),
    ["section_index", String(sectionIndexLength)] as const,
    ["footer", String(footerLength)] as const
  ];
  const sectionIndex = machineSection("section_index", records.map(([key, value]) => fixedRecord(widths, key, [value])).join(""), widths);
  const footerRecords = [fixedRecord(widths, "section_index_count", [String(count)])];
  while (footerRecords.length < widths.footerEntries) footerRecords.push(fixedRecord(widths, "", [""]));
  const footer = machineSection("footer", footerRecords.join(""), widths, false);
  return [...rowIndexes.map(({ text }) => text), sectionIndex, footer];
}

function buildRowIndexSections(document: CSDBDocument, widths: FixedWidths): { name: string; text: string }[] {
  const sections: { name: string; text: string }[] = [];
  for (const name of document.tableOrder) {
    const table = mustTable(document, name);
    const pk = table.schema.primary_key;
    if (!pk) continue;
    const dataRows = stringifyTableData(table).split("\n").slice(1);
    const rows = table.rows
      .map((row, index) => ({
        key: keyFor(pk.columns.map((column) => row[column] ?? null)),
        rowNumber: index + 1,
        rowLength: byteLength(`${dataRows[index] ?? ""}\n`)
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const body =
      fixedRecord(widths, "strategy", ["sorted_binary"]) +
      rows.map((row) => fixedRecord(widths, row.key, [String(row.rowNumber), String(row.rowLength)])).join("");
    const sectionName = `row_index:${name}:${pk.columns.join("+")}`;
    sections.push({ name: sectionName, text: machineSection(sectionName, body, widths) });
  }
  return sections;
}

function machineSection(name: string, body: string, widths: FixedWidths, trailingBlank = true): string {
  const title = `--- ${name}`.padEnd(widths.title, " ");
  return `${title}\n${body}${trailingBlank ? "\n" : ""}`;
}

function fixedRecord(widths: FixedWidths, key: string, values: string[]): string {
  if (Buffer.byteLength(key, "utf8") > widths.key) throw new ValidationError(`Machine key "${key}" exceeds width ${widths.key}.`);
  return `${key.padEnd(widths.key, " ")}${values.map((value) => value.padStart(widths.value, " ")).join("")}\n`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sectionRecordName(document: CSDBDocument, index: number, text: string): { name: string; text: string } {
  if (index === 0) return { name: "csdb", text };
  const tableIndex = Math.floor((index - 1) / 2);
  const tableName = document.tableOrder[tableIndex]!;
  return { name: `table:${tableName}:${(index - 1) % 2 === 0 ? "schema" : "data"}`, text };
}
