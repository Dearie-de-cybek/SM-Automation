import { defineConfig } from 'tsup';

// @sm/core ships raw TypeScript, so it must be bundled rather than resolved at runtime.
export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  noExternal: ['@sm/core'],
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
});
