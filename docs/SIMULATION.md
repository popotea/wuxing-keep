# 模擬層(`src/sim/`)—— 決定性塔防邏輯

> 這份文件從 `CLAUDE.md` 拆出來,只在要改 `src/sim/` 時才需要讀完整。
> **鐵則(必須遵守,已留在 `CLAUDE.md` 常駐)**:`step()` 是純函式、完全決定性、只用整數/定點數、不合法指令當 no-op。改動前也請看 `sim-determinism` skill 的檢查清單。

## `elements.ts` —— 五行關係

- **相剋**(`BEATS`,正統循環):金克木→木克土→土克水→水克火→火克金,整數傷害倍率
- **相生**(`GENERATED_BY`,2026-07-15 加的):木生火→火生土→土生金→金生水→水生木。**故意跟 `BEATS` 那套「相克」用不同循環順序,兩者是獨立的五行關係,不要搞混或合併成同一張表**
- `bestElementRelation(e1, e2, defender)`:雙屬性塔用,兩屬性各自算 relation 取比較好的那個

## `map.ts` —— 多地圖 x 固定路徑

- **固定路徑**,寫死 waypoints,不做動態尋路/A*。相鄰兩 waypoint 必須水平或垂直對齊(不能斜線)
- 怪物位置用定點數整數(`FP_SCALE=1000`)表示,`PathPos` 帶 `pathId`,全程整數運算(攻擊範圍判定用距離平方比較,不用 sqrt;跨路徑比較用 `remainingDistanceFp`)
- `retreatAlongPath(pos, distFp)` 是 `advanceAlongPath` 的反向版(土屬性塔的擊退效果用),退到起點就夾住不會變負,也不會跑到別條路徑
- `VIEWPORT_TILES_W`/`VIEWPORT_TILES_H`(22x14)已經沒有實際作用(畫面會縮放到整張地圖塞得下)

### 多地圖(2026-07-23 加的)

`MAP_DEFS` 是地圖清單,開局前選,整場固定不變。**所有地圖共用同一個 `GRID_WIDTH x GRID_HEIGHT`(40x24)**——畫面縮放、小地圖、裝飾物雜湊都是照這個尺寸算的,不同尺寸要動的地方太多,先統一。

| id | 名稱 | 路徑數 | 特色 |
|---|---|---|---|
| `crossroads` | 雙線交會 | 2 | 兩條路線在中央交叉一次,交叉點附近的塔可以同時顧到兩邊 |
| `serpent` | 長蛇迴廊 | 1 | 單一條路但來回折返很長,塔的射程覆蓋率是關鍵 |
| `trident` | 三叉分流 | 3 | 三條路線互不交會,火力必須分散 |

**路徑數量每張地圖可以不一樣**,所以以前的編譯期常數 `PATH_COUNT` 改成函式 `pathCount()`(個人生命模式的生命池子是照當前地圖的路徑數平分)。

> ⚠️ **地圖資料是模組層級的快取(`setActiveMap`),不是每次呼叫都帶參數**——這是為了避免每個 map 函式都要多帶一個 `mapId` 參數(會波及 `towers.ts`/`simulation.ts`/`GameScene.ts` 幾十個呼叫點)。
>
> **決定性仍然成立**:所有機器都在 `createInitialState()` 用同一個 `mapId` 呼叫 `setActiveMap()`,之後整場不再變動。
>
> **但任何「不走 `createInitialState()` 建立 state」的路徑都要記得自己補呼叫**,否則那台機器會拿舊地圖的路徑算,直接跑飛。目前有三處:
> - `lockstep.ts` 的 `HostLockstepEngine` 建構子 `resume` 分支(換房主接手)
> - `lockstep.ts` 的 `ClientLockstepEngine.applyResync()`(重連客戶端整份換 state)
> - `main.ts` 開局時在 `gameRenderer.resetCamera()` **之前**(`resetCamera()` 會依活躍地圖重畫靜態層,順序錯了畫面會是舊地圖的路徑)

改地圖形狀/新增地圖後,務必用腳本驗證 waypoints 合法(沒有斜線、沒超出邊界)。

## `monsters.ts` —— 怪物 + 波次

