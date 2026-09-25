import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use core sources directly so edits show up without rebuilding the package.
    alias: {
      '@svg2lottie/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@svg2lottie/a11y': fileURLToPath(new URL('../../packages/a11y/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173, host: '127.0.0.1', fs: { allow: ['../..'] } },
});
