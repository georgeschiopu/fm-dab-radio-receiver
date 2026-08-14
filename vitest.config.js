import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['server/**/*.test.js', 'client/src/**/*.test.js', 'client/src/**/*.test.jsx'],
    environmentMatchGlobs: [['client/src/**', 'jsdom']],
    setupFiles: ['./client/src/test/setup.js'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});