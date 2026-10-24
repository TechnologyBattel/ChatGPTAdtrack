import { defineConfig, type PreviewOptions, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react()],
  server,
  preview,
});
