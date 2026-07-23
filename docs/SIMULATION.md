# 模擬層(`src/sim/`)—— 決定性塔防邏輯

> 這份文件從 `CLAUDE.md` 拆出來,只在要改 `src/sim/` 時才需要讀完整。
> **鐵則(必須遵守,已留在 `CLAUDE.md` 常駐)**:`step()` 是純函式、完全決定性、只用整數/定點數、不合法指令當 no-op。改動前也請看 `sim-determinism` skill 的檢查清單。

## `elements.ts` —— 五行關係

- **相剋**(`BEATS`,正統循環):金克木→木克土→土克水→水克火→火克金,整數傷害倍率
- **相生**(`GENERATED_BY`,2026-07-15 加的):木生火→火生土→土生金→金生水→水生木。**故意跟 `BEATS` 那套「相克」用不同循環順序,兩者是獨立的五行關係,不要搞混或合併成同一張表**
- `bestElementRelation(e1, e2, defender)`:雙屬性塔用,兩屬性各自算 relation 取比較好的那個

## `map.ts` —— 固定路徑

- **固定路徑**,支援多條(`PATHS`,地圖 40x24 格,目前 2 條在 `(29,14)` 交叉),寫死 waypoints,不做動態尋路/A*
- 怪物位置用定點數整數(`FP_SCALE=1000`)表示,`PathPos` 帶 `pathId`,全程整數運算(攻擊範圍判定用距離平方比較,不用 sqrt;跨路徑比較用 `remainingDistanceFp`)
- 改格子數/路徑形狀務必用腳本先驗證交叉點數量跟邊界沒跑掉
- `VIEWPORT_TILES_W`/`VIEWPORT_TILES_H`(22x14)是**畫面可視範圍**,跟地圖本身大小(`GRID_WIDTH`/`GRID_HEIGHT`)分開

## `monsters.ts` —— 怪物 + 波次

- 生怪時機是「給定 tick 回傳該生什麼」的純函式,不依賴亂數;同一波怪物輪流分配路徑
- 支援加碼波(`bonusClearWithinTicks`/`bonusGold`)
- 最後一波是首領波(`WaveDef.isBoss`,單隻厚血慢速怪,移動速度 `speedFp: 35` 是全部波次裡最慢的,2026-07-15 從 45 調慢過一次,拉長最後一戰時間),`isBoss` 只是流到 `Monster` 的標記欄位,不影響生怪/移動/戰鬥邏輯本身
- **移動類型**(參考 Bloons TD 的 flying/camo 概念,簡化成互斥三選一):`Monster.moveType`(`'ground' | 'air' | 'water'`,`WaveDef.moveType` 可選、不填就是 `'ground'`)獨立於 `Element`(五行傷害倍率用),兩者互不影響;目前 `WAVES[0]`(水波)是 `'water'`、`WAVES[5]`(金屬波)是 `'air'`,其餘沒設定的都是預設 `'ground'`

### 無限模式(2026-07-15 加的)

跟固定 8 波的 `WAVES` 完全獨立的另一套生怪規則,兩者並存、玩家開局前選。

- `SimulationState.endlessMode` 這個旗標在 `createInitialState()` 就固定,`step()` 依它二選一走 `getSpawnEventsForTick()`(固定 `WAVES`)還是 `getEndlessSpawnEventsForTick()`(無限模式)
- 無限模式**沒有終點**,永遠不會設 `victory = true`(`step()` 裡這個判斷式加了 `!next.endlessMode` 擋掉),唯一結局是撐不住(`lives<=0` 觸發 `gameOver`)
- 加碼波機制(`applyBonusWaveRewards`)整個跳過不判定,因為它讀的是固定 `WAVES` 的定義,套用在無限模式自己生的怪物上會誤判/誤發獎勵
- `generateEndlessWave(waveIndex)` 是**純函式,只算「現在這一波」該生什麼**(不像固定模式的 `getSpawnEventsForTick()` 每個 tick 都迴圈整個 `WAVES` 陣列——那對只有 8 筆的固定陣列沒差,但無限模式波次會一直增加,迴圈「至今所有波次」會隨對局拉長越跑越慢,所以刻意設計成 O(1) 不重算歷史波次)
- 「看起來隨機但其實決定性」的內容全靠 `waveHash(waveIndex, salt)`(跟 `GameScene.ts` 的 `tileHash()` 同一種風格的純雜湊函式,同樣輸入在任何機器上都算出同一個整數),**不能用 `Math.random()`**

