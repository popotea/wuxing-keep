# CLAUDE.md

> 這份檔案每次 session 全量載入,**只放「不寫就會做錯」的東西**。細節在 `docs/` 與 `.claude/skills/`,動到哪一層讀那一份,不要把細節寫回這裡。

## 專案

**五行守衛**(`package.json` 內部代稱 `wuxing-keep`)——魔獸爭霸風格的元素塔防網頁遊戲。純前端 Vite + Phaser 3,部署到 GitHub Pages(靜態 host),用 PeerJS(WebRTC)做無伺服器 P2P。

已定案的產品決策(不要提案推翻):**只做單人 + 合作,不做對戰/PVP**;8 人上限;不支援對局中途加入。

## 指令

```
npm run dev / typecheck / build / preview
npm run verify          # 模擬層決定性驗證 —— 改過 src/sim/ 一定要跑
npm run verify:browser  # 實機瀏覽器驗證(見下方前置需求)
npm run assets          # AI 美術產圖工具,不會被 build 打包
```

**沒有測試框架也沒有 lint**,上面兩支驗證腳本就是回歸測試。

`verify:browser` 的前置需求容易踩雷:
- 另開終端機跑 **`npm run preview`,不要用 dev server**——任何工具碰到 `src/*.ts` 都會觸發全頁 reload 把房間毀掉
- 設 `WUXING_VERIFY_URL=http://localhost:4173/`
- Playwright 要自己裝(`npm i -D playwright && npx playwright install chromium`),刻意不列進專案依賴(會連帶下載數百 MB 瀏覽器)

除錯資訊不顯示在頁面上(刻意的),在瀏覽器主控台看 `window.__wuxingDebug` 的 `{tick, checksum}`。

## 架構

```
src/net/     PeerJS + Host-Relay Star + Lockstep         → docs/NETWORKING.md
src/sim/     決定性塔防邏輯(純函式 step())              → docs/SIMULATION.md
src/game/    Phaser 3 渲染 + 玩家識別色                   → docs/UI_RENDERING.md
src/main.ts  選單/HUD/浮動選單,接線 net ↔ sim ↔ game     → docs/UI_RENDERING.md
```

### `src/sim/` 鐵則(改這層任何東西都要遵守)

1. **`step()` 必須是純函式、位元級決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上結果都要完全相同
2. **全程只能用整數/定點數**(`FP_SCALE=1000`),不可有浮點累加、`Math.random()`、依賴物件鍵序
3. **不合法的指令**(錢不夠、格子被佔用)**一律安全 no-op,不丟例外**——這樣所有機器上都是相同的 no-op
4. **`step()` 的簽章是 `src/net/lockstep.ts` 依賴的契約**,不要輕易改

兩個最常踩的雷:
- **所有傷害都要走 `dealDamage()`**(它負責破甲增傷 + 護盾吸收),自己寫 `monster.hp -= x` 會漏掉
- **地圖是模組層級快取**(`setActiveMap`),任何不走 `createInitialState()` 建立 state 的路徑(換房主 resume、RESYNC、`resetCamera()` 前)都要自己補呼叫,否則直接跑飛

其他不看程式碼會猜錯的:
- 五行**相剋**(`BEATS`)與**相生**(`GENERATED_BY`)是**兩套獨立關係,不要合併**
- 地圖是**固定路徑,不做 A***
- `placements.ts` 的陷阱 / 資源建築 / 符文圖騰**三者與塔沒有共用抽象介面**(刻意的)

### `src/net/` 重點

Star 拓樸只連房主、只傳玩家指令不傳完整狀態。房主斷線會**自動換房主**(殘存玩家各自算出同一個接手人選),失敗才落回結束對局。位置/操作採**信任制,不做防作弊驗證**(朋友間連線)。已有兩層防護:版本檢查(build 注入 git hash,新舊 bundle 混連直接拒絕)與跑飛偵測(checksum 比對不上就廣播 `DESYNC` 中止)。

### UI 重點

- 建造與選塔都是**點地圖才浮現的浮動選單**(舊的固定 `#buildBar` / `#towerPanel` 已移除,不要再提)
- 主動技能列 `#skillBar` 兩段式操作(點技能 → 點地圖選位置),`Esc` 取消
- 支援滾輪/雙指縮放 + 拖曳平移與觸控;塔/怪/地形已是正式美術,**保留幾何圖形備援路徑**
- ⚠️ **每 tick 用 innerHTML 整段重畫的區塊,裡面的按鈕會點不到**(mousedown/mouseup 落在不同節點,click 不派發)——要「結構只建一次、每 tick 只更新內容」

### 設計原則(使用者明確要求,不要違反)

- **互助道具只做正面互助,不做互相陷害**:不能把別人的塔賣掉,只能幫忙升級
- 金幣每人獨立;升級不分誰的塔,**賣塔限本人**
- **個人生命模式是「各守各的路」**:塔只攻擊塔主人負責路徑上的怪(技能/陷阱不受限);**依人數開線**——沒人負責的路線不生怪、怪量重新分配到啟用線。團隊模式維持全路線生怪、可互相支援

## 目前狀態

Phase 1–4(單人核心玩法 / 房間 UI / P2P 連線層 / 合作模式邏輯)已完成;Phase 5 的 Phaser 渲染與正式美術完成,**平衡數值持續調整中**。多人相關數值是初版,未經多人實測調整。

構想階段的功能點子見 [`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md)。AI 美術工具(`tools/ai-hub/` + `scripts/`)跟遊戲本體完全分開,見 `docs/ART_PIPELINE.md`。
