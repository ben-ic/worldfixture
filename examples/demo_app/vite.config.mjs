import { defineConfig } from 'vite';

export default defineConfig({
  // The application server mounts Vite on its own loopback listener.
  build: { outDir: 'dist' },
});
