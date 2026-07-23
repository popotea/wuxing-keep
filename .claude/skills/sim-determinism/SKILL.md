---
name: sim-determinism
description: 修改 src/sim/ 底下任何模擬邏輯(simulation.ts / towers.ts / monsters.ts / placements.ts / map.ts / elements.ts)時的決定性檢查清單。涵蓋 step() 純函式鐵則、computeChecksum 該算入哪些欄位、常見的 lockstep 跑飛陷阱。當要新增狀態欄位、新增指令型別、新增放置物、或排查「兩台機器 checksum 對不起來」時使用。
---

# 模擬層決定性檢查清單

`src/sim/` 是 lockstep 的核心:每台機器都跑同一份 `step()`,算出的結果必須**位元級相同**。任何非決定性來源都會讓對局跑飛(checksum 對不起來),而且通常是隨機、難重現的。

## 四條鐵則(不可違反)

1. **`step()` 必須是純函式、完全決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上都要算出位元級相同的結果
2. **全程只能用整數/定點數運算**——不可以有浮點數累加、`Math.random()`、依賴物件鍵序等非決定性來源
3. **不合法的指令一律安全地當 no-op 忽略,不丟例外**(錢不夠、格子被佔用、參數不合法等)——這樣所有機器上都是相同的 no-op
4. **`step()` 的函式簽章是 `src/net/lockstep.ts` 依賴的契約**,不要輕易改動,否則連線層要跟著改

## 非決定性來源黑名單

| 禁用 | 替代方案 |
|---|---|
| `Math.random()` | `waveHash(waveIndex, salt)`(`monsters.ts`)或 `tileHash()` 風格的純雜湊函式 |
| 浮點數運算/累加 | 定點數整數(`FP_SCALE=1000`),距離用平方比較不用 `sqrt` |
| `Date.now()` / `new Date()` | 用 `tick` 當時間基準 |
| `Object.keys()` 未排序就迭代 | 先 `.sort()` 再迭代(尤其 `state.gold` 這種 `Record<PlayerId, T>`) |
| 依賴 Set/Map 插入順序影響結果 | 產生結果前排序,tie-break 用穩定 id(如 `monster.id`) |

## 新增狀態欄位時:要不要算進 `computeChecksum`?

判斷準則就一條:**這個欄位會不會被 `step()` 修改?**

- **會變動(動態)→ 一定要算入**
- **開局後固定不變(靜態設定)→ 不用算入**

| 已知欄位 | 動態? | 算入 checksum? |
|---|---|---|
| `gold`(每人金幣) | ✅ | ✅ **必須排序 key 再序列化** |
| `waveTickOffset`(呼叫下一波) | ✅ | ✅ 容易漏掉——表面上像旗標,但它會變 |
| `pathLives`(個人生命模式) | ✅ | ✅ |
| `skillCooldowns`(主動技能冷卻) | ✅ | ✅ **key 一樣要排序** |
| 陷阱的 `level` | ✅ | ✅ |
| 資源建築的 `ticksSinceLastIncome` | ✅ | ✅ |
| 塔的 `upgradePath` | ✅ | ✅ |
| 塔的 `hasteTicks`(戰吼 buff) | ✅ | ✅ |
| 塔的 `secondElement` | ❌(蓋塔定案) | ✅ 仍要算入(不存在時用空字串佔位) |
| 怪物的 `shieldHp` / `ticksSinceHeal` | ✅ | ✅ |
| 怪物的六個 `status*` 欄位 | ✅ | ✅ **全部都要**,漏一個要等狀態造成血量差異才會爆 |
| `endlessMode` | ❌ | ❌ |
| `difficultyPercent` | ❌ | ❌ |
| `playerElements` | ❌ | ❌ |
| `playerCountScalePercent` | ❌ | ❌ |
| `pathOwners` / `individualLivesMode` | ❌ | ❌ |
| `mapId` | ❌ | ❌(但見下面「多地圖」的陷阱) |
| `combatEvents` / `skillCasts` | 每 tick 清空 | ❌ 純 UI 事件 |

> 最常見的踩雷:新欄位「感覺像設定」就沒算入,但實際上某個指令會改它。先確認有沒有任何 `apply*()` 函式會寫它。

