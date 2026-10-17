import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (p: string) => path.resolve(root, p);

// Workspace packages ship as TypeScript source; alias them directly so the
// app always builds against the current sources (no per-package build step).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sds/components': pkg('../../packages/components/src/index.ts'),
      '@sds/sim-core': pkg('../../packages/sim-core/src/index.ts'),
      '@sds/problems': pkg('../../packages/problems/src/index.ts'),
      '@sds/checker': pkg('../../packages/checker/src/index.ts'),
      '@sds/driver': pkg('../../packages/driver/src/index.ts'),
      '@sds/lab-consistent-hashing': pkg('../../labs/consistent-hashing/src/index.ts'),
    },
  },
  server: { port: 5173 },
});
