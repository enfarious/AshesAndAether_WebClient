import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

/**
 * Strip the `crossorigin` attribute Vite injects on <script> and <link> tags.
 *
 * Tauri v2 serves the front-end from `https://tauri.localhost` via a custom
 * protocol.  The `crossorigin` attribute causes the webview to make CORS
 * requests that the custom protocol doesn't answer with the right headers,
 * so both JS and CSS silently fail to load.
 */
function tauriCrossOriginFix(): Plugin {
  return {
    name: 'tauri-crossorigin-fix',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
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
  plugins: [tauriCrossOriginFix()],
});
