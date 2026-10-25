import { defineConfig, type PreviewOptions, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { contentSecurityPolicy } from './server/csp.mjs';

// The preview serves this app from https://<port>-<sandbox>.e2b.app, so the Host
// header is not localhost: allowedHosts:true keeps the live preview working.
// /api is proxied to the local API server, because the browser must never call
// api.ads.openai.com or bzr.openai.com directly (the keys live on the server).
const proxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
    secure: false,
  },
};

const server = {
  host: '0.0.0.0',
  port: 5173,
  strictPort: true,
  allowedHosts: true,
  proxy,
} as unknown as ServerOptions;

const preview = {
  host: '0.0.0.0',
  port: 4173,
  allowedHosts: true,
  proxy,
} as unknown as PreviewOptions;

/**
 * Send the app's security headers from the dev and preview servers, so what the
 * preview shows is what production sends. The dev policy is the relaxed one
 * (inline preamble + HMR websocket); the preview is built output, so it gets the
 * production policy verbatim.
 */
type Middleware = (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void;
type ServerLike = { middlewares: { use: (fn: Middleware) => void } };

function securityHeaders(dev: boolean) {
  const headers = contentSecurityPolicy({ dev });
  const attach = (server: ServerLike) => {
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      next();
    });
  };
  return {
    name: 'adtrack-security-headers',
    configureServer(server: ServerLike) {
      attach(server);
    },
    configurePreviewServer(server: ServerLike) {
      attach(server);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), securityHeaders(command === 'serve')],
  server,
  preview,
}));