- 生怪時機是「給定 tick 回傳該生什麼」的純函式,不依賴亂數;同一波怪物輪流分配路徑
- 支援加碼波(`bonusClearWithinTicks`/`bonusGold`)
- 最後一波是首領波(`WaveDef.isBoss`,單隻厚血慢速怪,移動速度 `speedFp: 35` 是全部波次裡最慢的,2026-07-15 從 45 調慢過一次,拉長最後一戰時間),`isBoss` 只是流到 `Monster` 的標記欄位,不影響生怪/移動/戰鬥邏輯本身
- **移動類型**(參考 Bloons TD 的 flying/camo 概念,簡化成互斥三選一):`Monster.moveType`(`'ground' | 'air' | 'water'`,`WaveDef.moveType` 可選、不填就是 `'ground'`)獨立於 `Element`(五行傷害倍率用),兩者互不影響;目前 `WAVES[0]`(水波)是 `'water'`、`WAVES[5]`(金屬波)是 `'air'`,其餘沒設定的都是預設 `'ground'`

### 怪物特殊能力(2026-07-23 加的)

`Monster.ability` / `WaveDef.ability`,**互斥的六選一**(含 `'none'`),不做可疊加的標記組合(組合爆炸對平衡跟 UI 都不划算)。讓「這波該怎麼打」不只看屬性跟移動類型。

| ability | 名稱 | 效果 | 相關常數 |
|---|---|---|---|
| `healer` | 治療兵 | 定期回復範圍內同伴血量(不超過最大血量) | `HEALER_INTERVAL_TICKS` 30 / `HEALER_RANGE_FP` 2600 / `HEALER_HEAL_PERCENT` 6 |
| `shield` | 護盾兵 | 獨立一層護盾,扣完才輪到本體血量,**不會再生** | `SHIELD_HP_PERCENT` 60 |
| `splitter` | 分裂怪 | 死亡時分裂成 2 隻小怪,**小怪不會再分裂** | `SPLITTER_CHILD_COUNT` 2 / `SPLITTER_CHILD_HP_PERCENT` 35 / `SPLITTER_CHILD_BOUNTY_PERCENT` 25 |
| `aura` | 急行光環 | 提升範圍內**同伴**(不含自己)移動速度,有就是有、不累加 | `AURA_RANGE_FP` 2800 / `AURA_SPEED_BONUS_PERCENT` 30 |
| `bomber` | 爆破兵 | 漏掉時扣的生命比一般怪多 | `BOMBER_LIVES_COST` 3 |

**固定 8 波刻意「由淺入深」逐波引入**(第 3 波護盾兵 → 第 5 波分裂怪 → 第 7 波治療兵),讓玩家一次只要應付一個新機制。首領波本身**不帶特殊能力**——牠已經有血量/體型上的壓迫感,再疊能力會變成單點無解。

無限模式從第 4 波(`ENDLESS_ABILITY_START_WAVE`=3,0-based)開始,以 `ENDLESS_ABILITY_CHANCE_PERCENT`(45%)機率從能力池抽一種,同樣走 `waveHash` 決定性雜湊。

**實作上的兩個「兩段式」**(`simulation.ts` 的 `step()`):治療跟光環都是「先算出這一 tick 要補多少/誰被加速,再一起套用」,而不是邊迭代邊改——避免「A 補完 B、B 拿補過的血再去補 C」這種依陣列順序而變的連鎖效果(雖然仍是決定性的,但難以推理)。

分裂放在「移除死亡怪物之後」才做,小怪當 tick 不會被攻擊迴圈打到,下一個 tick 才進戰場。

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

### 雙屬性塔(2026-07-21 加的,2026-07-23 改成升級解鎖)

元素組合玩法拍板的第一項,`docs/FUTURE_IDEAS.md` 有完整設計脈絡。

`Tower.secondElement`(可選,不存在就是一般單屬性塔)**一旦定案就不能改**。

> **2026-07-23 從「建造時的選項」改成「升級解鎖的選項」**:原本建造選單直接有一項「雙屬性塔」,玩家一開局就能蓋。改掉是因為那樣少了成長感——雙屬性是這套元素系統裡最強的組合(對任何目標最差就是 neutral,不會吃到弱勢倍率),當成開局就有的選項等於把終局手段前置了。
>
> 現在的節奏:**1 級蓋一般單屬性塔 → 升到 `DUAL_ELEMENT_MIN_LEVEL`(2 級)→ 可以選擇加第二屬性(可選,不強制)→ 3 級選分岐路線(必選)**。
>
> 「可以加」而不是「必須加」:留著單屬性繼續升級也是合理選擇(省錢、專精單一屬性)。
>
> 指令是 `add_second_element`(`applyAddSecondElement`),費用是 `secondElementCost()` = 雙屬性造價減掉單屬性造價的**差額**(玩家蓋塔時已經付過單屬性的錢,只補差額才不會重複收費)。舊的 `build_dual_tower` 指令已經移除。

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

