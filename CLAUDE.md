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
- `monsters.ts` — 怪物 + 波次定義,生怪時機是「給定 tick 回傳該生什麼」的純函式,不依賴亂數;同一波怪物輪流分配路徑;支援加碼波(`bonusClearWithinTicks`/`bonusGold`);最後一波是首領波(`WaveDef.isBoss`,單隻厚血慢速怪,移動速度 `speedFp: 35` 是全部波次裡最慢的,2026-07-15 從 45 調慢過一次,拉長最後一戰時間),`isBoss` 只是流到 `Monster` 的標記欄位,不影響生怪/移動/戰鬥邏輯本身。**移動類型**(參考 Bloons TD 的 flying/camo 概念,簡化成互斥三選一):`Monster.moveType`(`'ground' | 'air' | 'water'`,`WaveDef.moveType` 可選、不填就是 `'ground'`)獨立於 `Element`(五行傷害倍率用),兩者互不影響;目前 `WAVES[0]`(水波)是 `'water'`、`WAVES[5]`(金屬波)是 `'air'`,其餘沒設定的都是預設 `'ground'`。

**無限模式**(2026-07-15 加的,跟固定 8 波的 `WAVES` 完全獨立的另一套生怪規則,兩者並存、玩家開局前選):`SimulationState.endlessMode` 這個旗標在 `createInitialState()` 就固定,`step()` 依它二選一走 `getSpawnEventsForTick()`(固定 `WAVES`)還是 `getEndlessSpawnEventsForTick()`(無限模式)。無限模式**沒有終點**,永遠不會設 `victory = true`(`step()` 裡這個判斷式加了 `!next.endlessMode` 擋掉),唯一結局是撐不住(`lives<=0` 觸發 `gameOver`);加碼波機制(`applyBonusWaveRewards`)也整個跳過不判定,因為它讀的是固定 `WAVES` 的定義,套用在無限模式自己生的怪物上會誤判/誤發獎勵。無限模式的生怪邏輯(`generateEndlessWave(waveIndex)`)是**純函式,只算「現在這一波」該生什麼**(不像固定模式的 `getSpawnEventsForTick()` 每個 tick 都迴圈整個 `WAVES` 陣列——那對只有 8 筆的固定陣列沒差,但無限模式波次會一直增加,迴圈「至今所有波次」會隨對局拉長越跑越慢,所以刻意設計成 O(1) 不重算歷史波次)。「看起來隨機但其實決定性」的內容全靠 `waveHash(waveIndex, salt)`(跟 `GameScene.ts` 的 `tileHash()` 同一種風格的純雜湊函式,同樣輸入在任何機器上都算出同一個整數),**不能用 `Math.random()`**(那樣每台機器/每次重播都會兜不起來,違反 lockstep 決定性)——血量/賞金每波 `ENDLESS_HP_GROWTH_PERCENT`(12%)線性疊加不封頂(就是要怪物持續變強),速度每波 `ENDLESS_SPEED_GROWTH_PERCENT`(3%)疊加但封頂在 `ENDLESS_SPEED_GROWTH_CAP_PERCENT`(60%,避免後期怪物快到玩家反應不過來),約 1/3 機率混 2 種元素(`waveHash` 決定),每 `ENDLESS_BOSS_INTERVAL`(5)波的最後一波是首領波(血量/賞金大幅放大、速度打七折)。`currentWaveNumberEndless()`/`ticksUntilNextWaveEndless()`/`upcomingWaveDefEndless()` 是無限模式版的 HUD 輔助函式,**故意跟固定模式的 `currentWaveNumber()` 等函式分開、不共用**——固定版的這些函式在波次编号超過 `WAVES.length` 時會封頂/回傳 `null`,直接拿來給無限模式用會讓 HUD 卡在「第 8 波」不動,或提前顯示「最後一波」。

