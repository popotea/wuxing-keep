# 美術素材產生工具(AI Hub)

這是從另一個專案(`D:\game` 微光深淵)搬過來、驗證過可以用的 AI 生圖+存檔流程,調整成五行守衛專用。目的是讓沒有美術資源的情況下,也能靠 AI 生圖 API 產出堪用的素材,不用手動下載圖片再搬進專案。

## 檔案分工

- `tools/ai-hub/index.html` — 獨立的單頁工具(跟遊戲本體的 Vite/TypeScript 完全分開,純 HTML/JS,不會被 `npm run build` 打包進遊戲)。可以聊天、選模型、生圖,並且針對五行守衛需要的素材列出清單(`GAME_ASSETS`)。
- `scripts/asset-server.cjs` — 零相依的本地 Node 伺服器,固定聽 `127.0.0.1:8787`。負責兩件事:(1) 把 `tools/ai-hub/index.html` 端出來,(2) 接工具的「存入遊戲」請求,把圖存進 `public/assets/<分類>/<檔名>.png`。**跟 `npm run dev` 的 Vite 伺服器是分開的兩個 process**,兩個可以同時開著。

## 怎麼用

1. `npm run assets`,開 http://localhost:8787
2. 「連線設定」頁填 API Key。免金鑰可以選 **🎨 Pollinations**(右上角預設按鈕之一);有 Gemini/OpenAI 相容端點的話也可以填自己的。
3. 「圖像生成」頁,右邊「遊戲素材範本」清單點想生的項目(例如 `towers/metal.png`),Prompt 會自動帶入,按生成。
4. 生成的圖確認沒問題,點「💾 存入遊戲」——會自動去背(地形材質不去背)、依類別預縮到合理解析度(塔/地形 256px、怪物 512px),寫進 `public/assets/<分類>/<檔名>.png`。
5. 每個分類旁邊有「⚡ 整組補齊」,會自動跳過已經存在的檔案,只生成缺的。

## 目前 GAME_ASSETS 清單(v1)

| 資料夾 | 檔名 | 對應 |
|---|---|---|
| `assets/towers/` | `metal.png` `wood.png` `water.png` `fire.png` `earth.png` | `src/sim/elements.ts` 的 `Element` |
| `assets/monsters/` | 同上 5 個檔名 | 同上 |
| `assets/tiles/` | `floor.png`(可蓋塔地面)、`path.png`(怪物路徑) | `src/sim/map.ts` |

## 現況:產好的圖,遊戲還沒讀

`src/game/GameScene.ts` 目前完全用 Phaser Graphics 畫幾何圖形(塔=底座+尖塔、怪物=圓身+眼睛),**還沒有任何程式碼會去讀 `public/assets/` 底下的圖片**。等這裡真的生出堪用的素材之後,下一步是把 `GameScene.ts` 的 `drawTower`/`drawMonster` 改成用 `this.load.image()` 讀取對應檔案、`this.add.image()` 畫出來,對外呼叫介面(`renderState`/`onTilePlaced`)不需要改。

## 美術風格模板

`tools/ai-hub/index.html` 裡的 `ASSET_LIB.master`(塔/建築用)、`MASTER_CREATURE`(怪物用)、`MASTER_TILE`(地形材質用)三個模板,是照《魔獸爭霸風格、true top-down、單一主體、透明背景》的方向寫的,跟微光深淵原本的「Q版卡通貼紙風」不一樣。如果生出來的東西風格不對,調這三個字串,不用動其他程式碼。

**特徵字陷阱**(沿用自原專案的教訓):`applySpec` 靠 prompt 裡有沒有出現特定字串(`true top-down` / `fills the entire square` / `full body from head to feet`)判斷「這個 prompt 是不是已經套過模板了」。如果之後要改模板措辭,這幾句要嘛保留、要嘛連 `applySpec` 的判斷條件一起改,不然會重複套模板或漏套。
