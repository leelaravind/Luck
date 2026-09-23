import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = Number(process.env.LUCK_PORT ?? 3717);
const WEB_PORT = Number(process.env.LUCK_WEB_PORT ?? 5717);

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    // Dev UI gets frame protection too (reviewer D9). Vite HMR needs inline/eval + ws, so the CSP is
    // limited to what is safe in development; production responses use the strict CSP from the server.
    headers: {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    },
    proxy: {
      // Forward API calls only. The frontend also has a src/web/api/ source folder, so requests for
      // its modules (/api/client.ts, …) must stay with Vite instead of being proxied to the backend.
      '^/api/(?!.*\\.(?:ts|tsx|js|jsx|mjs|css|map)(?:\\?|$))': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  preview: { host: '127.0.0.1', port: WEB_PORT, strictPort: true },
});
