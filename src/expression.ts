import type { ComparisonOp, Expr, Row, RowValue } from "./types.js";
import { SQLError } from "./errors.js";

type Token = { type: "word" | "number" | "string" | "op" | "paren" | "param" | "comma"; value: string };

export function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i++;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (input[i] === "'") break;
        value += input[i]!;
        i++;
      }
      if (input[i] !== "'") throw new SQLError("Unterminated SQL string literal.");
      tokens.push({ type: "string", value });
      i++;
      continue;
    }
    if (/[(),]/.test(ch)) {
      tokens.push({ type: ch === "," ? "comma" : "paren", value: ch });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ type: "param", value: "?" });
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if ([">=", "<=", "!=", "<>"].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (/[=<>]/.test(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    const number = input.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      i += number[0].length;
      continue;
    }
    const word = input.slice(i).match(/^[A-Za-z_.$][A-Za-z0-9_.$-]*/);
    if (word) {
      tokens.push({ type: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    throw new SQLError(`Unexpected token near "${input.slice(i, i + 12)}".`);
  }
  return tokens;
}

export function parseExpression(input: string, params: RowValue[] = []): Expr {
  const parser = new ExpressionParser(tokenizeExpression(input), params);
  const expr = parser.parseOr();
  parser.expectEnd();
  return expr;
}

export function andExpr(left: Expr | undefined, right: Expr): Expr {
  return left ? { type: "and", left, right } : right;
}

export function comparison(column: string, op: ComparisonOp, value: RowValue): Expr {
  return {
    type: "comparison",
    op,
    left: { type: "identifier", name: column },
    right: { type: "literal", value }
  };
}

class ExpressionParser {
  private index = 0;
  private paramIndex = 0;

  constructor(private readonly tokens: Token[], private readonly params: RowValue[]) {}

  parseOr(): Expr {
    let expr = this.parseAnd();
    while (this.matchWord("OR")) expr = { type: "or", left: expr, right: this.parseAnd() };
    return expr;
  }

  private parseAnd(): Expr {
    let expr = this.parseNot();
    while (this.matchWord("AND")) expr = { type: "and", left: expr, right: this.parseNot() };
    return expr;
  }

  private parseNot(): Expr {
    if (this.matchWord("NOT")) return { type: "not", expr: this.parseComparison() };
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parsePrimary();
    if (this.matchWord("IS")) {
      const not = this.matchWord("NOT");
      this.expectWord("NULL");
      return { type: "is-null", expr: left, not };
    }
    const op = this.matchOp();
    if (!op) return left;
    return { type: "comparison", op, left, right: this.parsePrimary() };
  }

  private parsePrimary(): Expr {
    const token = this.next();
    if (!token) throw new SQLError("Unexpected end of expression.");
    if (token.type === "paren" && token.value === "(") {
      const expr = this.parseOr();
      this.expectParen(")");
      return expr;
    }
    if (token.type === "string") return { type: "literal", value: token.value };
    if (token.type === "number") return { type: "literal", value: token.value.includes(".") ? token.value : Number(token.value) };
    if (token.type === "param") {
      if (this.paramIndex >= this.params.length) throw new SQLError("Not enough SQL parameters supplied.");
      return { type: "literal", value: this.params[this.paramIndex++] ?? null };
    }
    if (token.type === "word") {
      const upper = token.value.toUpperCase();
      if (upper === "NULL") return { type: "literal", value: null };
      if (upper === "TRUE") return { type: "literal", value: true };
      if (upper === "FALSE") return { type: "literal", value: false };
      return { type: "identifier", name: token.value };
    }
    throw new SQLError(`Unexpected expression token "${token.value}".`);
  }

  private matchWord(word: string): boolean {
    const token = this.peek();
    if (token?.type === "word" && token.value.toUpperCase() === word) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectWord(word: string): void {
    if (!this.matchWord(word)) throw new SQLError(`Expected ${word}.`);
  }

  private expectParen(paren: string): void {
    const token = this.next();
    if (token?.type !== "paren" || token.value !== paren) throw new SQLError(`Expected "${paren}".`);
  }

  private matchOp(): ComparisonOp | undefined {
    const token = this.peek();
    if (token?.type !== "op") return undefined;
    this.index++;
    return token.value as ComparisonOp;
  }

  expectEnd(): void {
    if (this.index !== this.tokens.length) throw new SQLError(`Unexpected token "${this.tokens[this.index]!.value}".`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    return this.tokens[this.index++];
  }
}

export interface EvalContext {
  baseTable: string;
  rows: Record<string, Row>;
}

export function evaluate(expr: Expr | undefined, context: EvalContext): RowValue | boolean {
  if (!expr) return true;
  switch (expr.type) {
    case "literal":
      return expr.value;
    case "identifier":
      return resolveIdentifier(expr.name, context);
    case "comparison":
      return compareValues(evaluate(expr.left, context) as RowValue, expr.op, evaluate(expr.right, context) as RowValue);
    case "is-null": {
      const isNull = evaluate(expr.expr, context) === null;
      return expr.not ? !isNull : isNull;
    }
    case "and":
      return Boolean(evaluate(expr.left, context)) && Boolean(evaluate(expr.right, context));
    case "or":
      return Boolean(evaluate(expr.left, context)) || Boolean(evaluate(expr.right, context));
    case "not":
      return !Boolean(evaluate(expr.expr, context));
  }
}

export function resolveIdentifier(name: string, context: EvalContext): RowValue {
  const [scope, column, extra] = name.split(".");
  if (scope && column && !extra) {
    const row = context.rows[scope];
    if (row && column in row) return row[column] ?? null;
  }
  const base = context.rows[context.baseTable];
  if (base && name in base) return base[name] ?? null;
  for (const row of Object.values(context.rows)) {
    if (name in row) return row[name] ?? null;
  }
  return null;
}

function compareValues(left: RowValue, op: ComparisonOp, right: RowValue): boolean {
  if (left === null || right === null) return op === "!=" || op === "<>" ? left !== right : left === right && op === "=";
  const [a, b] = coerceComparable(left, right);
  switch (op) {
    case "=":
      return a === b;
    case "!=":
    case "<>":
      return a !== b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
}

function coerceComparable(left: RowValue, right: RowValue): [string | number | bigint | boolean, string | number | bigint | boolean] {
  if (typeof left === "bigint" || typeof right === "bigint") return [BigInt(String(left)), BigInt(String(right))];
  if (typeof left === "number" || typeof right === "number" || numericText(left) || numericText(right)) {
    return [Number(left), Number(right)];
  }
  if (typeof left === "boolean" || typeof right === "boolean") return [Boolean(left), Boolean(right)];
  return [String(left), String(right)];
}

function numericText(value: RowValue): boolean {
  return typeof value === "string" && /^-?(?:\d+|\d+\.\d+)$/.test(value);
}