**無限模式的網路層/UI 佈線**:`endlessMode: boolean` 從選單的核取方塊(`#soloEndlessMode`/`#hostEndlessMode`)開始,單人走 `LocalEngine` 建構子多帶的參數,多人走 `MatchConfig`/`StartMatchMsg`(`protocol.ts` 的 defensive parsing 也要記得檢查這個欄位)一路傳到 `createInitialState()`。**最佳紀錄/今日最佳/成就系統目前刻意不吃無限模式的結果**(`main.ts` 的 `onStateUpdated` 裡 `state.endlessMode` 為 true 時只顯示「撐到第 N 波,守備失敗」的橫幅,不呼叫 `saveBestRecordIfBetter`/`saveDailyBestIfBetter`/`evaluateAchievements`)——那套系統是繞著固定模式「全破」設計的,無限模式波次可以遠超過 8,兩種模式的數字混在一起比較沒有意義,之後如果要讓無限模式也有自己的紀錄/成就,需要另外設計一套獨立的比較基準(例如「最高撐到第幾波」),不是直接共用現有欄位。
- `towers.ts` — 五種元素塔屬性、可升級(`Tower.level`,封頂 `MAX_TOWER_LEVEL`)、`Tower.ownerId` 記錄誰蓋的、`Tower.targetStrategy`(`'first' | 'lowest_hp' | 'highest_hp'`,決定 `findTarget` 怎麼選目標,預設 `'first'` 打最前面,決定性 tie-break 都用 `monster.id`)。`TOWER_CHARACTER_NAMES` 是每個屬性配的角色名(給隨機英雄選擇 UI 顯示用,不影響數值)。**升級分岐路線**(參考 WC3 TD 手塔技能):`Tower.upgradePath`(`'none' | 'burst' | 'splash'`)在升到 `UPGRADE_PATH_LEVEL`(3 級)那一次必須定案、之後不能改——`burst`(單體強化)傷害是線性公式的 `BURST_DAMAGE_PERCENT`(150%),`splash`(範圍擴散)傷害維持線性不加成但攻擊會波及主目標 `SPLASH_RANGE_FP` 距離內的其他怪物(打 `SPLASH_DAMAGE_PERCENT` 折扣傷害)。`tryAttack()` 打中會回傳 `CombatEvent[]`(通常 1 個,splash 路線可能多個,誰、扣多少血、在哪),沒打中回傳空陣列,給 UI 顯示飄動傷害數字用。**移動類型限制**:`canTargetMoveType(element, moveType)` 決定塔打不打得到——土屬性打不到 `'air'`(純地面系搆不到天上)、火屬性打不到 `'water'`(呼應五行水克火),其餘一律打得到,刻意讓每種特殊類型都還有 4/5 屬性能打,不會有「這個屬性組合完全打不到某種怪」的卡死情況;`findTarget()` 選目標前跟 splash 路線波及的每個次要目標都會檢查這條規則。**五行相生鄰接加成**(組合建築玩法,2026-07-15 加的):`elements.ts` 新增 `GENERATED_BY`(木生火→火生土→土生金→金生水→水生木,故意跟 `BEATS` 那套「相克」用不同循環順序,兩者是獨立的五行關係,不要搞混或合併成同一張表)。`hasGeneratingNeighbor(tower, allTowers)` 檢查 8 方向鄰接(3x3 扣自己)有沒有蓋了「生」自己那個元素的塔,有的話 `effectiveCooldownTicks()` 冷卻時間打 `ADJACENCY_COOLDOWN_PERCENT`(85 = 快 15%)折扣,每次呼叫都即時重新掃鄰居(不是蓋塔當下定案存起來的靜態值),鄰居被賣掉/新蓋會立刻反映,不用處理快取失效。`tryAttack()`/`describeTower()` 都改成需要多帶一個 `allTowers: readonly Tower[]` 參數(全場所有塔,含自己)。`TowerStats.adjacencyBonusActive` 是純顯示用的旗標,`main.ts` 的塔選取面板靠它決定要不要顯示「相生加速中」提示,`GameScene.ts` 的 `drawAdjacencyLinks()` 在地圖上用鄰居元素的顏色畫一條連接線(不畫的話玩家完全看不出這個機制存在,等於白做)。
- `placements.ts` — 非攻擊型放置物:`Trap`(只能蓋路徑格,`TRAP_COST=30`)、`ResourceBuilding`(規則跟塔一樣蓋非路徑格,`RESOURCE_BUILDING_COST=80`)。沒有跟 `Tower` 共用抽象介面(三者規則差異夠大,先各自獨立型別)
- `simulation.ts` — 核心 `step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState`。`applyUpgradeTower` 在升級後的新等級**恰好**等於 `UPGRADE_PATH_LEVEL` 時,要求 `action.params.path` 是 `'burst'`/`'splash'` 之一,不是就整個升級安全忽略(不會扣錢卻沒定案路線);`step()` 的塔攻擊迴圈把 `tryAttack()` 回傳的 `CombatEvent[]` 全部展開塞進 `combatEvents`(splash 路線一次可能好幾個事件)。`computeChecksum` 的塔序列化把 `upgradePath` 也算進去。**陷阱/資源建築**:`applyBuildTrap`/`applyBuildResourceBuilding` 分別檢查蓋在路徑格/非路徑格才合法(`isBuildableTileFree` 順便擋掉塔跟資源建築互相疊格子);`step()` 裡怪物移動前用 `worldPositionFp` 查目前格子座標有沒有陷阱,有就這個 tick 的 `speedFp` 依陷阱等級打折扣(見下面「陷阱升級」;`moveType === 'air'` 的飛行怪不受影響,陷阱打不到天上);資源建築每 `RESOURCE_BUILDING_INTERVAL_TICKS` 只給 `ownerId` 自己(不是全員均分)加 `RESOURCE_BUILDING_INCOME` 金幣。`computeChecksum` 有把兩者都算進去(陷阱的 `level` 也算入,資源建築的 `ticksSinceLastIncome` 會變動也要算入)。**陷阱升級**(2026-07-15 加的,呼應「不要讓玩家蓋完就掛著不管」的設計方向):`placements.ts` 的 `Trap.level`(新蓋是 1,封頂 `MAX_TRAP_LEVEL=3`,刻意不做「用幾次就壞掉」,持續生效不會用完)+ `TRAP_SLOW_PERCENT_BY_LEVEL`(1→50%、2→65%、3→80%)+ `trapUpgradeCost()`(公式跟塔的 `upgradeCost` 同一套慣例,`TRAP_COST * level`)。`applyUpgradeTrap` 不分誰蓋的,誰都能出錢升級(跟塔升級同一套慣例),已封頂安全忽略。`main.ts` 的 `onTilePlaced`:點到已經有陷阱的格子不再只跳 `#toast`,改成跳浮動選單提供「升級陷阱」選項(封頂了才單純跳 `#toast`)。`SimulationState.playerElements`(playerId → 允許蓋的屬性陣列)在 `createInitialState()` 時就固定,`applyBuildTower` 會檢查蓋塔的屬性是不是在該玩家允許清單內,不在就安全忽略(單人模式預設給 5 選 5,不受限)。**團隊經濟模型**:`SimulationState.gold` 是 `Record<PlayerId, number>`(每人金幣獨立,各自 300 起始),`lives` 維持團隊共用一份;升級不分誰的塔(誰都能出自己的錢幫忙升級),賣塔限本人(`tower.ownerId` 要等於出手的 `playerId`);擊殺賞金/加碼波獎勵是每個現存玩家各自拿全額,不追蹤攻擊貢獻(這跟下面的記分板統計是分開的兩件事)。**記分板統計**(`SimulationState.playerStats`,`Record<PlayerId, {damageDealt, kills}>`,2026-07-15 加的,純顯示用不影響經濟):`step()` 的塔攻擊迴圈依 `tower.ownerId` 把每個 `CombatEvent.damage` 累加給對應玩家;擊殺數用當下 tick 的 `killedMonsterIdsThisTick` 這個 Set 去重,同一隻怪同個 tick 被好幾座塔一起打死(常見於 splash 路線或剛好都在冷卻尾聲)只算一次,算給第一個把牠打進 0 血以下的塔主人。**改 `computeChecksum` 時金幣要排序 key 再序列化**,不然不同機器上 `Record` 的 key 插入順序不保證一樣,會誤判成跑飛。**依人數縮放**:`SimulationState.playerCountScalePercent` 在 `createInitialState()` 依開局玩家數算出(每多一人 +20%,單人固定 100%),跟 `difficultyPercent` 相乘後套用在生怪血量/速度(`scaledSpawn`),賞金刻意只跟 `difficultyPercent` 走、不跟人數加成,避免團隊經濟雙重放大

