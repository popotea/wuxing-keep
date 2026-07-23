---
name: game-assets
description: 產生或更新遊戲美術素材(塔、怪物、地形材質、地圖裝飾物)的流程。涵蓋 tools/ai-hub 互動式產圖工具、三支一次性批次腳本(Pollinations / HuggingFace)、去背與無縫鋪磚後處理、以及 GameScene.ts 的材質命名慣例與備援機制。要新增元素塔造型、換風格、補素材時使用。
---

# AI 美術素材產製

## 風格基準

**Q 版可愛,參考 Kingdom Rush 系列**(2026-07-15 定案),不是先前的魔獸爭霸暗黑奇幻。

三支批次腳本的 prompt 跟 `tools/ai-hub/index.html` 裡手動生圖用的模板(`ASSET_LIB.master`/`MASTER_CREATURE`/`MASTER_TILE`)**兩邊要保持一致**,改風格時記得一起改。

## 互動式工具

```
npm run assets      # 啟動後開 http://localhost:8787
```

`tools/ai-hub/` + `scripts/asset-server.cjs` 跟遊戲本體(Vite/TypeScript)完全分開,**不會被 `npm run build` 打包進去**。可以用 AI 生圖 API(含免金鑰的 Pollinations)產生素材,存進 `public/assets/`。

完整說明見 [`docs/ART_PIPELINE.md`](../../../docs/ART_PIPELINE.md)。

## 三支一次性批次腳本

都跳過 `tools/ai-hub` 的瀏覽器互動流程,直接跑:

| 腳本 | 產什麼 | API | 後處理 |
|---|---|---|---|
| `scripts/generate-tower-monster-assets.mjs` | 塔/怪物 | Pollinations(免金鑰) | **去背**:`jpeg-js` 解碼 + 邊框 flood fill + `pngjs` 編碼 |
| `scripts/generate-decor-assets.mjs` | 地圖裝飾 | Pollinations(免金鑰) | 不去背 |
| `scripts/generate-terrain-assets.mjs` | 共用地形材質 | HuggingFace Inference(需 `HF_TOKEN` 環境變數) | **無縫鋪磚**:wrap-shift + 漸層混合 |
| `scripts/generate-map-terrain-assets.mjs` | **每張地圖各自的**地形材質 | Pollinations(免金鑰,**不用 token**) | 同上(邏輯從上面那支複製,兩邊一起維護) |

> Pollinations 免金鑰額度常態性 429/500,兩支腳本都內建重試 + 退避,跑久是正常的。

> 地形材質的已知限制:中央會有一塊模糊過渡區(wrap-shift 混合的代價),細節見 `docs/ART_PIPELINE.md`。

## 產物路徑與命名

```
public/assets/
├─ towers/<element>.png          # 5 種元素各 1 張
├─ towers/<element>-<path>.png   # 分岐升級後的 evolved 造型(burst / splash)
├─ monsters/<element>.png        # 5 種元素各 1 張
├─ tiles/floor.png               # 共用地形材質(備援用)
├─ tiles/path.png
├─ tiles/<mapId>/floor.png       # 每張地圖各自的地形材質
├─ tiles/<mapId>/path.png
└─ decor/…
```

`GameScene.ts` 的材質 key 慣例:`tower-<element>`、`tower-<element>-<path>`、`monster-<element>`、`tile-floor-<mapId>`、`tile-path-<mapId>`。

> ⚠️ **`MAP_DEFS` 裡的每張地圖都要有實際的 tiles 檔案存在**。Phaser 的 loader 載不到檔會往 console 噴 error,雖然 `resolveTileKey()` 會正常退回共用材質、功能不受影響,但主控台一直有紅字很干擾排查真正的問題。新增地圖時如果不想另外產材質,就直接複製一份共用的過去。

## 備援機制(不要拆掉)

`renderTower()`/`renderMonster()` 用 `this.textures.exists()` 判斷載入成功與否:

1. **有圖** → `Phaser.GameObjects.Image`(依 id 建立/更新/銷毀)
2. **沒圖/載入失敗** → 退回 `drawTower()`/`drawMonster()` 幾何圖形畫法

塔的材質是**三層備援**(`resolveTowerTextureKey()`):選了路線且 `level >= UPGRADE_PATH_LEVEL` → 先找 `tower-<element>-<path>` → 找不到退回 `tower-<element>` → 都沒有才退幾何圖形。evolved 造型額外放大 1.15 倍。

這條備援路徑純粹保險用,**新增素材時不要順手拆掉**。

## 什麼時候「不要」產圖

不是所有視覺差異都該用新素材解決。以下幾個判斷已經做過,不要重新推翻:

- **怪物特殊能力**:5 種能力 × 5 種元素 = 25 張圖,產圖跟維護成本都不划算,而且能力是「疊加在既有怪物上的標記」,不該換掉整隻怪的造型。改用 `drawAbilityGlyph()` 畫幾何符號——縮到約 5px 反而比縮小的插圖好認
- **異常狀態**:直接 `setTint()` 染整隻怪,不做狀態圖示疊加
- **UI 圖示**:一律自繪 SVG `<symbol>`,不用 AI 產圖也不用 emoji

## 已知的視覺調校

- **AI 生的地板/路徑材質偏亮、飽和度太高**:`drawStaticLayer()` 疊一層半透明色壓暗降飽和,只在真的載入了材質圖時才疊。⚠️ 這個疊色圖層必須在地板/路徑都貼完之後才 `this.add.graphics()` 建立,詳見 `docs/UI_RENDERING.md`。**疊色顏色依地圖主題換**(`TERRAIN_TINT_BY_MAP`):草原灰卡其、沙漠暖褐、雪原冷灰藍——雪原疊灰卡其會變成髒黃色,沙漠疊冷色會死氣沉沉
- **裝飾物的 AI 圖沒有去背**(prompt 是「站在草地上」,帶著綠色草地方形背景),所以**只有草原地圖能用**。沙漠/雪原鋪上去會變成一格格突兀的綠色補丁,那些地圖改用程序生成造型 + 換配色(`DECOR_THEME_BY_MAP`)。之後如果要為新主題產裝飾圖,記得 prompt 的背景要跟該地圖的地形一致,或乾脆做去背
- **路徑材質逐格貼靜態 `Image`,不用 `TileSprite`+`GeometryMask`**——mask 每影格重新運算合成,路徑格一多會拖累影格率
- 裝飾物太小的問題已調過:`DECOR_SCALE` 1.6 倍、`placeDecorImage()` 顯示比例 0.72 → 0.95

## 相關文件

- 產圖管線細節:[`docs/ART_PIPELINE.md`](../../../docs/ART_PIPELINE.md)
- 渲染端怎麼用這些素材:[`docs/UI_RENDERING.md`](../../../docs/UI_RENDERING.md)
- 風格決策脈絡:[`docs/FUTURE_IDEAS.md`](../../../docs/FUTURE_IDEAS.md)
