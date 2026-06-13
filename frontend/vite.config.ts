import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-проксі на backend каталогу (порт 8001)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8001',
      '/product-images': 'http://localhost:8001',
    },
  },
});
