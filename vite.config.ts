import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * 版本識別字串,build 時注入(見 src/net/protocol.ts 的 APP_VERSION)。
 * 用 git commit hash 而不是手動維護的數字:模擬規則(src/sim/)一改,新舊 bundle 的
 * lockstep 結果就會分岔,但 PROTOCOL_VERSION 這種手動數字很容易忘記升——GitHub Pages
 * 的 HTML 有 max-age=600 快取,房主跟加入者拿到不同版本的機率不低,混連會靜默跑飛
 * (2026-07-23 排查「加入者不能玩」時確認過這是最可能的根因)。綁 commit hash 就不用
 * 靠人記得,任何一次 commit 後新舊版本互連都會被 HELLO 的版本檢查明確拒絕。
 */
function gitVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

// base: './' 讓 build 出來的路徑用相對路徑,之後不管 GitHub Pages 的 repo 名稱是什麼都能直接部署
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
  },
});