**這個檔案的鐵則(修改 `src/sim/` 底下任何東西都要遵守)**:
- `step()` 必須是**純函式**、**完全決定性**——同樣的 `(state, tick, commands)` 在任何瀏覽器/機器上都要算出位元級相同的結果
- 全程只能用整數/定點數運算,不可以有浮點數累加、`Math.random()`、依賴物件鍵序等非決定性來源
- 不合法的指令(錢不夠、格子被佔用等)一律安全地當 no-op 忽略,不丟例外——這樣所有機器上都是相同的 no-op
- `step()` 的函式簽章是 `src/net/lockstep.ts` 依賴的契約,不要輕易改動,否則連線層要跟著改

### `src/main.ts` + `index.html`

選單畫面用「單人模式 / 多人連線」兩個頁籤(`#tabSolo`/`#tabMulti`),各自選難度+屬性(勾選框,至少 1 個,可複選)。多人連線頁籤內部再分兩個互斥狀態:**設定表單**(`#multiSetup`,選屬性、建房/加入)跟**房間 Lobby**(`#multiLobby`,房號/邀請連結、玩家列表、準備/開始對局/離開房間),`main.ts` 的 `showLobby()`/`resetToMultiSetup()` 負責切換,建/加房成功才會秀 Lobby,不是永遠疊在一起。多人對局要**所有 roster 裡的玩家都按過準備**,房主的「開始對局」才會生效(`Room.setReady()`/`startBtn` 的 disabled 邏輯)。

