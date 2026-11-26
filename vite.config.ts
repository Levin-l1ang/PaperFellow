import { fileURLToPath } from 'node:url';
import { cpSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'local-pdfjs-resources',
    closeBundle() {
      for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        cpSync(new URL(`./node_modules/pdfjs-dist/${folder}`, import.meta.url), new URL(`./dist/pdfjs/${folder}`, import.meta.url), { recursive: true });
      }
    },
  }],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        diagram: fileURLToPath(new URL('./diagram.html', import.meta.url)),
      },
    },
  },
});
