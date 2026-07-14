import { defineConfig } from "vite";

// Tauri expects a fixed dev port and a plain SPA build in ../dist.
export default defineConfig({
  // Vite's dev server; Tauri's devUrl points here.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // Emit a linked external stylesheet (never inline <style>) so the strict
    // CSP can keep style-src 'self' with no 'unsafe-inline'.
    cssCodeSplit: false,
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    // Keep bundled assets same-origin; no CDN, no remote fetch (read-only posture).
    assetsInlineLimit: 4096,
  },
});
