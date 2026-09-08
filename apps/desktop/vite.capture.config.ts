import { defineConfig } from 'vite';
import path from 'node:path';

// Separate module graph: no App, Markdown, plugins, React providers or chat preload.
export default defineConfig({
  root: path.resolve(__dirname, 'src/capture-renderer'),
  base: './',
  server: { hmr: false },
  build: {
    emptyOutDir: true,
    outDir: path.resolve(__dirname, '.vite/renderer/desktop_capture'),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