數值成長:

| 項目 | 常數 | 行為 |
|---|---|---|
| 血量/賞金 | `ENDLESS_HP_GROWTH_PERCENT`(12%) | 每波線性疊加**不封頂**(就是要怪物持續變強) |
| 速度 | `ENDLESS_SPEED_GROWTH_PERCENT`(3%) | 每波疊加,封頂 `ENDLESS_SPEED_GROWTH_CAP_PERCENT`(60%,避免後期怪物快到玩家反應不過來) |
| 混合元素 | `waveHash` 決定 | 約 1/3 機率混 2 種元素 |
| 首領波 | `ENDLESS_BOSS_INTERVAL`(5) | 每 5 波的最後一波(血量/賞金大幅放大、速度打七折) |

- `currentWaveNumberEndless()`/`ticksUntilNextWaveEndless()`/`upcomingWaveDefEndless()` 是無限模式版的 HUD 輔助函式,**故意跟固定模式的 `currentWaveNumber()` 等函式分開、不共用**——固定版的這些函式在波次編號超過 `WAVES.length` 時會封頂/回傳 `null`,直接拿來給無限模式用會讓 HUD 卡在「第 8 波」不動,或提前顯示「最後一波」
- **非首領波隻數會隨波次增加**(2026-07-21 加的,呼應「持續變強」不只靠數值成長):`ENDLESS_WAVE_MONSTER_COUNT_BASE`(8)每 `ENDLESS_MONSTER_COUNT_GROWTH_INTERVAL`(2)波 +1 隻,封頂 `ENDLESS_WAVE_MONSTER_COUNT_CAP`(16)——**封頂值刻意留在 `WAVE_INTERVAL_TICKS / SPAWN_INTERVAL_TICKS = 20` 這個硬限制之下**,超過的話最後幾隻的生怪 tick 會落在下一波時間範圍內,被下一波的排程蓋掉,永遠不會生出來
- **首領波造型三選一**(2026-07-21 加的):`waveHash(waveIndex, 3) % 3` 決定 `single`(原本的單隻厚血慢速)/`group`(三隻一組首領小隊,單隻血量沒 single 型誇張但要同時分散顧三個目標)/`swift`(血薄速度快,考驗集火反應而非耐力),三種總賞金刻意維持同一量級不讓經濟跑掉;`upcomingWaveDefEndless()` 多回傳 `bossType` 給 HUD 顯示不同文字提示

**無限模式的網路層/UI 佈線**:`endlessMode: boolean` 從選單的核取方塊(`#soloEndlessMode`/`#hostEndlessMode`)開始,單人走 `LocalEngine` 建構子多帶的參數,多人走 `MatchConfig`/`StartMatchMsg`(`protocol.ts` 的 defensive parsing 也要記得檢查這個欄位)一路傳到 `createInitialState()`。

**最佳紀錄/今日最佳/成就系統目前刻意不吃無限模式的結果**(`main.ts` 的 `onStateUpdated` 裡 `state.endlessMode` 為 true 時只顯示「撐到第 N 波,守備失敗」的橫幅,不呼叫 `saveBestRecordIfBetter`/`saveDailyBestIfBetter`/`evaluateAchievements`)——那套系統是繞著固定模式「全破」設計的,無限模式波次可以遠超過 8,兩種模式的數字混在一起比較沒有意義,之後如果要讓無限模式也有自己的紀錄/成就,需要另外設計一套獨立的比較基準(例如「最高撐到第幾波」),不是直接共用現有欄位。