**建造已經不是固定佔用畫面底部的建塔列,改成點地圖格子才浮現的選單**(2026-07-15 改的,原本的 `#buildBar` 已經拿掉):`GameScene.ts` 的 `onTilePlaced(x, y, screenX, screenY)` 多帶了點擊當下的畫布像素座標,`main.ts` 的 `showFloatingBuildMenu()` 換算成頁面座標,把選單浮動定位在點擊處附近(`#floatingBuildMenu`,透明的 `#floatingBuildBackdrop` 負責接「點別處關掉選單」的點擊,不會讓畫面變暗)。選單內容依點到的格子是不是路徑格動態決定,不是靠玩家事先選好的「模式」:
- 路徑格(`isOnPath` 為 true):只能蓋陷阱,選單只會顯示這一個選項。
- 非路徑格:**蓋塔改成隨機英雄選擇**(參考 WC3 TD)——`randomTowerOffer()` 從玩家自己允許的屬性清單隨機抽最多 3 個(`Math.random()` 純本地 UI 用,不影響模擬層決定性)+ 資源建築,一起列在選單裡;每個屬性配了 `TOWER_CHARACTER_NAMES` 角色名顯示在選項上。

點地圖建造若金幣不足會跳 `#toast` 浮動訊息提示(`showToast()`,通用機制,之後別的地方需要跳提示也能直接複用)且不會送出注定失敗的指令。數字鍵快捷鍵改成「哪個浮動選單開著就選它的第 N 個選項」(浮動建造選單或升級選路線的 `showChoiceModal()`,`main.ts` 的 `keydown` 監聽,游標在文字輸入框裡時忽略)。點地圖上已有的塔是**選取**(WC3 式,`GameScene.ts` 的 `onTowerSelected`),不是直接升級——選到的塔會有白框標示,畫面下方 `#towerPanel` 顯示即時攻擊力/範圍/攻速+集火策略下拉選單(`#towerPanelStrategy`,送 `set_target_strategy` action,任何人都能改)+分岐路線(選定後才顯示),升級/賣出要在面板裡按按鈕(或 Delete/Backspace 快捷鍵賣塔、Esc 取消選取)才會真的送出指令;升級到分岐級(`UPGRADE_PATH_LEVEL`)會先跳 `showChoiceModal()` 選路線,選完才送出真正的 `upgrade_tower` 指令。

