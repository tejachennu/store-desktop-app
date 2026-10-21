import 'dotenv/config';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://store:store@localhost:5432/store', 2);
migrate(pool, console.log)
  .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s)` : 'Database is up to date'))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
