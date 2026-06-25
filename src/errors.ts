export class CSDBError extends Error {
  constructor(message: string, readonly code = "CSDB_ERROR") {
    super(message);
    this.name = "CSDBError";
  }
}

export class ValidationError extends CSDBError {
  constructor(message: string) {
    super(message, "CSDB_VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class SQLError extends CSDBError {
  constructor(message: string) {
    super(message, "CSDB_SQL_ERROR");
    this.name = "SQLError";
  }
}
