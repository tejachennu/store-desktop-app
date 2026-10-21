import { cpSync } from 'node:fs';
cpSync(new URL('../src/db/migrations', import.meta.url), new URL('../dist/migrations', import.meta.url), { recursive: true });
