import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

type Bound = ReturnType<DatabaseSync['prepare']>;

export function testDatabase(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_cancelled_attempts.sql', import.meta.url), 'utf8'));

  function prepared(sql: string) {
    const statement = sqlite.prepare(sql);
    return {
      bind(...args: unknown[]) {
        const bound = args as Parameters<Bound['run']>;
        return {
          async first<T>() { return (statement.get(...bound) ?? null) as T | null; },
          async run() { return { meta: { changes: statement.run(...bound).changes } }; },
        };
      },
    };
  }

  const db = {
    prepare: prepared,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

export function addQuestion(sqlite: DatabaseSync, id: string, area: 'CS' | 'CT',
  status: 'draft' | 'reviewed' | 'disabled' = 'reviewed'): void {
  sqlite.prepare(`INSERT INTO questions
    (id, area, subject, prompt, options_json, answer, explanation, key_points_json, status)
    VALUES (?, ?, '예제', '질문', ?, ?, '해설', '[]', ?)`)
    .run(id, area, area === 'CT' ? '["A","B","C","D"]' : null,
      area === 'CT' ? 2 : null, status);
}
