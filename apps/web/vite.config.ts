import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** SPA (spec §18). `/api` is proxied to the API (API_URL, default the local `pnpm dev` port). */
export default defineConfig({
  plugins: [TanStackRouterVite({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: Number(process.env["WEB_PORT"] ?? 5173),
    strictPort: true,
    host: process.env["WEB_HOST"] ?? "127.0.0.1",
    proxy: { "/api": { target: process.env["API_URL"] ?? "http://127.0.0.1:3000", changeOrigin: true } },
  },
});
