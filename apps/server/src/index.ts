import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { TokenService } from './auth/tokens.js';
import { createApp } from './app.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createPool(config.DATABASE_URL, config.DB_POOL_MAX);

async function main() {
  await migrate(db, (m) => log.info(m));
  const app = createApp({ db, log, config, tokens: new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_MINUTES) });
  const server = app.listen(config.PORT, () => log.info(`Central API listening on :${config.PORT}`));
  const shutdown = (sig: string) => {
    log.info(`${sig} received, shutting down`);
    server.close(() => db.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});
