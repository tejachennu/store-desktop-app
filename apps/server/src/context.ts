import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { TokenService } from './auth/tokens.js';

export interface AppContext {
  db: Db;
  tokens: TokenService;
  log: Logger;
  config: Config;
}
