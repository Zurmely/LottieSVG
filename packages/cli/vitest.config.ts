import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@svg2lottie/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
});
