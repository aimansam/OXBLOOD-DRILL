import { defineConfig } from 'vite';

export default defineConfig({
  base: '/drill/three/',
  build: {
    outDir: '../app/three',
    emptyOutDir: true,
  },
});