**HUD(金幣/生命/波次)浮動貼在畫面上方置中**(2026-07-15 改的,原本是滿版寬度的實體面板,佔掉一整塊畫面;同一天稍晚又從「整組貼右上角」改成「數值置中、按鈕留右上角」,因為右上角那組擠在螢幕角落不好看也不好讀):`#hud` 是 `position:fixed; left:50%; transform:translateX(-50%);` 的橫排小面板,整個容器 `pointer-events:none` 不擋地圖點擊,裡面每個 `.hud-stat` 各自是小圓角膠囊,金幣/波次數字用 `--accent` 上色跟其他文字區分。**記分板/精簡檢視這兩顆操作按鈕獨立放在 `#hudToggles`(`top:14px; right:14px`)**,跟置中的純顯示數值分開,理由是「數值給大家看、按鈕才是操作」,不用綁在一起。加碼波提示 `#bonusWave` 是獨立浮在主狀態列正下方置中的元素(`:empty` 時不佔位置)。**精簡檢視模式**:`#hudCompactBtn` 切換 `body.hud-compact` class,拿掉膠囊底色只留浮動文字(靠文字陰影維持可讀性),偏好存 `localStorage`(`wuxing-keep:hudCompact`)。UI 圖示是自繪 SVG(`<symbol>` 定義在 `index.html` 的 `<body>` 開頭,`<svg class="icon"><use href="#icon-xxx"/></svg>` 引用),不是 emoji;卡片/面板用 `.panel-frame` 統一加邊角裝飾框(`#hud` 現在是浮動小面板,不再套用 `.panel-frame`)。純除錯資訊(ICE 設定、tick/checksum、log)收在頁面下方的 `<details id="advancedPanel">` 裡,不佔主畫面。

**記分板**(參考 WC3,2026-07-15 加的,同一天稍晚重新美化過一次視覺):`#scoreboardBtn` 切換 `#scoreboardOverlay` 常顯/隱藏(不像升級選路線的 `showChoiceModal()` 那樣擋住地圖,可以邊玩邊看),固定貼在畫面上方置中(在 HUD 主狀態列下方,`top` 值留了足夠間距不會疊到),`#scoreboardMeta` 顯示第幾波/已進行時間(跟玩家列表寫在同一塊,不用切去看 HUD),下面依傷害由高到低排序顯示每個玩家的排名/金幣/目前蓋了幾座塔/擊殺數/造成傷害,表頭改用跟塔面板一致的 SVG 圖示(金幣/範圍/劍)取代純文字、排名第一名數字上色、隔行用極淡的底色區分、自己那列維持金色高亮。塔/怪物是幾何圖形/裝飾物一律不算,只算 `SimulationState.playerStats`(見 `simulation.ts`)。玩家名字前面的識別色小圓點(`ownerColorCss()`,只有多人才顯示)是跟塔/陷阱/資源建築底部識別色同一套配色,見上面「多人時分辨...」那段。

