import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/migrations in dev, dist/migrations after build
  for (const candidate of [join(here, 'migrations'), join(here, '..', 'migrations')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Migrations directory not found');
}

/**
 * Applies pending *.sql migrations in filename order, each in its own transaction,
 * under an advisory lock so concurrent server instances don't race.
 */
export async function migrate(db: Db, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727272)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
  return applied;
}
