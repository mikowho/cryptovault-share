import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径 base：根目录与任意二级目录部署均兼容（如 https://xxx.com/nav/sharepage/）
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      // 本地开发：把 /api/share/raw 转发到主站后端（部署到 CF Pages 后由 Functions 接管）
      '/api/share/raw': 'http://localhost:3000',
    },
  },
});
