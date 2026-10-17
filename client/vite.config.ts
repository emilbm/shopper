import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from a phone on the LAN during development
    port: 5174,
    // The original Host header is kept: the server refuses changes whose Origin
    // is another host, and from the browser's side that would be every one.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } },
    // shared/ holds runtime code as well as types, and sits outside this root.
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