## `towers.ts` —— 五種元素塔

- `TOWER_DEFS` 的 `cooldownTicks` 2026-07-20 微調過,詳見程式內註解:算 dps 對照 range 抓出 metal 同時完勝 fire/earth、water 被 wood 完勝的數值 dominance,只調冷卻不動每擊傷害,讓 5 個屬性照 range 由高到低排列時 dps 剛好由低到高排列,彼此變成純粹的射程/攻速取捨,不會有「這個屬性數值上單方面完勝另一個」的情況
- 可升級(`Tower.level`,封頂 `MAX_TOWER_LEVEL`)、`Tower.ownerId` 記錄誰蓋的
- `Tower.targetStrategy`(`'first' | 'lowest_hp' | 'highest_hp'`,決定 `findTarget` 怎麼選目標,預設 `'first'` 打最前面,決定性 tie-break 都用 `monster.id`)
- `TOWER_CHARACTER_NAMES` 是每個屬性配的角色名(給建造 UI 顯示用,不影響數值)

### 升級分岐路線(參考 WC3 TD 手塔技能)

`Tower.upgradePath`(`'none' | 'burst' | 'splash'`)在升到 `UPGRADE_PATH_LEVEL`(3 級)那一次必須定案、之後不能改:

- `burst`(單體強化):傷害是線性公式的 `BURST_DAMAGE_PERCENT`(150%)
- `splash`(範圍擴散):傷害維持線性不加成,但攻擊會波及主目標 `SPLASH_RANGE_FP` 距離內的其他怪物(打 `SPLASH_DAMAGE_PERCENT` 折扣傷害)

`tryAttack()` 打中會回傳 `CombatEvent[]`(通常 1 個,splash 路線可能多個,誰、扣多少血、在哪),沒打中回傳空陣列,給 UI 顯示飄動傷害數字用。

### 移動類型限制

`canTargetMoveType(element, moveType)` 決定塔打不打得到:

- 土屬性打不到 `'air'`(純地面系搆不到天上)
- 火屬性打不到 `'water'`(呼應五行水克火)
- 其餘一律打得到

刻意讓每種特殊類型都還有 4/5 屬性能打,不會有「這個屬性組合完全打不到某種怪」的卡死情況。`findTarget()` 選目標前跟 splash 路線波及的每個次要目標都會檢查這條規則。

### 五行相生鄰接加成(2026-07-15 加的)

`hasGeneratingNeighbor(tower, allTowers)` 檢查 8 方向鄰接(3x3 扣自己)有沒有蓋了「生」自己那個元素的塔,有的話 `effectiveCooldownTicks()` 冷卻時間打 `ADJACENCY_COOLDOWN_PERCENT`(85 = 快 15%)折扣。**每次呼叫都即時重新掃鄰居**(不是蓋塔當下定案存起來的靜態值),鄰居被賣掉/新蓋會立刻反映,不用處理快取失效。

`tryAttack()`/`describeTower()` 因此需要多帶一個 `allTowers: readonly Tower[]` 參數(全場所有塔,含自己)。`TowerStats.adjacencyBonusActive` 是純顯示用的旗標。

### 符文圖騰加成(2026-07-16 加的)

組合建築玩法第二種,跟相生鄰接是**互補關係而非取代**。

`nearbyTotemEffect(tower, runeTotems)`(`hasNearbyTotem()` 是單純的布林版本,給不需要細節數字的地方用)檢查範圍內(`RUNE_TOTEM_RANGE_FP`,距離平方比較)所有符文圖騰,分別算出「傷害加成%」跟「攻速加成%」——**範圍內同時有好幾座圖騰時,同一種效果取最大值,不會相加疊加**(避免堆一堆圖騰數值爆炸)。

`effectiveDamage()`/`effectiveCooldownTicks()` 分別套用這兩種加成,兩者跟相生鄰接一樣可以同時疊加在同一座塔上。`tryAttack()`/`describeTower()` 都多帶一個 `runeTotems: readonly RuneTotem[]` 參數。`TowerStats` 用 `totemDamageBonusPercent`/`totemHastePercent`(0 = 沒有,不是布林旗標)給 UI 顯示實際數字。

