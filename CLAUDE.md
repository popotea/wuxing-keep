# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **這份檔案刻意保持精簡**(每次 session 都會整份載入)。細節都拆進 `docs/` 跟 `.claude/skills/`,見最下面的「延伸文件索引」——動到哪一層就讀那一份,不要把細節寫回這裡。

## 專案

**五行守衛**(暫名,`package.json` 內部代稱 `wuxing-keep`)——魔獸爭霸風格的元素塔防網頁遊戲。純前端 + Vite,目標部署到 GitHub Pages(靜態 host),最多 8 人連線,用 PeerJS(WebRTC)做無伺服器 P2P 連線。

已確認的產品決策:**只做單人模式 + 合作模式,不做對戰/PVP**;8 人上限;不支援對局中途加入。

## 常用指令

```
npm install        # 安裝依賴
npm run dev        # 啟動 Vite dev server(預設 http://localhost:5173)
npm run typecheck  # tsc --noEmit,快速型別檢查
npm run build      # tsc --noEmit && vite build,輸出到 dist/
npm run preview    # 預覽 build 出來的 dist/
npm run verify     # 模擬層決定性驗證(改過 src/sim/ 一定要跑)
npm run verify:browser  # 實機瀏覽器驗證(需要 dev server + Playwright,見下)
npm run assets     # AI 美術產圖工具(獨立於遊戲本體,不會被 build 打包)
```

**沒有測試框架,也沒有設定 lint**,但有兩支驗證腳本當回歸測試:

| 指令 | 涵蓋範圍 | 前置需求 |
|---|---|---|
| `npm run verify` | 地圖定義合法性、擊退邊界、雜湊決定性、每張地圖跑兩次 2600 tick 比對 checksum 序列、各機制真的會發生 | 無(esbuild 來自 vite 的傳遞依賴) |
| `npm run verify:browser` | 三張地圖的單人流程、換地圖時靜態層有沒有重畫(解碼截圖像素)、多人 2 玩家 checksum 一致性 | 另開終端機跑 `npm run dev`;Playwright 要自己裝(`npm i -D playwright && npx playwright install chromium`,刻意不列進專案依賴——會連帶下載數百 MB 瀏覽器) |

**改過 `src/sim/` 一定要跑 `npm run verify`。** 多人同步的驗證方法論見 `multiplayer-verify` skill——**單一瀏覽器分頁測不出 lockstep 跑飛問題**。

除錯資訊不顯示在頁面上(刻意的),在瀏覽器主控台執行 `window.__wuxingDebug` 看 `{tick, checksum}`。

## 架構總覽

```
src/
├─ net/        連線層:PeerJS + Host-Relay Star + Lockstep     → docs/NETWORKING.md
├─ sim/        模擬層:決定性塔防邏輯(純函式 step())          → docs/SIMULATION.md
├─ game/       Phaser 3 渲染 + 玩家識別色                      → docs/UI_RENDERING.md
└─ main.ts     選單/HUD/浮動選單/記分板,接線 net ↔ sim ↔ game → docs/UI_RENDERING.md
```

### 連線層(`src/net/`)

無自架伺服器、玩家不需註冊。所有客戶端只連房主(star 拓樸),只傳玩家「指令」不傳完整狀態(lockstep),每個 peer 都用同一份 `simulation.step()` 算出完全相同的結果。

| 檔案 | 職責 |
|---|---|
| `protocol.ts` | 線路訊息型別 + 防禦性解析(對外來資料不假設格式正確) |
| `net.ts` | 薄的 PeerJS 包裝,上層不直接碰 PeerJS API |
| `room.ts` | 房號/roster/準備流程/房主權威開局/斷線偵測與換房主 |
| `lockstep.ts` | Tick 引擎:`HostLockstepEngine` / `ClientLockstepEngine` |

房主中途斷線會**自動換房主**(2026-07-21 加的,殘存玩家各自獨立算出同一個接手人選),失敗才落回結束對局。位置/操作採**信任制,不做防作弊驗證**(朋友間連線,不是公開對戰)。

→ 完整機制、心跳偵測、`RESYNC`、已知限制:**`docs/NETWORKING.md`**

### 模擬層(`src/sim/`)

| 檔案 | 職責 |
|---|---|
| `elements.ts` | 五行**相剋**(`BEATS`)+ **相生**(`GENERATED_BY`)兩套獨立關係,不要合併 |
| `map.ts` | **多地圖**(`MAP_DEFS`)x 固定路徑(不做 A*),定點數整數座標(`FP_SCALE=1000`) |
| `monsters.ts` | 怪物/波次定義、怪物特殊能力、固定 8 波 + 無限模式兩套並存的生怪規則 |
| `towers.ts` | 五元素塔、升級分岐、雙屬性塔、相生鄰接與圖騰加成、統一扣血入口 `dealDamage()` |
| `statuses.ts` | 元素異常狀態(灼燒/冰緩/纏繞/破甲/擊退),依塔的屬性決定 |
| `skills.ts` | 玩家主動技能(隕石/寒冰/戰吼),不花金幣、只受冷卻限制 |
| `placements.ts` | 陷阱 / 資源建築 / 符文圖騰(三者與塔沒有共用抽象介面) |
| `simulation.ts` | 核心 `step()`、指令套用、經濟、checksum |

