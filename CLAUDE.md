# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案

**五行守衛**(暫名,`package.json` 內部代稱 `wuxing-keep`)——魔獸爭霸風格的元素塔防網頁遊戲。純前端 + Vite,目標部署到 GitHub Pages(靜態 host),最多 8 人連線,用 PeerJS(WebRTC)做無伺服器 P2P 連線。

## 常用指令

```
npm install       # 安裝依賴
npm run dev       # 啟動 Vite dev server(預設 http://localhost:5173)
npm run typecheck # tsc --noEmit,快速型別檢查
npm run build     # tsc --noEmit && vite build,輸出到 dist/
npm run preview   # 預覽 build 出來的 dist/
```

目前沒有自動化測試套件、也沒有設定 lint。驗證方式是手動 `npm run dev`,開兩個瀏覽器分頁(一個房主一個客戶端)實際連線測試,盯著畫面上的 tick / checksum 是否兩邊一致(不一致代表 lockstep 跑飛了)。

## 架構總覽

### 連線層(`src/net/`)—— Host-Relay Star + Lockstep,無自架伺服器

- 用 **PeerJS**(WebRTC 包裝)靠它免費的公開訊令 broker(`0.peerjs.com`)牽線,不需要自己架任何伺服器,玩家也不需要註冊任何帳號
- ICE:Google STUN + Open Relay 免費 TURN 當 fallback(帳密要換成自己註冊的,不要用教學文件的共用 demo 帳密)
- 房號格式 `gld-<5碼 Crockford Base32>`,房主固定用這個 ID 開房,客戶端用隨機 ID 連出去敲門
- 拓樸是 **Host-relay Star**:所有客戶端只連房主,房主轉發/排序訊息,不做 8 人全連 mesh
- 同步模型是 **Lockstep**(魔獸爭霸同款):只傳玩家「指令」不傳完整狀態。房主收齊每個 tick 的指令、排序後廣播 `TICK` 訊息(含空陣列心跳,不能只在有事發生時才送),每個 peer(含房主自己)都用同一份 `simulation.step()` 依 tick 序算出**完全相同**的結果
- 檔案分工:
  - `protocol.ts` — 線路訊息型別 + 防禦性解析(對外來資料不假設格式正確)。`PlayerInfo` 帶 `elements`(開局前選好、整局固定的可蓋屬性集合,至少 1 個)跟 `ready`(準備狀態)
  - `net.ts` — 薄的 PeerJS 包裝,上層不直接碰 PeerJS API
  - `room.ts` — 房號產生/碰撞重試、roster、人數上限(8人)、`setReady()`/`SET_READY`/`ROSTER_UPDATED` 準備流程、房主權威開局(種子分發,`startMatch()` 會擋到所有人都準備才真的送出 `START_MATCH`)
  - `lockstep.ts` — Tick 引擎:`HostLockstepEngine`(固定間隔跑 tick、收指令、廣播)、`ClientLockstepEngine`(依 tick 序緩衝消費);兩者都會把 roster 的 `elements` 轉成 `playerElements` 表餵給 `createInitialState`

**MVP 階段的刻意取捨**(不是遺漏,改動前先確認是否要一併處理):
- 房主中途斷線 = 直接結束對局,**不做自動換房主**
- 位置/操作採**信任制,不做防作弊驗證**(朋友間連線,不是公開對戰)
- 不支援對局中途加入

### 模擬層(`src/sim/`)—— 決定性塔防邏輯