**跟相生加成的關鍵差異**:相生是「塔跟塔之間」的鄰接關係(8 方向,3x3),圖騰是「塔跟支援建築之間」的圓形範圍關係(不分方向,純距離)。兩者都不分誰蓋的、範圍內全部隊友的塔都吃得到,差異純粹在「觸發條件」——鄰接 vs 範圍。

### 雙屬性塔(2026-07-21 加的)

元素組合玩法拍板的第一項,`docs/FUTURE_IDEAS.md` 有完整設計脈絡。

`Tower.secondElement`(可選,不存在就是一般單屬性塔)蓋塔當下定案、之後不能改。

- 傷害判定改用 `bestElementRelation(e1, e2, defender)`——因為 `BEATS` 是單一循環克制關係,雙屬性塔對任何目標最差就是 neutral,**不會出現「弱」的倍率**(Node 腳本窮舉過全部 20 組×5 目標驗證過)
- 移動類型判定改用 `canDualTargetMoveType(e1, e2, moveType)`,OR 邏輯(任一屬性打得到就算打得到)

這兩個「不會出現最壞情況」的一致性由基礎數值去平衡,`dualTowerStats(e1, e2)`:

| 屬性 | 公式 |
|---|---|
| cost | 兩屬性平均造價 × `DUAL_TOWER_COST_MULTIPLIER_PERCENT`(180%) |
| damage | 兩屬性平均傷害 × `DUAL_TOWER_DAMAGE_PERCENT`(80%) |
| range / cooldown | 單純取平均 |

`baseTowerDef(tower)` 是內部共用的分派點(單屬性查 `TOWER_DEFS`,雙屬性算 `dualTowerStats`),`upgradeCost`/`sellValue`/`effectiveDamage`/`effectiveCooldownTicks`/`describeTower`/`tryAttack` 都改吃這個而不是直接查 `TOWER_DEFS[tower.element]`。

**相生鄰接加成(`hasGeneratingNeighbor`)目前只看主屬性,沒把 `secondElement` 算進去**,先求「能玩」的簡化版。

`computeChecksum` 的塔序列化把 `secondElement` 算進去(不存在時用空字串佔位)。

## `placements.ts` —— 非攻擊型放置物

| 型別 | 蓋在哪 | 成本 | 說明 |
|---|---|---|---|
| `Trap` | **只能路徑格** | `TRAP_COST` | 減速 |
| `ResourceBuilding` | 非路徑格(規則同塔) | `RESOURCE_BUILDING_COST` | 被動收入 |
| `RuneTotem` | 非路徑格(規則同塔) | `RUNE_TOTEM_COST` | 自己不攻擊,純粹提升範圍內的塔(不分誰的) |

四者(含 `Tower`)沒有共用抽象介面(規則差異夠大,先各自獨立型別)。

### 陷阱升級(2026-07-15 加的)

呼應「不要讓玩家蓋完就掛著不管」的設計方向。

- `Trap.level`(新蓋是 1,封頂 `MAX_TRAP_LEVEL=3`,**刻意不做「用幾次就壞掉」**,持續生效不會用完)
- `TRAP_SLOW_PERCENT_BY_LEVEL`(1→50%、2→65%、3→80%)
- `trapUpgradeCost()` 公式跟塔的 `upgradeCost` 同一套慣例(`TRAP_COST * level`)
- `applyUpgradeTrap` 不分誰蓋的,誰都能出錢升級(跟塔升級同一套慣例),已封頂安全忽略

### 進階版圖騰(分歧路線,2026-07-16 加的)

呼應塔的分岐升級概念。`RuneTotem.level`(新蓋是 1)+ `RuneTotem.upgradePath`(`'none' | 'damage' | 'haste'`):

