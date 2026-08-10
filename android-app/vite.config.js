import { defineConfig } from 'vite';

export default defineConfig({
  root: 'www-src',
  build: {
    outDir: '../www',
    emptyOutDir: true,
  },
});
