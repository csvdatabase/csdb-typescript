import { ValidationError } from "../errors.js";

export interface CsvCell {
  text: string;
  quoted: boolean;
}

export type CsvRecord = CsvCell[];

export function parseCsv(text: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let row: CsvRecord = [];
  let cell = "";
  let quoted = false;
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"' && cell === "") {
      quoted = true;
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push({ text: cell, quoted });
      cell = "";
      quoted = false;
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push({ text: cell, quoted });
      rows.push(row);
      row = [];
      cell = "";
      quoted = false;
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  if (inQuotes) {
    throw new ValidationError("CSV contains an unterminated quoted field.");
  }
  if (cell.length > 0 || quoted || row.length > 0) {
    row.push({ text: cell, quoted });
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(records: string[][]): string {
  return records.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function escapeCsvCell(value: string): string {
  const mustQuote = value === "" || /[",\n\r]/.test(value);
  const escaped = value.replaceAll('"', '""');
  return mustQuote ? `"${escaped}"` : escaped;
}

export function assertCsvWidth(row: CsvRecord, width: number, label: string): void {
  if (row.length !== width) {
    throw new ValidationError(`${label} has ${row.length} fields; expected ${width}.`);
  }
}
