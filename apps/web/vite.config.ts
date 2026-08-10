import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart({
      server: { entry: "server" },
    }),
    react(),
  ],
  server: {
    host: true,
    strictPort: false,
    // Allow a tunnel hostname (Cloudflare/ngrok) to serve the dev app for the
    // phone QR demo — Vite otherwise blocks unknown Host headers.
    allowedHosts: true,
    // Same-origin backend path so ONE HTTPS tunnel covers the whole demo: the
    // phone hits /api/... on the tunnel origin and Vite forwards to the local
    // backend (no CORS, no mixed content). Set VITE_API_BASE=/api to use it;
    // local laptop dev leaves VITE_API_BASE unset and calls the backend direct.
    proxy: {
      "/api": {
        // 127.0.0.1, not localhost: the backend listens on IPv4 only, and Node
        // may resolve localhost to IPv6 ::1 first -> intermittent proxy failures.
        target: process.env.VITE_PROXY_TARGET || "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
