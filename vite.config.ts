import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3100',
        ws: true,
        changeOrigin: true,
      },
      '/world': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
