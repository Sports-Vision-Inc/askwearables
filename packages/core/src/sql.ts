// A minimal SQL interface so the same store code runs inside a Durable Object (ctx.storage.sql)
// and in Node tests (node:sqlite).

export type SqlValue = string | number | null;

export interface Sql {
  all<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[];
  /** Run a write; returns the number of rows written. */
  run(query: string, ...bindings: SqlValue[]): number;
  transaction<T>(fn: () => T): T;
}

/** Adapter for Durable Object SQLite storage. */
export function doSql(storage: {
  sql: { exec(q: string, ...b: SqlValue[]): { toArray(): unknown[]; rowsWritten: number } };
  transactionSync<T>(fn: () => T): T;
}): Sql {
  return {
    all: <T>(q: string, ...b: SqlValue[]) => storage.sql.exec(q, ...b).toArray() as T[],
    run: (q, ...b) => storage.sql.exec(q, ...b).rowsWritten,
    transaction: (fn) => storage.transactionSync(fn),
  };
}