## 新增指令型別的檢查

1. `applyXxx()` 對所有不合法輸入都要**安全忽略**,不能丟例外、不能部分套用(例如扣了錢卻沒建成)
2. 參數從 `action.params` 讀出來要當**外來不可信資料**驗證(型別、範圍、目標存不存在)
3. 涉及金幣的:先檢查餘額足夠再扣,失敗就整個 no-op
4. 涉及「限本人」的(如賣塔):比對 `ownerId === playerId`
5. **不能做互相陷害的功能**——使用者明確要求的既有原則:「不能把別人的塔賣掉,只能幫忙升級」

## 新增放置物型別的檢查

- `isBuildableTileFree` 要同步更新,不然新的放置物漏了跟塔/資源建築/符文圖騰的互斥檢查
- 路徑格 vs 非路徑格的規則要明確(陷阱只能路徑格,其餘只能非路徑格)
- 動態欄位記得加進 `computeChecksum`
- `GameScene.ts` 那邊如果新增 id-keyed 的 `Text`/`Image`,要一併加進 `resetCamera()` 的清理清單

## 多地圖:模組層級快取的陷阱

`map.ts` 的地圖資料是模組層級的快取(`setActiveMap(mapId)`),不是每次呼叫都帶參數。決定性靠「所有機器都在 `createInitialState()` 用同一個 mapId 設定一次」成立。

⚠️ **任何不走 `createInitialState()` 建立 state 的路徑都要自己補呼叫 `setActiveMap(state.mapId)`**,否則那台機器會拿舊地圖的路徑算,下一步移動就跑飛:

- `lockstep.ts` 的 `HostLockstepEngine` 建構子 `resume` 分支(換房主接手)
- `lockstep.ts` 的 `ClientLockstepEngine.applyResync()`(重連客戶端整份換 state)
- `main.ts` 開局時要在 `gameRenderer.resetCamera()` **之前**呼叫(`resetCamera()` 依活躍地圖重畫靜態層)

另外 `PATH_COUNT` 已經不是常數了(每張地圖路徑數可能不同),要用 `pathCount()`。

## 統一的扣血入口

**所有傷害來源都要走 `towers.ts` 的 `dealDamage()`**(塔直擊/splash、灼燒跳傷、隕石技能),它負責破甲增傷 + 護盾吸收。自己寫 `monster.hp -= x` 會漏掉這兩層,造成「有的傷害吃破甲有的不吃」這種很難查的不一致。

## 「現在算第幾波」一律用 `effectiveWaveTick()`

`step()` 裡任何要判斷波次的地方(生怪、加碼波判定、勝利判定)都要用 `effectiveWaveTick(next)` 而不是原始 `tick`。只有跟移動速度/塔冷卻/資源建築收入這些**真時間**相關的計算才繼續用原始 `tick`。

HUD 那層也一樣(`main.ts` 的 `renderWaveHud()`/`currentWaveNumberFor()`)——2026-07-21 修過一次這個 bug,漏用的話按「呼叫下一波」畫面完全沒反應。

## 效能考量:不要迴圈歷史波次

固定模式的 `getSpawnEventsForTick()` 每個 tick 迴圈整個 `WAVES`(只有 8 筆,沒差),但**無限模式波次會一直增加**,迴圈「至今所有波次」會隨對局拉長越跑越慢。無限模式的 `generateEndlessWave(waveIndex)` 因此刻意設計成 O(1) 純函式,只算「現在這一波」。新增類似機制時比照辦理。

## 改完之後

1. `npm run typecheck` 過
2. **`npm run verify` 過**(`scripts/verify-sim.mjs`)——這是模擬層的回歸測試:每張地圖跑兩次 2600 tick 比對 checksum 序列完全一致,加上各機制真的會發生。新增機制時也應該往這支腳本加對應的檢查
3. 多人情境再跑 `npm run verify:browser`,或照 `multiplayer-verify` skill 的流程手動比對——**單一瀏覽器分頁測不出跑飛問題**
4. 改到數值平衡的話,細節與歷史脈絡見 `docs/SIMULATION.md`