渲染用 Phaser 3(`src/game/GameScene.ts`/`PhaserGame.ts`)。**塔/怪物/地形都已經是正式美術,不再是幾何圖形佔位**,風格是 **Q 版可愛(參考 Kingdom Rush 系列,2026-07-15 定案)**,不是先前的魔獸爭霸暗黑奇幻:`preload()` 載入 `public/assets/towers|monsters/<element>.png`(5 種元素各 1 張,`scripts/generate-tower-monster-assets.mjs` 產的)跟 `public/assets/tiles/floor.png`/`path.png`(`scripts/generate-terrain-assets.mjs` 產的,見下方工具段落)。`renderTower()`/`renderMonster()` 用 `this.textures.exists()` 判斷有沒有載入成功——**有圖就用 `Phaser.GameObjects.Image`**(依 `id` 建立/更新/銷毀,不像 Graphics 每 tick 清掉重畫;血條/選取框/射程圈這些疊加資訊仍畫在 `dynamicLayer` 上、蓋在圖片上面,靠 `setDepth()` 固定疊放順序,不依賴建立順序),**沒圖或載入失敗才退回原本的 `drawTower()`/`drawMonster()` 幾何圖形畫法**(這條備援路徑還留著,純粹保險用)。**塔升到分岐級後換強化造型**(2026-07-15 加的,`scripts/generate-tower-evolution-assets.mjs` 產的):`resolveTowerTextureKey()` 三層備援——選了路線且 `level >= UPGRADE_PATH_LEVEL` 就優先找 `tower-<element>-<path>` 這個 evolved 材質,找不到才退回基礎 `tower-<element>`,兩個都沒有才退回幾何圖形;evolved 造型額外放大 1.15 倍(`TOWER_IMAGE_DISPLAY_RATIO` 再乘一次),搭配造型本身的變化強化「升級後更強」的感覺。**移動類型的視覺效果**:`groundEffectsLayer`(`setDepth(0.5)`,蓋在地板材質上面、塔/怪物圖片下面)畫兩件事——`moveType==='water'` 的怪物出現時,牠所在的整條路徑(`tilesForPath()` 逐條路徑分開算,不是整張地圖)浮現半透明藍色疊加(用 `Math.sin` 做明暗脈動模擬水流,不是真的流動動畫);`moveType==='air'` 的怪物在地面多畫一個影子,`renderMonster()` 把牠的圖片本身(連同血條/首領框)往上位移一點製造懸浮感,**這個視覺位移不影響 `m.pos` 本身的戰鬥判定座標**。地板材質是 `drawStaticLayer()` 用 `Phaser.GameObjects.TileSprite` 整片鋪滿(材質已經做過 seamless tiling 後處理不會有格線接縫);**路徑材質是逐格貼靜態 `Image`,刻意不用 `TileSprite`+`GeometryMask`**——2026-07-15 實測發現 mask 每影格都要重新運算合成,路徑格一多(百來格)會拖累影格率,滑鼠移動時邊緣平移/預覽格明顯卡頓,改成逐格貼圖(材質本身無縫,同一張圖照格子排就會自然接起來)完全不用 mask,静態貼一次沒有額外每影格成本。兩者都是沒圖就退回原本的純色棋盤格/純色填滿畫法。**AI 生的地板/路徑材質偏亮綠/偏亮橘、飽和度太高看久了不舒服**(2026-07-15 加的):`drawStaticLayer()` 疊一層半透明灰卡其色(`0x4a4f3a`,alpha 0.3)壓暗降飽和,只在真的載入了材質圖時才疊(棋盤格/純色備援畫法本來就偏暗不用疊)。**這個疊色圖層必須是「在地板/路徑圖片都貼完之後才 `this.add.graphics()` 建立」的獨立物件,不能沿用函式最前面就建立的那個 `g`**——Phaser 同 depth(預設都是 0)時疊放順序看加入場景的順序,`g` 在函式一開始就建立、比後面才貼上去的 `TileSprite`/逐格 `Image` 都早,拿 `g` 疊色的話疊色圖層反而會被蓋在地板/路徑圖片「下面」變成完全看不到(這也是為什麼 `g` 本身拿來畫路徑描邊/格線/方向箭頭這些疊加資訊時,不會被地板/路徑圖片蓋住而是保留原本的疊放順序——因為它們沒有被移到後面)。新對局呼叫 `resetCamera()` 時會一併清掉上一局殘留的塔/怪物 Image(避免新局的 id 撞到舊局殘留的 sprite)。

**塔正上方顯示「Lv.N」文字表示等級**(2026-07-15 改的,原本是塔尖上方一排小白點,升到高等級後不好一眼數清楚):`drawTowerLevelLabel()` 用 `Phaser.GameObjects.Text`(不是 Graphics——Graphics 沒辦法畫文字,只能畫幾何圖形),依塔的 `id` 建立/更新/銷毀,跟 `towerSprites`/`monsterSprites` 走同一套模式(存在 `towerLevelTexts` 這個 Map 裡,`pruneStaleSprites()` 泛型化成接受任何有 `destroy()` 的物件,賣塔時一併清掉)。圖片版(`renderTower()`)跟幾何圖形備援版(`drawTower()`)都呼叫同一個 `drawTowerLevelLabel()`,備援版因此多了一個 `id` 參數(原本只有 `gridX/gridY/element/level`)。

**畫面固定只看得到約 `VIEWPORT_TILES_W x VIEWPORT_TILES_H` 格,不管螢幕多大**(2026-07-15 加的,修正「滿版後大螢幕上塔/怪物看起來很小」的問題):`applyViewportZoom()` 依目前畫布實際尺寸(`this.scale.width/height`)算 `zoomX`/`zoomY`(= 畫布像素 ÷ 想看到的格數 × `TILE_PX`),取兩者較保守(較小)的一邊當 `Camera.setZoom()` 的縮放倍率,並夾在最小 1 倍(不會比原始設計更小)。`create()` 跟 `resize` 事件都要呼叫,不然畫布尺寸變了但 zoom 沒跟著重算。**鏡頭有 zoom 之後,任何原本直接拿 `cam.width`/`cam.height`(螢幕像素)當「目前看得到多少世界座標」的地方都要改成 `cam.worldView.width`/`cam.worldView.height`**(已經把 zoom 算進去的世界座標範圍)——`jumpCameraFromMinimapClick()`、`update()` 邊緣平移的捲動上限、`drawMinimap()` 畫的鏡頭範圍白框,三處都改了,漏改的話 zoom!=1 時小地圖白框大小或捲動範圍會算錯。

