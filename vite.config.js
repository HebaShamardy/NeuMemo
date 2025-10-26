import { defineConfig } from 'vite';
import { resolve, basename } from 'path';
import fs from 'fs';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Vite config tailored for a Chrome extension in `src/`.
// - keeps predictable filenames for manifest and entries
// - processes viewer.html so its scripts and CSS are bundled
// - copies manifest.json to the dist root after build
export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait()
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Entries: keep these names predictable so manifest can reference them
      input: {
        background: resolve(__dirname, 'src/background.js'),
        firebase_ai: resolve(__dirname, 'src/firebase_ai.js'),
        content: resolve(__dirname, 'src/content.js'),
        viewer: resolve(__dirname, 'src/viewer.html'),
      },
      output: {
        // preserve entry names (background.js, content.js, etc.)
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
      plugins: [
        // Small Rollup plugin to copy the manifest to the output root so
        // Chrome can find it at dist/manifest.json. We copy the file
        // instead of treating it as a JS entry to avoid renaming/hash.
        {
          name: 'copy-manifest-to-dist',
          writeBundle() {
            try {
              const srcManifest = resolve(__dirname, 'src/manifest.json');
              const destManifest = resolve(__dirname, 'dist', basename(srcManifest));
              if (fs.existsSync(srcManifest)) {
                fs.copyFileSync(srcManifest, destManifest);
                // eslint-disable-next-line no-console
                console.log('Copied manifest.json to dist/');
              }

              // Some Vite builds emit HTML entries under dist/src/*.html when the
              // source HTML is in `src/`. Chrome extensions expect viewer.html at
              // the dist root (chrome.runtime.getURL('viewer.html')). If Vite
              // placed the built HTML under dist/src, copy it to the root.
              const builtViewer = resolve(__dirname, 'dist', 'src', 'viewer.html');
              const destViewer = resolve(__dirname, 'dist', 'viewer.html');
              if (fs.existsSync(builtViewer)) {
                fs.copyFileSync(builtViewer, destViewer);
                // eslint-disable-next-line no-console
                console.log('Moved built viewer.html to dist/');
              }
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('Failed to copy manifest or viewer to dist:', err);
            }
          },
        },
      ],
    },
  },
});
