import { DatabaseSync } from 'node:sqlite';

/**
 * 基于 Node 内置 node:sqlite 的薄适配层，提供与 better-sqlite3 一致的最小接口
 * （prepare/run/get/all、exec、pragma、transaction），避免原生编译依赖。
 * transaction 支持嵌套（内层退化为 SAVEPOINT）。
 */

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DB {
  exec(sql: string): void;
  pragma(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export function createDatabase(path: string): DB {
  const db = new DatabaseSync(path);
  let txDepth = 0;

  return {
    exec: (sql) => db.exec(sql),
    pragma: (sql) => db.exec(`PRAGMA ${sql}`),
    prepare: (sql) => db.prepare(sql) as Statement,
    transaction<T>(fn: () => T): () => T {
      return (): T => {
        const nested = txDepth > 0;
        const savepoint = `sp_${txDepth}`;
        db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
        txDepth += 1;
        try {
          const result = fn();
          txDepth -= 1;
          db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
          return result;
        } catch (err) {
          txDepth -= 1;
          if (nested) {
            db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            db.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            db.exec('ROLLBACK');
          }
          throw err;
        }
      };
    },
    close: () => db.close(),
  };
}
