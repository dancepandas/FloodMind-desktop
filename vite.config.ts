import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects the dev server on port 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
