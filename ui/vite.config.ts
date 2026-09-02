import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_ORIGIN = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": { target: BACKEND_ORIGIN, changeOrigin: true, ws: true },
      "/health": { target: BACKEND_ORIGIN, changeOrigin: true },
      "/setup": { target: BACKEND_ORIGIN, changeOrigin: true },
    },
  },
});
