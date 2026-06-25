import type { ColumnType, RowValue } from "./types.js";
import type { CsvCell } from "./util/csv.js";
import { ValidationError } from "./errors.js";

export interface TypeInfo {
  canonical: string;
  options: Record<string, unknown>;
}

const aliases: Record<string, string> = {
  "character varying": "varchar",
  int: "integer",
  int4: "integer",
  int8: "bigint",
  decimal: "numeric",
  bool: "boolean"
};

const implemented = new Set([
  "text",
  "varchar",
  "integer",
  "bigint",
  "real",
  "numeric",
  "boolean",
  "date",
  "timestamp",
  "json",
  "custom"
]);

export function typeInfo(definition: ColumnType): TypeInfo {
  if (typeof definition === "string") {
    return { canonical: normalizeType(definition), options: {} };
  }
  const raw = definition.type;
  if (typeof raw !== "string") {
    throw new ValidationError("Column type object is missing a string type field.");
  }
  const { type: _type, ...options } = definition;
  return { canonical: normalizeType(raw), options };
}

export function normalizeType(type: string): string {
  const lower = type.toLowerCase();
  return aliases[lower] ?? lower;
}

export function assertSupportedType(column: string, definition: ColumnType): void {
  const info = typeInfo(definition);
  if (!implemented.has(info.canonical)) {
    throw new ValidationError(`Column "${column}" uses unsupported type "${info.canonical}".`);
  }
  if (info.canonical === "custom" && typeof info.options.type_name !== "string") {
    throw new ValidationError(`Column "${column}" uses custom type without type_name.`);
  }
}

export function decodeCell(column: string, definition: ColumnType, cell: CsvCell, required: boolean): RowValue {
  if (cell.text === "" && !cell.quoted) {
    if (required) throw new ValidationError(`Required column "${column}" contains null.`);
    return null;
  }

  const info = typeInfo(definition);
  switch (info.canonical) {
    case "text":
    case "varchar":
    case "custom":
      assertLength(column, cell.text, info.options);
      return cell.text;
    case "integer":
      return parseInteger(column, cell.text);
    case "bigint":
      return parseBigInt(column, cell.text);
    case "real":
      return parseReal(column, cell.text, info.options);
    case "numeric":
      return parseNumeric(column, cell.text);
    case "boolean":
      if (cell.text !== "true" && cell.text !== "false") {
        throw new ValidationError(`Column "${column}" expects boolean text true or false.`);
      }
      return cell.text === "true";
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cell.text)) {
        throw new ValidationError(`Column "${column}" expects date YYYY-MM-DD.`);
      }
      return cell.text;
    case "timestamp":
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(cell.text)) {
        throw new ValidationError(`Column "${column}" expects ISO timestamp text.`);
      }
      return cell.text;
    case "json":
      try {
        return JSON.parse(cell.text) as RowValue;
      } catch {
        throw new ValidationError(`Column "${column}" contains invalid JSON.`);
      }
    default:
      throw new ValidationError(`Column "${column}" uses unsupported type "${info.canonical}".`);
  }
}

export function encodeValue(column: string, definition: ColumnType, value: RowValue, required: boolean): string {
  if (value === null || value === undefined) {
    if (required) throw new ValidationError(`Required column "${column}" cannot be null.`);
    return "";
  }
  const info = typeInfo(definition);
  switch (info.canonical) {
    case "text":
    case "varchar":
    case "custom": {
      const text = String(value);
      assertLength(column, text, info.options);
      return text;
    }
    case "integer":
      return String(parseInteger(column, String(value)));
    case "bigint":
      return String(parseBigInt(column, String(value)));
    case "real":
      return String(parseReal(column, String(value), info.options));
    case "numeric":
      return parseNumeric(column, String(value));
    case "boolean":
      if (typeof value !== "boolean") throw new ValidationError(`Column "${column}" expects boolean.`);
      return value ? "true" : "false";
    case "date":
    case "timestamp":
      return String(decodeCell(column, definition, { text: String(value), quoted: false }, true));
    case "json":
      return typeof value === "string" ? JSON.stringify(JSON.parse(value)) : JSON.stringify(value);
    default:
      throw new ValidationError(`Column "${column}" uses unsupported type "${info.canonical}".`);
  }
}

function assertLength(column: string, value: string, options: Record<string, unknown>): void {
  if (typeof options.length === "number" && value.length > options.length) {
    throw new ValidationError(`Column "${column}" exceeds length ${options.length}.`);
  }
}

function parseInteger(column: string, text: string): number {
  if (!/^-?\d+$/.test(text)) throw new ValidationError(`Column "${column}" expects an integer.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ValidationError(`Column "${column}" integer is outside safe range.`);
  return value;
}

function parseBigInt(column: string, text: string): bigint {
  if (!/^-?\d+$/.test(text)) throw new ValidationError(`Column "${column}" expects a bigint.`);
  return BigInt(text);
}

function parseReal(column: string, text: string, options: Record<string, unknown>): number {
  if ((text === "NaN" && options.allow_nan === true) || (/^[+-]?Infinity$/.test(text) && options.allow_infinity === true)) {
    return Number(text);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) throw new ValidationError(`Column "${column}" expects a finite real number.`);
  return value;
}

function parseNumeric(column: string, text: string): string {
  if (!/^-?(?:\d+|\d+\.\d+)$/.test(text)) {
    throw new ValidationError(`Column "${column}" expects exact numeric text.`);
  }
  return text;
}
