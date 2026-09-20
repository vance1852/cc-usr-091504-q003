import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * 基于 Node 内置 node:sqlite 的薄兼容层，对齐本服务用到的 better-sqlite3 语义：
 * - 同步 API；
 * - db.transaction(fn) 支持嵌套（内层自动降级为 SAVEPOINT）；
 * - UNIQUE 冲突归一化为 err.code === 'SQLITE_CONSTRAINT_UNIQUE'。
 */

function normalizeError(e: unknown): unknown {
  if (e instanceof Error && (e as { code?: string }).code === 'ERR_SQLITE_ERROR' && e.message.startsWith('UNIQUE constraint failed')) {
    Object.assign(e, { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  }
  return e;
}

export class Statement {
  constructor(private inner: StatementSync) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    try {
      return this.inner.run(...(params as never[])) as { changes: number; lastInsertRowid: number | bigint };
    } catch (e) {
      throw normalizeError(e);
    }
  }

  get(...params: unknown[]): unknown {
    try {
      return this.inner.get(...(params as never[]));
    } catch (e) {
      throw normalizeError(e);
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      return this.inner.all(...(params as never[])) as unknown[];
    } catch (e) {
      throw normalizeError(e);
    }
  }
}

export class SqliteDB {
  private readonly sync: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    this.sync = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.sync.exec(sql);
  }

  pragma(sql: string): void {
    this.sync.exec(`PRAGMA ${sql}`);
  }

  prepare(sql: string): Statement {
    return new Statement(this.sync.prepare(sql));
  }

  /** 返回可重复调用的事务函数；嵌套调用自动使用 SAVEPOINT。 */
  transaction<T>(fn: () => T): () => T {
    return () => {
      if (this.txDepth === 0) {
        this.exec('BEGIN IMMEDIATE');
        this.txDepth++;
        try {
          const result = fn();
          this.exec('COMMIT');
          return result;
        } catch (e) {
          try {
            this.exec('ROLLBACK');
          } catch {
            // 连接已异常时忽略回滚错误
          }
          throw e;
        } finally {
          this.txDepth--;
        }
      }
      const name = `sp_${this.txDepth}`;
      this.exec(`SAVEPOINT ${name}`);
      this.txDepth++;
      try {
        const result = fn();
        this.exec(`RELEASE ${name}`);
        return result;
      } catch (e) {
        this.exec(`ROLLBACK TO ${name}`);
        this.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        this.txDepth--;
      }
    };
  }

  close(): void {
    this.sync.close();
  }
}
