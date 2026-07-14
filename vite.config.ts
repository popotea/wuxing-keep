import { defineConfig } from 'vite';

// base: './' 讓 build 出來的路徑用相對路徑,之後不管 GitHub Pages 的 repo 名稱是什麼都能直接部署
export default defineConfig({
  base: './',
});