**畫布是滿版、跟著版面尺寸動態縮放**(2026-07-15 改的,原本固定 880x560 太小):`PhaserGame.ts` 用 `Phaser.Scale.RESIZE` 模式,畫布跟著 `#gameCanvas`(CSS 用 `flex:1` 撐滿 `#gameScreen` 扣掉 HUD/建塔列/塔面板之後的剩餘空間)的實際尺寸走;`GameScene.ts` 的 `create()` 監聽 `this.scale.on('resize', ...)`,同步更新 `Camera.setViewport()`,不然畫布變大了鏡頭視野卻沒跟著變,只會畫在左上角一小塊。**對局中整頁不能上下左右拖曳/滾動**(`body.game-active { overflow: hidden; }`,`main.ts` 的 `showGameScreen()` 切換這個 class),要像真的裝了一套遊戲一樣;`#advancedPanel`(除錯用)因此對局中會被裁掉看不到,這是刻意的,回選單就看得到。**地圖(世界)比畫面可視範圍大**(見上面 `map.ts` 的 `VIEWPORT_TILES_W`/`GRID_WIDTH`,這兩個常數現在只是「初始」尺寸,實際看到的範圍看畫布多大),`GameScene.ts` 用 `Camera.setBounds()` + 每影格 `update()` 判斷滑鼠是否貼著畫布邊緣(`EDGE_PAN_MARGIN_PX`,已經用 `this.scale.width/height` 動態抓,不用改)來平移鏡頭(世紀帝國式),搭配畫面右下角固定貼著(`scrollFactor(0)`)的小地圖(顯示路徑/塔/怪物小點+目前鏡頭範圍的白框,可以點小地圖直接跳鏡頭)。**新對局開始一定要呼叫 `gameRenderer.resetCamera()`**——`Phaser.Game` 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零。非路徑格上還有 `drawDecorations()` 灑的樹/草叢/石頭/花/小動物裝飾(用 `tileHash()` 固定雜湊決定,不是 `Math.random()`),**純視覺、不影響能不能蓋塔**(2026-07-15 曾有玩家誤以為裝飾物擋住建造,實測程式邏輯本來就沒有這個限制;順便把 `DECOR_SCALE`——只用在這幾個 `drawDecor*()` 函式,不影響塔/怪物等其他用 `SCALE` 的地方——調大到 1.6 倍、AI 生圖的 `placeDecorImage()` 顯示比例從 0.72 調到 0.95,解決裝飾物太小看不清楚的問題)。裝飾物優先用 `preload()` 載入的 AI 生圖(`public/assets/decor/`,`this.textures.exists()` 判斷有沒有載入成功),沒圖或載入失敗才退回程序生成造型。**點到已經有陷阱的格子會跳升級選單、資源建築格子會跳 `#toast` 提示**(`main.ts` 的 `onTilePlaced` 檢查 `latestState.traps`/`resourceBuildings`,見上面「陷阱升級」),不會像以前一樣靜默不做事,方便分辨「這格真的被佔用」跟「裝飾物純視覺不影響蓋塔」兩種情況。首領怪(`Monster.isBoss`)畫大 1.8 倍+金框,小地圖上也是比較大的金點,移動速度(`speedFp`)也是全部波次裡最慢的(2026-07-15 從 45 調到 35,拉長最後一戰的時間)。**塔/陷阱正上方都會顯示「Lv.N」文字**(`drawLevelLabel()`,塔跟陷阱各自一個 `Map<number, Text>` 存放,因為兩者的 id 是各自獨立的計數器、共用同一個 Map 依 id 存取會撞號)。**怪物頭上也會顯示元素名稱**(2026-07-15 加的,`drawMonsterNameLabel()`,顯示 `ELEMENT_NAMES[element]`,圖片版跟幾何圖形備援版共用同一個畫法,`monsterNameTexts` 也是依 id 建立/更新/銷毀的獨立 Map)。**`resetCamera()` 現在會清掉全部四種 id-keyed 的 GameObject**(`towerSprites`/`monsterSprites`/`towerLevelTexts`/`trapLevelTexts`/`monsterNameTexts`)——新增 `towerLevelTexts`/`trapLevelTexts`/`monsterNameTexts` 時如果忘記一併加進 `resetCamera()` 的清理清單,新對局會因為 id 從頭編號而誤用上一局殘留的文字物件,之後再新增這類「依 id 持久保留的 GameObject」都要記得同步更新這裡。