## `statuses.ts` —— 元素異常狀態(2026-07-23 加的)

塔攻擊時有機率對怪物附加一個依**塔的屬性**決定的負面狀態,讓「選哪個屬性」從單純的傷害倍率比較,變成還要考慮想要哪種戰術效果。

**五種效果的「作用面」刻意都不一樣**(扣血 / 減速 / 定身 / 增傷 / 位移),不是同一種效果的強弱版本:

| 屬性 | 狀態 | 效果 | 常數 |
|---|---|---|---|
| 火 | `burn` 灼燒 | 每 10 tick 跳一次傷害,持續 60 tick | `BURN_DAMAGE_PERCENT` 25(觸發那一擊傷害的百分比) |
| 水 | `chill` 冰緩 | 移動速度 -40%,持續 60 tick | `CHILL_SLOW_PERCENT` 40 |
| 木 | `entangle` 纏繞 | **完全定身**(速度歸零),持續 22 tick(刻意很短,完全停住比減速強太多) | `ENTANGLE_DURATION_TICKS` 22 |
| 金 | `sunder` 破甲 | 受到的所有傷害 +30%,持續 80 tick | `SUNDER_DAMAGE_BONUS_PERCENT` 30 |
| 土 | `knockback` 擊退 | **瞬間**沿路徑往回推 0.9 格(沒有持續時間) | `KNOCKBACK_DISTANCE_FP` 900 |

- **觸發機率**隨塔等級成長:`STATUS_BASE_CHANCE_PERCENT`(18%)+ 每級 `STATUS_CHANCE_PER_LEVEL`(4%)
- **觸發判定不能用 `Math.random()`**,走 `statusRoll(tick, towerId, monsterId)` 純雜湊——每隻怪的判定各自獨立,splash 波及的目標不會全部一起中或一起不中
- **首領怪對控制類狀態(纏繞/冰緩/擊退)有抗性**(`BOSS_CONTROL_RESIST_PERCENT` 40%,`applyBossResist`),避免被一排木塔永久定住;整數運算至少留 1,不會因為 floor 變成完全免疫
- **雙屬性塔只看主屬性**(`tower.element`)——兩種狀態都能觸發的話等於雙屬性塔在戰術效果上也全拿,跟「用基礎數值折扣換取沒有致命對位」的既有平衡精神不一致

### 統一的扣血入口 `dealDamage()`(`towers.ts`)

**所有傷害來源**(塔的直擊/splash、灼燒跳傷、隕石技能)都要走這裡,才不會有的地方算了破甲有的地方沒算、有的地方吃護盾有的地方直接扣血。

順序是「**先加破甲增傷 → 再讓護盾吸收 → 最後扣本體血量**」:破甲是「受到的所有傷害增加」所以在最前面放大;護盾是獨立的一層,同一擊可以同時打穿護盾又傷到本體。

## `skills.ts` —— 玩家主動技能(2026-07-23 加的)

塔防原本只有「蓋好就等」的被動節奏,主動技能讓玩家在危急時有臨場救援的手段,多人時還能分工。

| id | 名稱 | 效果 | 冷卻 | 範圍 |
|---|---|---|---|---|
| `meteor` | 隕石轟炸 | 範圍內所有怪物受到 `METEOR_DAMAGE`(260)傷害 | 900 tick | 3200 |
| `frost` | 寒冰風暴 | 範圍內定身 40 tick,之後殘留冰緩 100 tick,不造成傷害 | 700 tick | 3600 |
| `warcry` | 戰吼 | 範圍內**所有塔**(不分誰蓋的)攻速大幅提升 200 tick | 600 tick | 4000 |

設計原則:

- **不花金幣,只有冷卻**——金幣已經是建塔/升級的資源,技能再吃金幣會變成「有錢才有技能」,反而讓落後的玩家更沒有翻盤手段。冷卻**每個人各自獨立**,不是團隊共用一份
- **每個人都能施放,不分誰的塔/誰的路徑**(跟升級、集火策略、呼叫下一波同一套慣例)
- **只做正面互助,不做互相陷害**(既有原則):技能只會傷害怪物、增益我方,沒有任何一個能影響隊友的建築或資源
- 隕石/寒冰**刻意不檢查 `moveType`**——技能是救命手段,不該因為這波剛好是空中怪就完全失效(塔已經有移動類型限制了,技能不再疊一層)
- 隕石走 `dealDamage()`,所以一樣吃破甲增傷、一樣會被護盾吸收

