import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// The repo root is found by walking up to the lockfile: this works whether the config
// is loaded as CJS or ESM, and from any cwd inside the workspace.
function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'package-lock.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '../..');
}

const repoRoot = findRepoRoot(process.cwd());

const nextConfig: NextConfig = {
  output: 'standalone',
  // Without this, files outside apps/dashboard (hoisted node_modules, packages/core)
  // are not traced into the standalone bundle.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // @sm/core ships raw TypeScript.
  transpilePackages: ['@sm/core'],
  // pg is external by default, pg-boss is not.
  serverExternalPackages: ['pg-boss'],
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: '6mb' },
  },
};

export default nextConfig;
