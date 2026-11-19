import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeProcess = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
const productionOutDir = runtimeProcess.process?.env?.PANEL_PRODUCTION_BUILD_OUT_DIR;
const dashboardBuildOutDir = runtimeProcess.process?.env?.PANEL_DASHBOARD_BUILD_OUT_DIR;

export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    ...(productionOutDir || dashboardBuildOutDir
      ? { outDir: productionOutDir ?? dashboardBuildOutDir, emptyOutDir: true } : {}),
    rollupOptions: { input: {
      dashboard: fileURLToPath(new URL("./index.html", import.meta.url)),
      tvRemote: fileURLToPath(new URL("./remote/index.html", import.meta.url))
    } }
  },
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