`SimulationState.skillCooldowns` 是 `Record<PlayerId, number[]>`(依 `SKILL_IDS` 固定順序),**是動態狀態,要算進 checksum**。`skillCasts` 是純 UI 事件(畫特效),每 tick 清空,不算入。

冷卻在套用指令**之前**先遞減——這一 tick 剛好冷卻歸零的技能,同一 tick 就可以再放,玩家感受上比較直覺。

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
- **資源建築有每人座數上限 `MAX_RESOURCE_BUILDINGS_PER_PLAYER`(2026-07-23 加的,玩家實測回報蓋一排快速補資金破壞平衡,無限模式尤其嚴重——被動收入隨「座數 × 時間」線性放大)**。上限採「每位玩家」不是「全隊」:收入本來就只入 `ownerId` 自己的帳,而且全隊共用配額會出現「先蓋先贏、隊友互佔名額」的負面互動,違反「只做正面互助」原則。驗證用「從 `state.resourceBuildings` 過濾 `ownerId` 的現數」判斷,**刻意不在 state 加計數欄位**——衍生值天生決定性,陣列本來就在 checksum 內,`computeChecksum` 完全不用動

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

**目前這波還沒出完怪之前不能跳(2026-07-23 加的狂按防護)**:生怪只在 `spawnTick === effectiveWaveTick` 精確相等時觸發,offset 一跳,中間的生怪 tick 永遠不會被評估、那些怪整批憑空消失——原本狂按下一波可以把七波怪全部跳掉、只面對首領直接拿勝利(實測重現過:整場只生 2 隻怪就 victory),加碼波還會因為「沒有怪存活」被誤判清光而白拿獎勵。`applySkipToNextWave` 現在要求 `current > lastSpawnTickOfWave(currentWaveIndex)`(**嚴格大於**——指令先於生怪套用,等於的那個 tick 放行會把當 tick 這隻怪跳掉,實測過每波恰好少一隻);跳波因此只能壓縮「出完怪之後的空檔」,不會刪怪。連按第二下時下一波必然正在出怪,自然是 no-op,不用另外做防連點。UI 端 `waveFullySpawned()` 用同一個判定停用按鈕並顯示提示。`scripts/verify-sim.mjs` 的第 [9] 節是這個行為的回歸測試。

**勝利判定的時點**(2026-07-23 一併改的):原本是 `waveTick >= totalWaveTicks()`,提早殺光首領後要空等最後一波的時間窗走完(最多 20 秒)才跳勝利,玩家體感像當機;改成「最後一波已全部生出(`lastSpawnTickOfWave(WAVES.length - 1)`)+ 場上清空」。生怪階段在勝利判定之前,最後一隻怪生出來的那個 tick 不會誤判。

### 依人數縮放

`SimulationState.playerCountScalePercent` 在 `createInitialState()` 依開局玩家數算出(每多一人 +20%,單人固定 100%),跟 `difficultyPercent` 相乘後套用在生怪血量/速度(`scaledSpawn`)。**賞金刻意只跟 `difficultyPercent` 走、不跟人數加成**,避免團隊經濟雙重放大。

### `computeChecksum` 的陷阱

- **金幣要排序 key 再序列化**,不然不同機器上 `Record` 的 key 插入順序不保證一樣,會誤判成跑飛
- 陷阱的 `level` 要算入
- 資源建築的 `ticksSinceLastIncome` 會變動也要算入
- 塔的 `upgradePath`、`secondElement`(不存在時用空字串佔位)、`hasteTicks`(戰吼 buff)要算入
- 怪物的 `shieldHp`、`ticksSinceHeal`、五個異常狀態欄位(`statusBurnTicks`/`statusBurnDamage`/`statusBurnElapsed`/`statusChillTicks`/`statusEntangleTicks`/`statusSunderTicks`)全部要算入——漏掉任何一個都會變成「畫面看起來一樣但兩台機器算的其實不同」,而且要等狀態真的造成血量差異才會爆出來
- `skillCooldowns` 要算入(每個玩家的陣列,key 一樣要排序)
- `waveTickOffset`、`pathLives` 這類**動態**狀態要算入;`difficultyPercent`/`playerElements`/`endlessMode`/`pathOwners`/`individualLivesMode`/`mapId` 這類**靜態**設定不用
- `combatEvents`/`skillCasts` 是純 UI 事件,每 tick 清空重算,不算入
