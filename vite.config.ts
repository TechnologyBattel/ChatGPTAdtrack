import { defineConfig, type PreviewOptions, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The preview proxy serves this app from https://<port>-<sandbox>.e2b.app, so the
// Host header is not localhost. allowedHosts:true keeps the live preview working.
const server = {
  host: '0.0.0.0',
  port: 5173,
  strictPort: true,
  allowedHosts: true,
} as unknown as ServerOptions;

const preview = {
  host: '0.0.0.0',
  port: 4173,
  allowedHosts: true,
} as unknown as PreviewOptions;

export default defineConfig({
  plugins: [react()],
  server,
  preview,
});