**多人時分辨「這座塔/陷阱/資源建築是誰蓋的」**(2026-07-15 加的):`src/game/playerColors.ts` 是新的共用小模組(不是 sim 的一部分,純顯示用,`Tower`/`Trap`/`ResourceBuilding` 的 `ownerId` 本來就有,不用改模擬層),`ownerColorHex()`/`ownerColorCss()` 依 `Object.keys(state.gold).sort()` 排序後的 index 從固定 8 色調色盤取色(對局開始玩家集合就固定,不支援中途加入,所有機器排序結果一定一樣,不會兜不起來);`isMultiplayer()` 只有 2 人以上才回傳 true。`GameScene.ts` 的 `drawDynamicLayer()` 只在多人時才算顏色(單人畫了也沒意義,徒增畫面雜訊),`drawOwnerMark()` 在塔/陷阱/資源建築底部畫一圈識別色橢圓,圖片版(`renderTower()`)跟幾何圖形備援版(`drawTower()`/`drawTrap()`/`drawResourceBuilding()`)共用同一個畫法。記分板(`main.ts` 的 `renderScoreboard()`)玩家名字前面也加了同一套顏色的小圓點(`ownerColorCss()`),同一個玩家在小地圖、建築底色、記分板上看到的顏色是同一個,單人模式不顯示。

### `tools/ai-hub/` + `scripts/asset-server.cjs` —— AI 美術產圖工具

跟遊戲本體(Vite/TypeScript)完全分開的獨立小工具,不會被 `npm run build` 打包進去。`npm run assets` 啟動後開 http://localhost:8787,可以用 AI 生圖 API(含免金鑰的 Pollinations)產生塔/怪物/地形素材,存進 `public/assets/`。細節見 [`docs/ART_PIPELINE.md`](docs/ART_PIPELINE.md)。**塔/怪物/地形都已經產過正式美術**(見上面「`src/main.ts` + `index.html`」段落),`public/assets/towers/`、`public/assets/monsters/` 各有 5 張,`public/assets/tiles/` 有 `floor.png`/`path.png`。三支獨立的一次性批次腳本都跳過 `tools/ai-hub` 的瀏覽器互動流程:
- `scripts/generate-decor-assets.mjs`(地圖裝飾,不去背)、`scripts/generate-tower-monster-assets.mjs`(塔/怪物)都直接呼叫免金鑰的 Pollinations API,兩者免金鑰額度常態性 429/500,腳本內建重試+退避。塔/怪物是前景遊戲物件,額外用 `jpeg-js`(解碼)+ 邊框 flood fill + `pngjs`(編碼)做真正的 alpha 去背。
- `scripts/generate-terrain-assets.mjs`(地形材質)改呼叫 HuggingFace Inference API(需要環境變數 `HF_TOKEN`),地形不用去背但需要「無縫可鋪磚」,額外做 wrap-shift+漸層混合的後處理(細節/已知的中央模糊過渡區限制見 [`docs/ART_PIPELINE.md`](docs/ART_PIPELINE.md))。

三支腳本的 prompt 都是 **Q 版可愛(Kingdom Rush 系列)** 風格,`tools/ai-hub/index.html` 裡手動生圖用的模板(`ASSET_LIB.master`/`MASTER_CREATURE`/`MASTER_TILE`)也同步改過,兩邊風格一致(細節見 [`docs/FUTURE_IDEAS.md`](docs/FUTURE_IDEAS.md))。

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
