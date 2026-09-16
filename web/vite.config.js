import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: { input: { index: here('./index.html'), login: here('./login.html') } },
    chunkSizeWarningLimit: 1000,
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8740' } },
});