- 1 級是基礎版,固定 `RUNE_TOTEM_DAMAGE_BONUS_PERCENT`(20%)傷害加成,沒有分歧
- 升到 `MAX_RUNE_TOTEM_LEVEL`(2 級)那一次必須在 `action.params.path` 指定 `'damage'`/`'haste'` 之一定案、之後不能改(`applyUpgradeRuneTotem`,不是就整個升級安全忽略,跟塔的 `applyUpgradeTower` 同一套邏輯)
  - `damage`(強化圖騰):傷害加成加重到 `RUNE_TOTEM_DAMAGE_BONUS_PERCENT_SPECIALIZED`(35%)
  - `haste`(疾風圖騰):整個換成攻速加成 `RUNE_TOTEM_HASTE_PERCENT`(15%,冷卻時間打折),**不給傷害加成**(兩種效果互斥,同一座圖騰只會生效其中一種)

`main.ts` 的 `onTilePlaced`:點已經有圖騰的格子直接跳 `showChoiceModal()` 選分歧路線(不像陷阱升級先跳一個「要不要升級」的中間選單——圖騰只有這一次升級,而且這次升級一定要選路線,沒有純數字升級的中間狀態,直接跳分歧選擇比較省事)。

## `simulation.ts` —— 核心 `step()`

簽章:`step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState`

### 升級指令的路線定案

`applyUpgradeTower` 在升級後的新等級**恰好**等於 `UPGRADE_PATH_LEVEL` 時,要求 `action.params.path` 是 `'burst'`/`'splash'` 之一,不是就整個升級安全忽略(不會扣錢卻沒定案路線)。`step()` 的塔攻擊迴圈把 `tryAttack()` 回傳的 `CombatEvent[]` 全部展開塞進 `combatEvents`(splash 路線一次可能好幾個事件)。

### 陷阱/資源建築/符文圖騰

- `applyBuildTrap`/`applyBuildResourceBuilding`/`applyBuildRuneTotem` 分別檢查蓋在路徑格/非路徑格才合法(`isBuildableTileFree` 順便擋掉塔/資源建築/符文圖騰三者互相疊格子,**新增放置物型別時這個函式要記得同步更新**,不然新的放置物就漏了互斥檢查)
- `step()` 裡怪物移動前用 `worldPositionFp` 查目前格子座標有沒有陷阱,有就這個 tick 的 `speedFp` 依陷阱等級打折扣(`moveType === 'air'` 的飛行怪不受影響,陷阱打不到天上)
- 資源建築每 `RESOURCE_BUILDING_INTERVAL_TICKS` 只給 `ownerId` 自己(不是全員均分)加 `RESOURCE_BUILDING_INCOME` 金幣

### 團隊經濟模型

- `SimulationState.gold` 是 `Record<PlayerId, number>`(每人金幣獨立,各自 300 起始),`lives` 維持團隊共用一份
- 升級不分誰的塔(誰都能出自己的錢幫忙升級),**賣塔限本人**(`tower.ownerId` 要等於出手的 `playerId`)
- 擊殺賞金/加碼波獎勵是每個現存玩家各自拿全額,不追蹤攻擊貢獻(這跟記分板統計是分開的兩件事)

### 經濟數值調整史

**2026-07-16**(玩家實測反應金幣累積太快花不完),三個方向一起下手:

- `monsters.ts` 的 `WAVES` 賞金整批調降約 30%(含 `ENDLESS_BASE_BOUNTY`)
- `placements.ts` 的 `RESOURCE_BUILDING_INCOME`/`RESOURCE_BUILDING_INTERVAL_TICKS` 調弱被動收入速率(15/10 秒 → 10/15 秒)
- 建造成本調漲:塔 50→70、陷阱 30→40、資源建築 80→90、符文圖騰 120→150

塔的升級花費公式是 `cost * level`,漲 `cost` 就連帶讓升級跟著等比例變貴,不用另外改公式。

