import { defineConfig } from "vite";

// `npm run dev` proxies API and WebSocket traffic to a running markout server.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
});