**兩個容易踩的雷**(詳見 `sim-determinism` skill):

- **所有傷害都要走 `dealDamage()`**——它負責破甲增傷 + 護盾吸收,自己寫 `monster.hp -= x` 會漏掉
- **地圖是模組層級快取**(`setActiveMap`),任何不走 `createInitialState()` 建立 state 的路徑(換房主 resume、RESYNC、`resetCamera()` 前)都要自己補呼叫,否則直接跑飛

#### 這一層的鐵則(改 `src/sim/` 底下任何東西都要遵守)

1. **`step()` 必須是純函式、完全決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上都要算出位元級相同的結果
2. **全程只能用整數/定點數運算**,不可以有浮點數累加、`Math.random()`、依賴物件鍵序等非決定性來源
3. **不合法的指令**(錢不夠、格子被佔用等)**一律安全地當 no-op 忽略,不丟例外**——這樣所有機器上都是相同的 no-op
4. **`step()` 的函式簽章是 `src/net/lockstep.ts` 依賴的契約**,不要輕易改動,否則連線層要跟著改

> 新增狀態欄位、新增指令、新增放置物之前,先讀 **`sim-determinism` skill**(含 `computeChecksum` 該算入哪些欄位的判斷準則——這是最常踩的雷)。
> 各項玩法機制與數值調整的完整脈絡:**`docs/SIMULATION.md`**

#### 設計原則(使用者明確要求,不要違反)

- **互助道具只做正面互助,不做互相陷害**:「不能把別人的塔賣掉,只能幫忙升級」
- 團隊經濟:金幣每人獨立,升級不分誰的塔,**賣塔限本人**

### UI / 渲染(`src/main.ts`、`index.html`、`src/game/`)

- 選單分「單人模式 / 多人連線」兩頁籤,多人再分設定表單與房間 Lobby;兩邊都可選地圖
- **建造是點地圖格子才浮現的浮動選單**(舊的固定建塔列 `#buildBar` 已拿掉),選項依格子是不是路徑格動態決定
- 點已有的塔是**選取**(WC3 式),升級/賣出要在 `#towerPanel` 面板操作
- **主動技能列 `#skillBar`** 貼畫面下緣,兩段式操作(點技能 → 點地圖選位置),`Esc` 取消
- HUD 浮動貼在畫面上方置中,操作按鈕獨立在右上 `#hudToggles`
- 渲染用 Phaser 3,塔/怪物/地形都已經是正式美術(Q 版可愛,參考 Kingdom Rush),**保留幾何圖形備援路徑**
- 畫面固定顯示整張地圖(自動縮放),支援觸控裝置

→ 完整細節、踩過的坑(Phaser 疊放順序、`Scale.RESIZE` 蓋掉 CSS、`resetCamera()` 清理清單):**`docs/UI_RENDERING.md`**

### AI 美術工具(`tools/ai-hub/` + `scripts/`)

跟遊戲本體完全分開,不會被 `npm run build` 打包。→ **`game-assets` skill** 與 `docs/ART_PIPELINE.md`

## 開發階段路線圖與目前狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | 單人核心玩法(地圖/塔/怪物/元素克制/波次) | ✅ 完成(`src/sim/`) |
| 2 | 房間 UI(建立/加入房間) | ✅ 選單頁籤+準備流程+獨立 Lobby,已做過一輪視覺美化,仍不是正式美術 |
| 3 | P2P 連線層 | ✅ 完成(`src/net/`) |
| 4 | 合作模式邏輯(依人數縮放波次強度、分工) | ✅ 兩項都完成(數值是初版,未經多人實測調整) |
| 5 | 平衡調整、美術、Phaser 3 正式渲染 | 🔶 渲染與正式美術已完成;平衡數值持續調整中 |

尚未排進 Phase、還在構想階段的功能點子:[`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md)

## 延伸文件索引

**動到哪一層就讀那一份**,不要為了找細節整份翻程式碼。

| 文件 | 什麼時候讀 |
|---|---|
| [`docs/NETWORKING.md`](docs/NETWORKING.md) | 改 `src/net/`、排查連線問題、動到換房主機制 |
| [`docs/SIMULATION.md`](docs/SIMULATION.md) | 改 `src/sim/`、調數值平衡、查某個玩法機制為什麼這樣設計 |
| [`docs/UI_RENDERING.md`](docs/UI_RENDERING.md) | 改選單/HUD/Phaser 渲染/觸控 |
| [`docs/ART_PIPELINE.md`](docs/ART_PIPELINE.md) | 產圖管線細節 |
| [`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md) | 構想階段的功能點子、設計脈絡 |

### Skills(`.claude/skills/`,按需自動載入)

| Skill | 觸發時機 |
|---|---|
| `sim-determinism` | 新增/修改模擬狀態、指令、放置物,或排查 checksum 對不起來 |
| `multiplayer-verify` | 改過 `src/net/` 或 `src/sim/` 需要驗證多人同步 |
| `game-assets` | 產生/更新美術素材、換風格 |