**2026-07-20 發現資源建築調過頭**:算過一輪 8 波(3200 tick)的總回本,原本的 10/300 速率整場下來只回得了 100 金幣,扣掉 90 成本淨賺 10——蓋了等於讓一格塔的攻擊力空掉整場只換 10 金幣,變成沒人會選的陷阱選項。已經回調成 `RESOURCE_BUILDING_INCOME=12`/`RESOURCE_BUILDING_INTERVAL_TICKS=250`(整場回得了 144,淨賺 54,回本期落在中期約第 5 波),比原始值仍然弱(調弱的初衷維持)但至少蓋了不會虧。

### 互助道具

**設計原則(使用者明確要求)**:只做正面互助,不做互相陷害——「不能把別人的塔賣掉,只能幫忙升級」這個既有原則要繼續維持。

**金幣禮物**(2026-07-16):`gift_gold` 指令(`applyGiftGold`)把送禮者的金幣直接轉一部分給指定隊友,純粹重新分配現有資源(不會憑空生錢)。不能送給自己/不存在的玩家/送出金額必須是正整數且送禮者的錢要夠,不成立就安全忽略。`main.ts` 的記分板每列(自己除外)多一顆禮物按鈕(`.scoreboard-gift-btn`,事件代理綁在 `scoreboardBodyEl` 上,不用每次重畫 innerHTML 後重新綁定個別按鈕),點下去跳 `showChoiceModal()` 選金額(50/100/200 固定選項)。

**緊急補命**(2026-07-16):`EMERGENCY_HEAL_COST`(400)/`EMERGENCY_HEAL_AMOUNT`(+5 命)/`EMERGENCY_HEAL_THRESHOLD`(5)——**只有生命「快歸零」(`<= EMERGENCY_HEAL_THRESHOLD`)時才能用**,不是隨時能買命池子,故意設計成走投無路的最後手段,不是常態性的生命來源;回滿也不會超過開局的滿血值。`applyEmergencyHeal()` 依 `individualLivesMode` 二選一:預設模式補團隊共用的 `lives`(不用 `pathId` 參數);個人生命模式要在 `action.params.pathId` 指定要補哪一條路徑,只補那一條,其他路徑不受影響,`pathId` 不合法/超出範圍安全忽略。

HUD:團隊模式的按鈕(`#emergencyHealBtn`)是固定 DOM 元素,只有生命低於門檻時才顯示;個人生命模式的按鈕是 `renderLivesHud()` 動態產生在每條路徑各自的血條旁邊(事件代理綁在 `#pathLivesStats` 上,`data-heal-path` 屬性標示要補哪條)。

### 個人生命模式(2026-07-16 加的)

多人連線限定選項,跟無限模式一樣是開局前的核取方塊,單人模式沒有這個選項。跟團隊共用一份 `lives` 的預設模式並存。

- `SimulationState.individualLivesMode` 開啟時,`createInitialState()` 把排序後的玩家 id 依 `index % PATH_COUNT` 分組指派給每條路徑(`pathOwners`,**純顯示用**——不是權限管控,任何人本來就能在任何地方蓋塔,只決定「這條路徑漏怪算誰的」)
- 每條路徑各自拿到 `STARTING_LIVES / PATH_COUNT` 的獨立生命池子(`pathLives`,**平分而不是每條都滿額**,避免總容錯量憑空變兩倍)
- `step()` 漏怪扣血分岔:開啟時扣 `pathLives[monster.pos.pathId]`(舊的 `lives` 欄位整場凍結不動),關閉時維持原本扣團隊共用的 `lives`
- **某條路徑的生命歸零,那條路徑直接永久停止生怪**(`step()` 生怪前先過濾掉 `pathLives[spawn.pathId] <= 0` 的 `SpawnEvent`,不是暫停也不是消失現有的怪物,是「以後都不會再生」),其他路徑完全不受影響繼續進行
- **全部路徑都歸零才算 `gameOver`**(`next.pathLives.every((l) => l <= 0)`)
- `pathLives` 是會被 `step()` 修改的動態狀態,**要算進 `computeChecksum`**(`pathOwners`/`individualLivesMode` 本身是靜態設定,不用算入)
- **這個模式會讓 `main.ts` 的「無傷」成就判斷失真**:`evaluateAchievements()` 原本直接比較 `state.lives === STARTING_LIVES`,但開啟時 `lives` 欄位整場凍結不動,不管實際傷了多少都會誤判成無傷,已經改成依模式二選一比對(`pathLives` 每條是否都還在平分後的滿血值)
- HUD 顯示也是二選一(`renderLivesHud()`):團隊模式顯示 `#teamLivesStat`,個人生命模式改顯示 `#pathLivesStats`(動態產生每條路徑各自的血條+負責玩家名字)

