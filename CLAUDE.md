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
  - `protocol.ts` — 線路訊息型別 + 防禦性解析(對外來資料不假設格式正確)
  - `net.ts` — 薄的 PeerJS 包裝,上層不直接碰 PeerJS API
  - `room.ts` — 房號產生/碰撞重試、roster、人數上限(8人)、房主權威開局(種子分發)
  - `lockstep.ts` — Tick 引擎:`HostLockstepEngine`(固定間隔跑 tick、收指令、廣播)、`ClientLockstepEngine`(依 tick 序緩衝消費)

**MVP 階段的刻意取捨**(不是遺漏,改動前先確認是否要一併處理):
- 房主中途斷線 = 直接結束對局,**不做自動換房主**
- 位置/操作採**信任制,不做防作弊驗證**(朋友間連線,不是公開對戰)
- 不支援對局中途加入

### 模擬層(`src/sim/`)—— 決定性塔防邏輯

- `elements.ts` — 五行相剋(正統循環:金克木→木克土→土克水→水克火→火克金),整數傷害倍率
- `map.ts` — **固定路徑**(寫死 waypoints,不做動態尋路/A*),怪物位置用定點數整數(`FP_SCALE=1000`)表示,全程整數運算(攻擊範圍判定用距離平方比較,不用 sqrt)
- `monsters.ts` — 怪物 + 波次定義,生怪時機是「給定 tick 回傳該生什麼」的純函式,不依賴亂數
- `towers.ts` — 五種元素塔屬性、範圍內選目標邏輯("打最前面"策略,決定性 tie-break)
- `simulation.ts` — 核心 `step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState`

**這個檔案的鐵則(修改 `src/sim/` 底下任何東西都要遵守)**:
- `step()` 必須是**純函式**、**完全決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上都要算出位元級相同的結果
- 全程只能用整數/定點數運算,不可以有浮點數累加、`Math.random()`、依賴物件鍵序等非決定性來源
- 不合法的指令(錢不夠、格子被佔用等)一律安全地當 no-op 忽略,不丟例外——這樣所有機器上都是相同的 no-op
- `step()` 的函式簽章是 `src/net/lockstep.ts` 依賴的契約,不要輕易改動,否則連線層要跟著改

### `src/main.ts` + `index.html`

目前是 **Phase 1+3 的手動測試/診斷頁面**,不是正式遊戲 UI——用 canvas 畫簡陋的地圖/塔/怪物,驗證連線同步跟模擬邏輯有沒有正確運作。真正的遊戲畫面之後會換成 Phaser 3。

## 開發階段路線圖與目前狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | 單人核心玩法(地圖/塔/怪物/元素克制/波次) | ✅ 完成(`src/sim/`) |
| 2 | 房間 UI(建立/加入房間) | 目前跟 Phase 3 測試頁混在一起,還沒做成獨立、正式的 UI |
| 3 | P2P 連線層 | ✅ 完成(`src/net/`) |
| 4 | 合作模式邏輯(依人數縮放波次強度、分工) | 未開始 |
| 5 | 平衡調整、美術、Phaser 3 正式渲染 | 未開始 |

已確認的產品決策:**只做單人模式 + 合作模式,不做對戰/PVP**;8 人上限。
