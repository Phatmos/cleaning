import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:3001' } },
  test: { root: '.', include: ['tests/**/*.test.ts'], exclude: ['tests/_local/**', 'node_modules/**'] },
} as any);
