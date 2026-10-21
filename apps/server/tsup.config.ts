import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'migrate-cli': 'src/db/migrate-cli.ts', seed: 'src/db/seed.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // The shared workspace package is TypeScript source: bundle it; keep npm deps external.
  noExternal: ['@store/shared'],
});
