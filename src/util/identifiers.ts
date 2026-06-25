import { ValidationError } from "../errors.js";

const NAME_RE = /^[A-Za-z0-9_\-.$]+$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function assertValidName(kind: string, name: string): void {
  if (!isValidName(name)) {
    throw new ValidationError(`${kind} "${name}" must use only letters, numbers, _, -, ., or $.`);
  }
}

export function columnNames(columns: Record<string, unknown>): string[] {
  return Object.keys(columns);
}

export function keyFor(values: unknown[]): string {
  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}
