const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');
const path = require('node:path');

module.exports = defineConfig({
  root: __dirname,
  plugins: [vue()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } }
});
