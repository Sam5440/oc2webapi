import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // 本地开发时把 /api 代理到 mock 中转（MOCK=1）或 vercel dev
      "/api": {
        target: process.env.MOCK ? "http://localhost:8931" : "http://localhost:8940",
        changeOrigin: false,
      },
    },
  },
});
