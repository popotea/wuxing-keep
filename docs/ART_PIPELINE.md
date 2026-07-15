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

## 現況:塔/怪物/地形正式美術都已經產好並接進遊戲

`src/game/GameScene.ts` 的 `preload()` 載入 `public/assets/towers/<element>.png`、`public/assets/monsters/<element>.png`(5 種元素各 1 張)、`public/assets/tiles/floor.png`、`public/assets/tiles/path.png`——`renderTower()`/`renderMonster()` 用 `this.textures.exists()` 判斷載入成功沒,**有圖就用 `Image` 顯示,沒圖或載入失敗就退回原本的 Phaser Graphics 幾何圖形畫法**(塔=底座+尖塔、怪物=圓身+眼睛,留著當保險),不會整格空白。地板/路徑材質則是用 `Phaser.GameObjects.TileSprite` 整片鋪滿(材質已經做過 seamless tiling 後處理,重複貼不會有格線接縫),路徑材質再疊一層只蓋路徑格形狀的 `GeometryMask` 裁掉非路徑部分;同樣沒圖就退回原本的純色棋盤格/純色填滿畫法。

**`preload()` 裡所有素材路徑務必用相對路徑(`assets/...`),不要加開頭的 `/`**——這個專案部署到 GitHub Pages 的專案子路徑(`https://popotea.github.io/wuxing-keep/`),絕對路徑 `/assets/...` 會從網域根目錄解析,變成 404(`https://popotea.github.io/assets/...`,少了 `/wuxing-keep/`)。這個 bug 在本地 `npm run dev` 完全測不出來,因為 dev server 是從根目錄服務,`/assets/...` 剛好也對。2026-07-15 修過一次(6 處都在 `preload()`),之後新增素材載入程式碼要記得延續這個慣例。

**美術風格是 Q 版可愛(參考 Kingdom Rush 系列),不是魔獸爭霸暗黑奇幻**(2026-07-15 定案,舊版本的暗黑奇幻風格圖已經整批換掉)——使用者提供了「其他遊戲UI參考/」資料夾裡蒐集的多款塔防截圖當參考,共同調性是圓潤厚實的卡通造型、粗描邊、飽和暖色調、討喜不嚇人。

這批圖是用兩支獨立腳本產的,不是透過下面「怎麼用」的 AI Hub 手動流程:
- `scripts/generate-tower-monster-assets.mjs` — 呼叫免金鑰的 Pollinations API,prompt 沿用這裡的 `GAME_ASSETS` 清單措辭,額外裝了 `jpeg-js`/`pngjs`(純 JS,無原生相依)自己做邊框 flood fill 去背(塔/怪物是前景遊戲物件,需要真正的 alpha 透明)。
- `scripts/generate-tower-evolution-assets.mjs`(2026-07-15 新增)— 同一套去背管線,換一批 prompt 產塔升到分岐級後的強化造型:`<element>-burst.png`(加尖刺/利刃呼應單體強化)、`<element>-splash.png`(加光環/擴散元素呼應範圍波及),存進 `public/assets/towers/`,對照 `src/sim/towers.ts` 的 `UpgradePath`。
- `scripts/generate-terrain-assets.mjs` — 呼叫 HuggingFace Inference API(`router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell`,注意舊的 `api-inference.huggingface.co` 網域已經停用),需要環境變數 `HF_TOKEN`(不要寫死在檔案裡、不要 commit)。地形材質不用去背(整格鋪滿),但需要「無縫可鋪磚」——AI 生的圖天生邊緣對不起來,腳本額外做「wrap-shift 半張圖 + 中央漸層混合」的後處理讓邊緣保證接得起來(細節見腳本內註解)。**已知限制**:混合處理會在材質正中央留下一圈稍微模糊的過渡區,鋪滿地圖時會每隔一個材質週期重複出現一次,不是完美無縫,但比起直接鋪會出現的硬接縫好很多,而且遊戲裡本來就會疊裝飾物打散單調感。**這個 API 端點對同一組 prompt+seed 會回傳完全一樣的圖(沒有內建隨機性)**——2026-07-15 重新生產時原本沒帶 `seed` 參數,同個 prompt 連跑兩次都拿到一模一樣「草地上有木箱」的圖(跟先前已經修過一次的 crates 問題一樣又冒出來),之後腳本加了 `TERRAIN_ASSETS[].seed` 欄位,**想要不同結果一定要換 seed 數字,光改 prompt 措辭字句細節不夠、換 seed 才有用**。同一天也把色調從「飽和暖色調」改成「柔和低飽和」(prompt 裡的 `STYLE_SUFFIX`),搭配 `GameScene.ts` 的半透明疊色壓暗(見 `CLAUDE.md`),從源頭+疊色雙管齊下解決地形太螢光的問題。

如果之後想要不同風格/重新生成單一張圖,**兩條路都可以**:改對應腳本的 prompt/seed 重跑(快,但去背/去縫都是簡化版演算法,細節複雜的圖可能處理不乾淨),或是用下面「怎麼用」的 AI Hub 手動生成單張(可以人工挑喜歡的結果)。

## 美術風格模板

`tools/ai-hub/index.html` 裡的 `ASSET_LIB.master`(塔/建築用)、`MASTER_CREATURE`(怪物用)、`MASTER_TILE`(地形材質用)三個模板,已經同步改成《Kingdom Rush 式 Q 版可愛、chunky rounded、warm saturated colors》的方向,跟上面兩支批次腳本的 prompt 風格一致。如果生出來的東西風格不對,調這三個字串,不用動其他程式碼。

**特徵字陷阱**(沿用自原專案的教訓):`applySpec` 靠 prompt 裡有沒有出現特定字串(`true top-down` / `fills the entire square` / `full body from head to feet`)判斷「這個 prompt 是不是已經套過模板了」。如果之後要改模板措辭,這幾句要嘛保留、要嘛連 `applySpec` 的判斷條件一起改,不然會重複套模板或漏套。