### 記分板統計(2026-07-15 加的)

`SimulationState.playerStats`(`Record<PlayerId, {damageDealt, kills}>`,純顯示用不影響經濟):

- `step()` 的塔攻擊迴圈依 `tower.ownerId` 把每個 `CombatEvent.damage` 累加給對應玩家
- 擊殺數用當下 tick 的 `killedMonsterIdsThisTick` 這個 Set 去重,同一隻怪同個 tick 被好幾座塔一起打死(常見於 splash 路線或剛好都在冷卻尾聲)只算一次,算給第一個把牠打進 0 血以下的塔主人

### 「呼叫下一波」/ `effectiveWaveTick()`(2026-07-15 加的)

`SimulationState.waveTickOffset` 是被指令(`skip_to_next_wave`)修改的**動態狀態**,不是像 `difficultyPercent`/`playerElements` 那種開局後固定不變的靜態設定,**要算進 `computeChecksum`**(這點容易漏掉,因為表面上感覺跟 `endlessMode` 那種一次性旗標很像,但 `endlessMode` 從頭到尾不變、`waveTickOffset` 會變,兩者不能一概而論)。

`step()` 裡任何要判斷「現在算第幾波」的地方(生怪、加碼波判定、勝利判定)都要用 `effectiveWaveTick(next)` 而不是原始的 `tick`,只有跟移動速度/塔冷卻/資源建築收入這些「真時間」相關的計算才繼續用原始 `tick`。

任何玩家都能按(跟升級/集火策略同一套慣例)。場上還沒清完的怪物不會被清掉,兩波會疊在一起同時出現,這是刻意的風險/代價,不是純加速沒有代價。固定模式已經是最後一波時安全忽略,無限模式永遠有下一波。

**已確認跟加碼波不會有 exploit**:在加碼波生怪生到一半時按呼叫下一波,`applyBonusWaveRewards()` 判定用的 deadline 檢查一樣是拿跳過之後的 `effectiveWaveTick` 去比,時鐘一次跳過 deadline 的話會直接判定成「過期」(不會誤發獎勵),不是判定成「清光了」。但這個跳法確實會讓加碼波裡「原本該生但還沒生」的那幾隻怪永久不會生出來(不是暫停,直接消失在生怪排程裡)——這是刻意接受的代價,不需要修,提早跳波本來就該有「損失一部分預期收益」的風險,不是免費加速。

### 依人數縮放

`SimulationState.playerCountScalePercent` 在 `createInitialState()` 依開局玩家數算出(每多一人 +20%,單人固定 100%),跟 `difficultyPercent` 相乘後套用在生怪血量/速度(`scaledSpawn`)。**賞金刻意只跟 `difficultyPercent` 走、不跟人數加成**,避免團隊經濟雙重放大。

### `computeChecksum` 的陷阱

- **金幣要排序 key 再序列化**,不然不同機器上 `Record` 的 key 插入順序不保證一樣,會誤判成跑飛
- 陷阱的 `level` 要算入
- 資源建築的 `ticksSinceLastIncome` 會變動也要算入
- 塔的 `upgradePath`、`secondElement`(不存在時用空字串佔位)要算入
- `waveTickOffset`、`pathLives` 這類**動態**狀態要算入;`difficultyPercent`/`playerElements`/`endlessMode`/`pathOwners`/`individualLivesMode` 這類**靜態**設定不用
