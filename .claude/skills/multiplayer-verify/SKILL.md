---
name: multiplayer-verify
description: 驗證多人連線功能(lockstep 同步、房主斷線自動換房主、RESYNC)的測試流程。用 Playwright 開多個獨立 BrowserContext 模擬多個玩家,在同一個 tick 上比對 window.__wuxingDebug.checksum 是否位元級一致。改過 src/net/ 或 src/sim/ 後要驗證同步時使用,也用於排查「兩台機器跑飛」。
---

# 多人連線驗證流程

## 為什麼不能只開一個分頁測

lockstep 的 bug 幾乎都是「兩台機器算出不同結果」,單一分頁**永遠測不出來**。P2P 連線時序問題(換房主、重連、RESYNC)更是只有真的多個獨立 peer 才會發生。

## 怎麼查 checksum

**2026-07-21 起 tick/checksum 不會顯示在頁面上了**(頁面刻意不放除錯資訊)。改在瀏覽器主控台查:

```js
window.__wuxingDebug   // → { tick, checksum, towers }
```

## 自動化腳本(優先用這個)

```
npm run build && npm run preview                          # 另一個終端機(服務 dist,預設 4173 埠)
WUXING_VERIFY_URL=http://localhost:4173/ npm run verify:browser
```

> ⚠️ **不要用 `npm run dev` 測多人**(2026-07-23 實測踩到):dev server 只要有任何工具讀寫
> `src/*.ts` 就會對所有連線分頁觸發 full reload,把房間整個毀掉,會誤判成連線 bug。
> 一定要用 build + preview 測靜態產物。

已經涵蓋:每張地圖的單人流程、同一分頁換地圖時靜態層有沒有重畫、**多人 2 玩家在同一 tick 上的 checksum 比對 + 加入者建塔真的生效**(checksum 一致證明不了 client 指令有進模擬,塔數走 `window.__wuxingDebug.towers`)。

Playwright 要自己裝(刻意不列進專案依賴,會連帶下載數百 MB 瀏覽器):

```
npm i -D playwright
npx playwright install chromium
```

下面的手動流程留著給「腳本沒涵蓋的情境」用(例如換房主——那需要真的砍掉某個 context)。

## 手動驗證(最低限度)

1. `npm run build && npm run preview`(理由同上,不要用 dev server)
2. 開兩個瀏覽器分頁(一個房主一個客戶端),實際連線跑一局
3. 兩邊各自 F12 主控台執行 `window.__wuxingDebug`
4. **必須在同一個 `tick` 上比對 `checksum`**——tick 不同的兩筆數值沒有比較意義

`checksum` 不一致 = lockstep 跑飛了,回頭看 `sim-determinism` skill 的檢查清單。

## Playwright 自動化驗證(換房主等時序功能必用)

關鍵是**每個玩家要用獨立的 `BrowserContext`**——同一個 context 內的分頁共用儲存空間,PeerJS `Peer` 身分會互相干擾,測不出真實情況。

```js
const ctxHost = await browser.newContext();
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
// 各自 newPage() → 建房 / 加入 / 準備 / 開始對局
```

### 模擬房主斷線

**真的呼叫 `context.close()` 砍掉房主那個 context**(模擬斷線/關分頁),不要用 mock 或人為觸發事件——重點就是驗證真實的斷線偵測路徑。

```js
await ctxHost.close();
```

### 驗收標準

> ⚠️ **單純看 tick 有沒有前進不夠嚴謹**。曾經在「只跳號不換 state」的版本上看到 tick 有前進但 checksum 對不上的情況(那個 bug 正是這樣被抓到的)。

必須:**在同一個 tick 上比對存活玩家的 `window.__wuxingDebug.checksum` 完全一致**才算過。

### 已驗證過的情境

| 情境 | 預期行為 |
|---|---|
| 2 人,房主斷線 | 唯一存活者升格成新房主(`'promoted'`) |
| 3 人,房主斷線 | 一人接手升格,另一人重連過去並收到 `RESYNC`(`'reconnected'`) |

兩種都驗證過 checksum 一致。

## 相關背景

- 換房主的完整機制、心跳偵測、`RESYNC` 為什麼必要:見 `docs/NETWORKING.md`
- 決定性檢查清單:見 `sim-determinism` skill

## 已知限制(不是要修的 bug,測不過也不用追)

- 同時多人斷線(不只房主一個)
- 選舉 race condition(房主斷線前 `ROSTER_UPDATED` 只送到部分玩家,殘存玩家 roster 快照不一致而選出不同接手人選)
- 換房主當下還在 `inputDelayTicks` 緩衝視窗內、尚未廣播的指令會遺失

這些都是「朋友間連線、機率低」可以接受的取捨。
