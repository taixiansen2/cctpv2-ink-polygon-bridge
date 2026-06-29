import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Solana / Anchor 依赖 Buffer、process 等 Node 内置对象，浏览器需垫片
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      include: ['buffer', 'process', 'util', 'stream', 'crypto'],
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
})
