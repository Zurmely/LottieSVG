import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@svg2lottie\/core\/node$/, replacement: src('node.ts') },
      { find: /^@svg2lottie\/core$/, replacement: src('index.ts') },
    ],
  },
});