- `elements.ts` — 五行相剋(正統循環:金克木→木克土→土克水→水克火→火克金),整數傷害倍率
- `map.ts` — **固定路徑**,支援多條(`PATHS`,地圖 40x24 格,目前 2 條在 `(29,14)` 交叉),寫死 waypoints,不做動態尋路/A*。怪物位置用定點數整數(`FP_SCALE=1000`)表示,`PathPos` 帶 `pathId`,全程整數運算(攻擊範圍判定用距離平方比較,不用 sqrt;跨路徑比較用 `remainingDistanceFp`)。改格子數/路徑形狀務必用腳本先驗證交叉點數量跟邊界沒跑掉。`VIEWPORT_TILES_W`/`VIEWPORT_TILES_H`(22x14)是**畫面可視範圍**,跟地圖本身大小(`GRID_WIDTH`/`GRID_HEIGHT`)分開——地圖比可視範圍大,`GameScene.ts` 靠鏡頭平移看其他區域
- `monsters.ts` — 怪物 + 波次定義,生怪時機是「給定 tick 回傳該生什麼」的純函式,不依賴亂數;同一波怪物輪流分配路徑;支援加碼波(`bonusClearWithinTicks`/`bonusGold`);最後一波是首領波(`WaveDef.isBoss`,單隻厚血慢速怪),`isBoss` 只是流到 `Monster` 的標記欄位,不影響生怪/移動/戰鬥邏輯本身
- `towers.ts` — 五種元素塔屬性、可升級(`Tower.level`,封頂 `MAX_TOWER_LEVEL`)、`Tower.ownerId` 記錄誰蓋的、`Tower.targetStrategy`(`'first' | 'lowest_hp' | 'highest_hp'`,決定 `findTarget` 怎麼選目標,預設 `'first'` 打最前面,決定性 tie-break 都用 `monster.id`)。`tryAttack()` 打中會回傳 `CombatEvent`(誰、扣多少血、在哪),沒打中回傳 `null`,給 UI 顯示飄動傷害數字用
- `simulation.ts` — 核心 `step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState`。`SimulationState.playerElements`(playerId → 允許蓋的屬性陣列)在 `createInitialState()` 時就固定,`applyBuildTower` 會檢查蓋塔的屬性是不是在該玩家允許清單內,不在就安全忽略(單人模式預設給 5 選 5,不受限)。**團隊經濟模型**:`SimulationState.gold` 是 `Record<PlayerId, number>`(每人金幣獨立,各自 300 起始),`lives` 維持團隊共用一份;升級不分誰的塔(誰都能出自己的錢幫忙升級),賣塔限本人(`tower.ownerId` 要等於出手的 `playerId`);擊殺賞金/加碼波獎勵是每個現存玩家各自拿全額,不追蹤攻擊貢獻。**改 `computeChecksum` 時金幣要排序 key 再序列化**,不然不同機器上 `Record` 的 key 插入順序不保證一樣,會誤判成跑飛。**依人數縮放**:`SimulationState.playerCountScalePercent` 在 `createInitialState()` 依開局玩家數算出(每多一人 +20%,單人固定 100%),跟 `difficultyPercent` 相乘後套用在生怪血量/速度(`scaledSpawn`),賞金刻意只跟 `difficultyPercent` 走、不跟人數加成,避免團隊經濟雙重放大

**這個檔案的鐵則(修改 `src/sim/` 底下任何東西都要遵守)**:
- `step()` 必須是**純函式**、**完全決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上都要算出位元級相同的結果
- 全程只能用整數/定點數運算,不可以有浮點數累加、`Math.random()`、依賴物件鍵序等非決定性來源
- 不合法的指令(錢不夠、格子被佔用等)一律安全地當 no-op 忽略,不丟例外——這樣所有機器上都是相同的 no-op
- `step()` 的函式簽章是 `src/net/lockstep.ts` 依賴的契約,不要輕易改動,否則連線層要跟著改

### `src/main.ts` + `index.html`

選單畫面用「單人模式 / 多人連線」兩個頁籤(`#tabSolo`/`#tabMulti`),各自選難度+屬性(勾選框,至少 1 個,可複選)。多人連線頁籤內部再分兩個互斥狀態:**設定表單**(`#multiSetup`,選屬性、建房/加入)跟**房間 Lobby**(`#multiLobby`,房號/邀請連結、玩家列表、準備/開始對局/離開房間),`main.ts` 的 `showLobby()`/`resetToMultiSetup()` 負責切換,建/加房成功才會秀 Lobby,不是永遠疊在一起。多人對局要**所有 roster 裡的玩家都按過準備**,房主的「開始對局」才會生效(`Room.setReady()`/`startBtn` 的 disabled 邏輯)。開局後 `#buildBar` 會依玩家自己選的屬性動態產生(1 個屬性就只有 1 顆按鈕,不是每次都五選一),對局中也可以按數字鍵 1~5 切換(`main.ts` 的 `keydown` 監聽,游標在文字輸入框裡時忽略)。點地圖上已有的塔是**選取**(WC3 式,`GameScene.ts` 的 `onTowerSelected`),不是直接升級——選到的塔會有白框標示,畫面下方 `#towerPanel` 顯示即時攻擊力/範圍/攻速+集火策略下拉選單(`#towerPanelStrategy`,送 `set_target_strategy` action,任何人都能改),升級/賣出要在面板裡按按鈕(或 Delete/Backspace 快捷鍵賣塔、Esc 取消選取)才會真的送出指令。UI 圖示是自繪 SVG(`<symbol>` 定義在 `index.html` 的 `<body>` 開頭,`<svg class="icon"><use href="#icon-xxx"/></svg>` 引用),不是 emoji;卡片/面板用 `.panel-frame` 統一加邊角裝飾框。純除錯資訊(ICE 設定、tick/checksum、log)收在頁面下方的 `<details id="advancedPanel">` 裡,不佔主畫面。

