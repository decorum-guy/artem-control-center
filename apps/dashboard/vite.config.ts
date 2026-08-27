import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeProcess = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
const productionOutDir = runtimeProcess.process?.env?.PANEL_PRODUCTION_BUILD_OUT_DIR;
const dashboardBuildOutDir = runtimeProcess.process?.env?.PANEL_DASHBOARD_BUILD_OUT_DIR;

export default defineConfig({
  plugins: [react()],
  build: productionOutDir || dashboardBuildOutDir
    ? { outDir: productionOutDir ?? dashboardBuildOutDir, emptyOutDir: true }
    : undefined,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787"
    }
  }
});
