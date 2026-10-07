import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Cave & Terroir',
        short_name: 'Cave',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#FCF9F3',
        theme_color: '#8B612C',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Variante « maskable » : fond plein et verre dans la zone sûre, que
          // Android découpe en cercle ou en carré arrondi sans rogner le dessin.
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.startsWith('/api/'), handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
});
