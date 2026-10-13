import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from a phone on the LAN during development
    port: 5174,
    proxy: { '/api': 'http://localhost:8080' },
    // shared/ holds runtime code as well as types, and sits outside this root.
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
