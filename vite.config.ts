/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentMatchGlobs: [['tests/db/**', 'node']],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/db/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
