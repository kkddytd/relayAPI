import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 6722,
    strictPort: false,
  },
  preview: {
    host: "127.0.0.1",
    port: 6722,
    strictPort: false,
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
