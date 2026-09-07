import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  server: { host: "127.0.0.1", hmr: { host: "127.0.0.1" } },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  esbuild: { jsx: "automatic" },
});