渲染用 Phaser 3(`src/game/GameScene.ts`/`PhaserGame.ts`),塔/怪物畫的還是幾何圖形佔位,不是正式美術。**地圖(世界)比畫面可視範圍大**(見上面 `map.ts` 的 `VIEWPORT_TILES_W`/`GRID_WIDTH`),`GameScene.ts` 用 `Camera.setBounds()` + 每影格 `update()` 判斷滑鼠是否貼著畫布邊緣(`EDGE_PAN_MARGIN_PX`)來平移鏡頭(世紀帝國式),搭配畫面右下角固定貼著(`scrollFactor(0)`)的小地圖(顯示路徑/塔/怪物小點+目前鏡頭範圍的白框,可以點小地圖直接跳鏡頭)。**新對局開始一定要呼叫 `gameRenderer.resetCamera()`**——`Phaser.Game` 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零。非路徑格上還有 `drawDecorations()` 灑的樹/草叢/石頭/花/小動物裝飾(用 `tileHash()` 固定雜湊決定,不是 `Math.random()`),純視覺、不影響能不能蓋塔。裝飾物優先用 `preload()` 載入的 AI 生圖(`public/assets/decor/`,`this.textures.exists()` 判斷有沒有載入成功),沒圖或載入失敗才退回程序生成造型。首領怪(`Monster.isBoss`)畫大 1.8 倍+金框,小地圖上也是比較大的金點。

### `tools/ai-hub/` + `scripts/asset-server.cjs` —— AI 美術產圖工具

跟遊戲本體(Vite/TypeScript)完全分開的獨立小工具,不會被 `npm run build` 打包進去。`npm run assets` 啟動後開 http://localhost:8787,可以用 AI 生圖 API(含免金鑰的 Pollinations)產生塔/怪物/地形素材,存進 `public/assets/`。細節見 [`docs/ART_PIPELINE.md`](docs/ART_PIPELINE.md)。**工具已就緒不代表已經用它產過圖**——`GameScene.ts` 目前完全不會讀取 `public/assets/` 底下的圖片。`scripts/generate-decor-assets.mjs` 是另一支獨立的一次性批次腳本,跳過 `tools/ai-hub` 的瀏覽器互動+去背流程,直接呼叫 Pollinations API 產生地圖裝飾素材存進 `public/assets/decor/`(細節/已知的免金鑰額度限流問題見 [`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md))。

## 開發階段路線圖與目前狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | 單人核心玩法(地圖/塔/怪物/元素克制/波次) | ✅ 完成(`src/sim/`) |
| 2 | 房間 UI(建立/加入房間) | ✅ 選單頁籤+準備流程+獨立 Lobby 畫面,UI 已用自繪 SVG 圖示+邊角裝飾框做過一輪視覺美化(`index.html`/`main.ts`),仍不是正式美術 |
| 3 | P2P 連線層 | ✅ 完成(`src/net/`) |
| 4 | 合作模式邏輯(依人數縮放波次強度、分工) | ✅ 兩項都完成:「分工」每人開局選固定的可蓋屬性集合(`PlayerInfo.elements`);「依人數縮放波次強度」用 `playerCountScalePercent` 補血量/速度(數值是初版,未經多人實測調整) |
| 5 | 平衡調整、美術、Phaser 3 正式渲染 | Phaser 3 渲染骨架已做(幾何圖形佔位),新增鏡頭平移+小地圖+程序生成裝飾物;平衡數值/正式美術(塔/怪物/地形圖片)仍未開始 |

已確認的產品決策:**只做單人模式 + 合作模式,不做對戰/PVP**;8 人上限。

尚未排進上述 Phase、還在構想階段的功能點子記錄在 [`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md)。
