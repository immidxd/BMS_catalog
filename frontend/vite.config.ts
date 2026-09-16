import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-проксі на backend каталогу (порт 8001)
export default defineConfig({
  plugins: [react()],
  // Дві сторінки в одній збірці: вітрина (index.html) і Mini App складу (wh.html → /wh).
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        wh: 'wh.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8001',
      '/product-images': 'http://localhost:8001',
    },
  },
});
