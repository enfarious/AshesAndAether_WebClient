import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import http from 'http';

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

/**
 * Proxy local LLM requests during dev to avoid CORS.
 *
 * Rewrites `/llm-proxy/PORT/path` → `http://localhost:PORT/path`.
 * Works for LM Studio, Ollama, or any local inference server.
 * In production (Tauri) the direct URL is used — no CORS enforcement.
 */
function localLLMProxy(): Plugin {
  return {
    name: 'local-llm-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/llm-proxy\/(\d+)(\/.*)/);
        if (!match) return next();

        const targetPort = parseInt(match[1], 10);
        const targetPath = match[2];

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
            'Access-Control-Max-Age': '86400',
          });
          res.end();
          return;
        }

        const proxyReq = http.request(
          {
            hostname: 'localhost',
            port: targetPort,
            path: targetPath,
            method: req.method,
            headers: { ...req.headers, host: `localhost:${targetPort}` },
          },
          (proxyRes) => {
            // Inject CORS headers into the real response
            const headers = { ...proxyRes.headers };
            headers['access-control-allow-origin'] = '*';
            res.writeHead(proxyRes.statusCode ?? 502, headers);
            proxyRes.pipe(res, { end: true });
          },
        );

        proxyReq.on('error', (err) => {
          console.error(`[llm-proxy] Cannot reach localhost:${targetPort}:`, err.message);
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Cannot reach localhost:${targetPort}`);
        });

        req.pipe(proxyReq, { end: true });
      });
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
  plugins: [tauriCrossOriginFix(), localLLMProxy()],
});
