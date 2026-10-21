import pg from 'pg';

/** Ensure the e2e PostgreSQL database exists (the store role has CREATEDB). */
export default async function setup() {
  const url = new URL(process.env.TEST_E2E_DATABASE_URL ?? 'postgres://store:store@localhost:5432/store_test_e2e');
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } catch (err) {
    console.warn(`[e2e] PostgreSQL not available (${(err as Error).message}); e2e tests will fail.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
