import { resolve } from "node:path";
import { defineConfig } from "vite";

// Three windows, three pages: the island at the top of the screen, the settings window,
// and the roam overlay Mamori runs across to reach the mouse pointer.
// dev/ holds preview pages (open http://127.0.0.1:1420/dev/roam.html while `npm run dev` runs).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    // three.js (Mamori's 3D body) is one shared ~600 kB chunk, loaded from disk.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        roam: resolve(__dirname, "roam.html"),
      },
    },
  },
});
