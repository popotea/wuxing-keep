# UI 與渲染(`src/main.ts` / `index.html` / `src/game/`)

> 這份文件從 `CLAUDE.md` 拆出來,只在要改選單/HUD/Phaser 渲染時才需要讀。

## 選單畫面

用「單人模式 / 多人連線」兩個頁籤(`#tabSolo`/`#tabMulti`),各自選難度+屬性(勾選框,至少 1 個,可複選)。

多人連線頁籤內部再分兩個互斥狀態:

- **設定表單**(`#multiSetup`):選屬性、建房/加入
- **房間 Lobby**(`#multiLobby`):房號/邀請連結、玩家列表、準備/開始對局/離開房間

`main.ts` 的 `showLobby()`/`resetToMultiSetup()` 負責切換,建/加房成功才會秀 Lobby,不是永遠疊在一起。

**設定表單內「建立房間」/「加入房間」也各自是子頁籤**(`#subTabHost`/`#subTabJoin`,2026-07-16 加的,原本兩塊表單一起堆在畫面上,使用者反應看起來很花俏雜亂),`setMultiAction()` 負責切換,共用的屬性勾選框留在頁籤外面(host/join 都要用到)。

多人對局要**所有 roster 裡的玩家都按過準備**,房主的「開始對局」才會生效(`Room.setReady()`/`startBtn` 的 disabled 邏輯)。

## 浮動建造選單(2026-07-15 改的)

**建造已經不是固定佔用畫面底部的建塔列**(原本的 `#buildBar` 已經拿掉),改成點地圖格子才浮現的選單。

`GameScene.ts` 的 `onTilePlaced(x, y, screenX, screenY)` 多帶了點擊當下的畫布像素座標,`main.ts` 的 `showFloatingBuildMenu()` 換算成頁面座標,把選單浮動定位在點擊處附近(`#floatingBuildMenu`,透明的 `#floatingBuildBackdrop` 負責接「點別處關掉選單」的點擊,不會讓畫面變暗)。

選單內容依點到的格子是不是路徑格動態決定,不是靠玩家事先選好的「模式」:

- **路徑格**(`isOnPath` 為 true):只能蓋陷阱,選單只會顯示這一個選項
- **非路徑格**:蓋塔選項固定列出玩家自己允許的**全部**屬性(`buildableTowerElements()`,2026-07-16 改的,原本叫 `randomTowerOffer()`——參考 WC3 TD 隨機抽最多 3 個,玩家反應想要固定看到全部,改掉之後就不再用 `Math.random()` 了)+ 資源建築 + 符文圖騰 + 雙屬性塔,一起列在選單裡

**選單選項數上限與數字鍵快捷鍵**:非路徑格最多 7 個選項(5 種屬性 + 資源建築 + 符文圖騰),數字鍵快捷鍵範圍是 **1~7**。**新增選單選項時要記得同步調整這個上限**。

> **雙屬性不在建造選單裡**(2026-07-23 改的):改成升級解鎖的選項,在塔的浮動選單操作,見下面「加第二屬性」。

**資源建築選項會顯示「已蓋 N/上限」**(2026-07-23 加的,對應 `MAX_RESOURCE_BUILDINGS_PER_PLAYER`),達上限就 disabled 並標「已達上限」;`onChoose` 內會用最新 `latestState` 重查一次座數(選單開著時 state 可能已前進),超限就 `showToast`。UI 只是體驗層,權威驗證仍在 sim。

**個人生命模式的蓋塔警告**(2026-07-24 加的):塔只攻擊塔主人負責路徑上的怪(見 `docs/SIMULATION.md` 的路徑守備限制),點到「連最長射程的塔都搆不到自己守備路徑」的格子時,建造選單標頭顯示紅色警告「蓋塔不會開火」——`main.ts` 的 `towerWouldBeIdle()`(`defendablePathIds` + `reachablePathIds`,用 `map.ts` 的 `tilesOfPath()` 算),跟 sim 端 `canTowerDefendPath()` 同一條規則。塔選單標頭與 tooltip 也有對應提示。

每個屬性配了 `TOWER_CHARACTER_NAMES` 角色名顯示在選項上。點地圖建造若金幣不足會跳 `#toast` 浮動訊息提示(`showToast()`,通用機制,之後別的地方需要跳提示也能直接複用)且不會送出注定失敗的指令。

### 「金幣不足」要跟「不能做」分得出來(2026-07-23 加的)

單純的 `:disabled` 只是整顆變淡,玩家看不出到底是「還缺什麼條件」還是「只差錢」。錢不夠的按鈕/選項另外加 `.cost-unaffordable`(紅色調 + 較高的不透明度,要看得清楚寫什麼),文字也補上「(金幣不足)」。

- `ChoiceOption.unaffordable` 是選單選項用的旗標(跟 `disabled` 分開:`disabled` 代表「不能選」,`unaffordable` 代表「不能選的原因是錢」)
- `ChoiceOption.keepOpen`:點了之後選單不自動關(塔選單的「升級」「切換集火策略」用,WC3 式連點升級)

數字鍵快捷鍵的行為是「哪個浮動選單開著就選它的第 N 個選項」(浮動建造選單/塔選單或升級選路線的 `showChoiceModal()`,`main.ts` 的 `keydown` 監聽,游標在文字輸入框裡時忽略)。

## 塔的浮動操作選單(2026-07-23 從固定面板改成浮動)

點地圖上已有的塔是**選取**(WC3 式,`GameScene.ts` 的 `onTowerSelected`),不是直接升級。原本固定在畫面下緣的 `#towerPanel` 面板**已整個移除**,改成跟建造選單同一套浮動選單(`renderTowerMenu()`,共用 `#floatingBuildMenu` 元素),直接浮現在塔旁邊:

- 選到的塔會有白框 + 射程圈標示(射程半徑走 `towerRangeFp()`,跟攻擊判定同一個資料源——雙屬性塔是兩屬性平均,直接查 `TOWER_DEFS` 會畫錯)
- 選單錨定在塔的右緣(`GameRenderer.tileToCanvas()`,格子座標 → 畫布座標的反算,鏡頭縮放/平移都算進去),升級後在原地重建,不跟著滑鼠
- 標頭(`.floating-menu-header`)顯示塔名/等級/即時攻擊力/範圍/攻速/擁有者——觸控裝置沒有 hover tooltip,一定要在這裡看得到數值
- 選項:升級(分岐級會先跳 `showChoiceModal()` 選路線)、加第二屬性(等級不到就**不列**,不是 disabled)、集火策略(點一下循環切換,`keepOpen`)、賣出(**限本人,非本人直接不列**)
- `Delete`/`Backspace` 快捷鍵賣塔(限本人)、`Esc`/點選單外側關選單並取消選取

**重建簽章(`towerMenuSignature`)**:每 tick 由 `onStateUpdated` 呼叫 `renderTowerMenu()`,但只有等級/費用/可負擔與否等會影響內容的欄位變了才重建選單——每 tick 都重建的話,進行中的點擊會落在被銷毀的按鈕上而失效(見下面「每 tick 重畫會吃掉點擊」的坑)。分岐/第二屬性的 `showChoiceModal()` 開著時不重建(不把選單疊回彈窗上)。

點到已經有陷阱的格子會跳升級選單(封頂了才單純跳 `#toast`)、資源建築格子會跳 `#toast` 提示、圖騰格子直接跳分歧路線選擇(`main.ts` 的 `onTilePlaced` 檢查 `latestState.traps`/`resourceBuildings`/`runeTotems`),不會像以前一樣靜默不做事,方便分辨「這格真的被佔用」跟「裝飾物純視覺不影響蓋塔」兩種情況。

## HUD

**金幣/生命/波次浮動貼在畫面上方置中**(2026-07-15 改的,原本是滿版寬度的實體面板,佔掉一整塊畫面;同一天稍晚又從「整組貼右上角」改成「數值置中、按鈕留右上角」,因為右上角那組擠在螢幕角落不好看也不好讀):

- `#hud` 是 `position:fixed; left:50%; transform:translateX(-50%);` 的橫排小面板,整個容器 `pointer-events:none` 不擋地圖點擊
- 裡面每個 `.hud-stat` 各自是小圓角膠囊,金幣/波次數字用 `--accent` 上色跟其他文字區分
- **記分板/精簡檢視這兩顆操作按鈕獨立放在 `#hudToggles`**(`top:14px; right:14px`),跟置中的純顯示數值分開,理由是「數值給大家看、按鈕才是操作」
- 加碼波提示 `#bonusWave` 是獨立浮在主狀態列正下方置中的元素(`:empty` 時不佔位置)
- **精簡檢視模式**:`#hudCompactBtn` 切換 `body.hud-compact` class,拿掉膠囊底色只留浮動文字(靠文字陰影維持可讀性),偏好存 `localStorage`(`wuxing-keep:hudCompact`)

UI 圖示是自繪 SVG(`<symbol>` 定義在 `index.html` 的 `<body>` 開頭,`<svg class="icon"><use href="#icon-xxx"/></svg>` 引用),**不是 emoji**。2026-07-23 補了三組:主動技能(`icon-meteor`/`icon-frost`/`icon-warcry`)、怪物特殊能力(`icon-healer`/`icon-shield`/`icon-split`/`icon-aura`/`icon-bomb`)、元素異常狀態(`icon-burn`/`icon-chill`/`icon-entangle`/`icon-sunder`/`icon-knockback`)。`main.ts` 的 `SKILL_ICONS`/`ABILITY_ICONS`/`STATUS_ICONS` 是對應表,**放在 main.ts 而不是 `sim/` 底下**——圖示純粹是顯示層的事,模擬層不該知道 UI 用什麼圖。`STATUS_UI_COLORS`/`ABILITY_UI_COLORS` 刻意跟 `GameScene.ts` 的染色/顏色環同一套配色,玩家在 tooltip 看到的顏色要跟地圖上那隻怪的顏色對得起來。

卡片/面板用 `.panel-frame` 統一加邊角裝飾框(`#hud` 現在是浮動小面板,不再套用 `.panel-frame`)。

### 主動技能列(2026-07-23 加的)

`#skillBar` 固定貼在畫面**下緣**置中,跟上緣的 HUD 數值分兩邊不會擠在一起。容器 `pointer-events:none`,只有按鈕接得到點擊。

操作流程是**兩段式**:點技能按鈕 → 進入「施放模式」(按鈕高亮 `.skill-arming` + 畫布游標變十字 `body.skill-arming`)→ 點地圖決定圓心 → 送出 `cast_skill` 指令。再點一次同一顆、或按 `Esc` 都可以取消。

**技能說明 `#skillHint`**(2026-07-23 加的):滑鼠移到技能按鈕上、或已經進入施放模式時,在技能列正上方顯示這個技能做什麼(效果 + 冷卻 + 範圍 + 不花金幣)。原本只靠按鈕的 `title` 屬性——瀏覽器原生 tooltip 要停住等一兩秒才出現,而且**觸控裝置根本沒有 hover**,等於完全看不到說明。`renderSkillHint()` **刻意不看 disabled 狀態**:玩家常常就是在等冷卻的時候在想「這顆到底能幹嘛」。

`main.ts` 的 `onTilePlaced` **在最前面攔截施放模式**,免得又跳出建造選單讓玩家困惑。

> ⚠️ **`renderSkillBar()` 刻意不用 `innerHTML` 整塊重畫**(記分板那種做法在這裡會出事)。這個函式每個 tick(50ms)都會被呼叫來更新冷卻秒數,整塊換掉的話按鈕 DOM 每 50ms 就被銷毀重建一次——玩家按下去的瞬間如果剛好卡在重建的空檔,`mousedown` 跟 `mouseup` 會落在不同元素上,瀏覽器不會產生 `click` 事件,**點了沒反應**。(這是實測抓到的:Playwright 重試 47 次都點不到,錯誤訊息是 `element was detached from the DOM`。)
>
> 正確做法:按鈕只建立一次(結構固定,`SKILL_IDS` 不會變),之後每 tick 只更新文字/`disabled`/class。記分板可以用 `innerHTML` 是因為它不是每 tick 重畫。

### 「呼叫下一波」按鈕

HUD 波次列旁邊的 `#skipWaveBtn`,送出 `skip_to_next_wave` 指令(行為與代價見 `docs/SIMULATION.md`)。

**2026-07-20 UI 補了個回饋**:原本已經是最後一波時按鈕還是可以按,送出去被 `simulation.ts` 安全忽略但畫面上完全沒反應,玩家會搞不清楚是不是壞了——`renderWaveHud()` 現在會依 `ticksUntilNextWave()` 是不是 `null` 同步停用按鈕(`disabled` + 換 `title` 提示文字),無限模式永遠不會停用。

**2026-07-21 修掉一個既有 bug**:`renderWaveHud()`/`currentWaveNumberFor()` 原本是拿 `state.tick`(真實 tick)在算「目前第幾波/下一波倒數/下一波預覽」,沒有用 `simulation.ts` 匯出的 `effectiveWaveTick(state)`。場上實際生怪邏輯(`step()` 內部)本來就是對的,只有這層 HUD 顯示算錯,結果是按下「呼叫下一波」當下畫面完全沒反應,要等真實時間自然追上才會變,跟按鈕本來想給的「立刻跳」回饋完全相反。已改成兩個函式都吃 `effectiveWaveTick(state)`,固定模式跟無限模式都受影響、一併修掉。

## 除錯資訊(2026-07-21 從頁面上整個拿掉)

原本頁面下方有個 `<details id="advancedPanel">` 收合區塊放 ICE 設定/tick/checksum/log,使用者反應「頁面上不要有測試相關資訊」,已經整個移除:

- `log()` 改寫到瀏覽器主控台(`console.log`,不是頁面上的 `<pre>`)
- tick/checksum 改掛在 `window.__wuxingDebug`

**ICE 的 TURN 帳密設定不是純除錯,是連不上時真正用得到的功能**(沒填就只會用 STUN,見 `net.ts` 的 `buildIceServers`,對某些網路環境直連會失敗),所以沒有整個拿掉,改移到多人連線設定表單裡一個收合的 `<details id="connectionTroubleshoot">`(摘要文字是「連不上朋友的房間?點這裡」,用引導文字取代原本赤裸裸的除錯欄位標籤,附上 openrelay.metered.ca 免費申請連結)。

## 記分板(2026-07-15 加的,參考 WC3)

`#scoreboardBtn` 切換 `#scoreboardOverlay` 常顯/隱藏(不像升級選路線的 `showChoiceModal()` 那樣擋住地圖,**可以邊玩邊看**),固定貼在畫面上方置中(在 HUD 主狀態列下方,`top` 值留了足夠間距不會疊到)。

- `#scoreboardMeta` 顯示第幾波/已進行時間(跟玩家列表寫在同一塊,不用切去看 HUD)
- 下面依傷害由高到低排序顯示每個玩家的排名/金幣/目前蓋了幾座塔/擊殺數/造成傷害
- 表頭改用跟塔面板一致的 SVG 圖示(金幣/範圍/劍)取代純文字、排名第一名數字上色、隔行用極淡的底色區分、自己那列維持金色高亮
- 塔/怪物是幾何圖形/裝飾物一律不算,只算 `SimulationState.playerStats`
- 玩家名字前面的識別色小圓點(`ownerColorCss()`,只有多人才顯示)是跟塔/陷阱/資源建築底部識別色同一套配色
- 每列(自己除外)多一顆禮物按鈕(`.scoreboard-gift-btn`,事件代理綁在 `scoreboardBodyEl` 上)

### ⚠️ 每 tick 重畫 innerHTML 會吃掉點擊(2026-07-23 修的 bug,通用教訓)

瀏覽器的 click 事件要求 mousedown 跟 mouseup 落在**同一條存活的 DOM 鏈**上。任何「每 tick(50ms)整段 `innerHTML` 重建」的區塊,裡面的按鈕都會在玩家按下到放開之間被銷毀——click 根本不會派發(Playwright 實測按住 120ms 的點擊 0/10 有效),玩家的感受就是「按了沒反應」。**事件代理救不了這個**(代理只解決「監聽器掉了」,救不了「按鈕本身死了」)。

實際踩到的兩處:記分板的送金幣按鈕、個人生命模式的路徑補命按鈕——玩家回報「買生命/送金幣無效」,模擬層跟連線層完全正常,斷點就是 UI 層的指令從來沒送出去。

**正確做法**(比照 `renderSkillBar()`):結構只建一次,每 tick 只更新 `textContent`/`classList`/`hidden` 這些屬性;集合變了(玩家離線、換地圖)才整個重建;排序變了用 `append` 搬移既有節點(搬移不銷毀)。`renderScoreboard()`(`scoreboardRowEls`)、`renderLivesHud()`(`pathLivesRowEls`)、`renderTowerMenu()`(重建簽章)都是這個模式。

## Phaser 渲染(`src/game/GameScene.ts` / `PhaserGame.ts`)

### 美術資產與備援

**塔/怪物/地形都已經是正式美術,不再是幾何圖形佔位**,風格是 **Q 版可愛(參考 Kingdom Rush 系列,2026-07-15 定案)**,不是先前的魔獸爭霸暗黑奇幻。

`preload()` 載入:

- `public/assets/towers|monsters/<element>.png`(5 種元素各 1 張)
- `public/assets/tiles/floor.png` / `path.png`
- `public/assets/decor/`(地圖裝飾)

`renderTower()`/`renderMonster()` 用 `this.textures.exists()` 判斷有沒有載入成功:

- **有圖就用 `Phaser.GameObjects.Image`**(依 `id` 建立/更新/銷毀,不像 Graphics 每 tick 清掉重畫;血條/選取框/射程圈這些疊加資訊仍畫在 `dynamicLayer` 上、蓋在圖片上面,靠 `setDepth()` 固定疊放順序,不依賴建立順序)
- **沒圖或載入失敗才退回原本的 `drawTower()`/`drawMonster()` 幾何圖形畫法**(這條備援路徑還留著,純粹保險用)

**塔升到分岐級後換強化造型**(2026-07-15 加的):`resolveTowerTextureKey()` 三層備援——選了路線且 `level >= UPGRADE_PATH_LEVEL` 就優先找 `tower-<element>-<path>` 這個 evolved 材質,找不到才退回基礎 `tower-<element>`,兩個都沒有才退回幾何圖形;evolved 造型額外放大 1.15 倍(`TOWER_IMAGE_DISPLAY_RATIO` 再乘一次),搭配造型本身的變化強化「升級後更強」的感覺。

### 每張地圖各自的地形材質(2026-07-23 加的)

原本三張地圖共用同一套草地+土路,只有路徑形狀不同,視覺上分不出來。現在各有主題:

| 地圖 | 主題 | 材質來源 |
|---|---|---|
| `crossroads` | 草原 | 共用材質的複製(已調校過,不重產) |
| `serpent` | 沙漠(沙地 + 石板路) | `scripts/generate-map-terrain-assets.mjs` |
| `trident` | 雪原(雪地 + 凍礫路) | 同上 |

- **三層備援**(同塔的 `resolveTowerTextureKey()` 精神):`resolveTileKey()` → 地圖專屬材質 → 共用 `tiles/floor.png|path.png` → 純色棋盤格
- **preload 一次載入所有地圖的材質**:Phaser 的 `preload()` 整個網頁生命週期只跑一次,沒辦法等玩家選了地圖才載。材質是 256x256,全部加起來幾百 KB,不值得搞動態 loader
- ⚠️ **每張地圖都要有實際檔案存在**:Phaser loader 載不到檔會往 console 噴 error(`Failed to process file: image tile-floor-xxx`),雖然備援會正常接手、功能不受影響,但主控台一直有紅字很干擾排查。`crossroads` 因此直接複製了一份共用材質過去
- **疊色(壓暗降飽和)依主題換顏色**(`TERRAIN_TINT_BY_MAP`):雪原疊原本的灰卡其會變成髒黃色,沙漠疊冷色會死氣沉沉

### 裝飾物依地圖換主題

> ⚠️ **AI 生的裝飾圖只在草原地圖用**(`DecorTheme.useAiImages`)。那批圖沒有去背、prompt 是「站在草地上」,所以每張都帶著一塊綠色草地方形背景——鋪在草原上看不太出來,但鋪在沙漠/雪原上會變成一格一格突兀的綠色補丁(實測截圖確認過)。

非草原地圖改用程序生成的幾何造型(沒有背景方塊),並依 `DECOR_THEME_BY_MAP` 換造型組合跟配色:沙漠只有石頭+乾枯灌木(黃褐),雪原是石頭+枯樹(冷灰)。`drawDecor*()` 系列因此都吃可選的顏色參數,同一批造型換配色就好,不用畫新造型;`lighten()` 從主色算高光色,不用每個主題手動配兩個顏色。

### 地板與路徑材質

- 地板材質是 `drawStaticLayer()` 用 `Phaser.GameObjects.TileSprite` 整片鋪滿(材質已經做過 seamless tiling 後處理不會有格線接縫)
- **路徑材質是逐格貼靜態 `Image`,刻意不用 `TileSprite`+`GeometryMask`**——2026-07-15 實測發現 mask 每影格都要重新運算合成,路徑格一多(百來格)會拖累影格率,滑鼠移動時邊緣平移/預覽格明顯卡頓,改成逐格貼圖(材質本身無縫,同一張圖照格子排就會自然接起來)完全不用 mask,靜態貼一次沒有額外每影格成本
- 兩者都是沒圖就退回原本的純色棋盤格/純色填滿畫法

**AI 生的地板/路徑材質偏亮綠/偏亮橘、飽和度太高看久了不舒服**(2026-07-15 修的):`drawStaticLayer()` 疊一層半透明灰卡其色(`0x4a4f3a`,alpha 0.3)壓暗降飽和,只在真的載入了材質圖時才疊(棋盤格/純色備援畫法本來就偏暗不用疊)。

> ⚠️ **這個疊色圖層必須是「在地板/路徑圖片都貼完之後才 `this.add.graphics()` 建立」的獨立物件,不能沿用函式最前面就建立的那個 `g`**。Phaser 同 depth(預設都是 0)時疊放順序看加入場景的順序,`g` 在函式一開始就建立、比後面才貼上去的 `TileSprite`/逐格 `Image` 都早,拿 `g` 疊色的話疊色圖層反而會被蓋在地板/路徑圖片「下面」變成完全看不到。(這也是為什麼 `g` 本身拿來畫路徑描邊/格線/方向箭頭這些疊加資訊時,不會被地板/路徑圖片蓋住而是保留原本的疊放順序——因為它們沒有被移到後面。)

### 靜態層與多地圖重畫(2026-07-23 加的)

地板/路徑/描邊/格線/裝飾物原本只在 `create()` 畫一次就不管了,但**多地圖之後每場對局的路徑形狀可能不一樣**,換地圖就得整個重畫。

- `staticObjects` 陣列追蹤靜態層建立的所有 GameObject,`trackStatic()` 是登記用的小 helper
- `rebuildStaticLayer()` 先 destroy 全部再重畫,由 `resetCamera()` 在每場新對局開始時呼叫
- `placeDecorImage()` 的遮罩 Graphics(`this.make.graphics`,沒進 display list)**也要追蹤**,不然換地圖會累積成看不見的記憶體洩漏

> ⚠️ **`rebuildStaticLayer()` 必須在 `map.ts` 的 `setActiveMap()` 已經切好之後才呼叫**,否則畫出來的還是上一張地圖的路徑(`isOnPath()`/`paths()` 都是讀模組層級的活躍地圖)。`main.ts` 因此在 `resetCamera()` 之前明確呼叫一次 `setActiveMap()`——不能依賴引擎建構子裡的那次,因為 `resetCamera()` 是在引擎建立**之前**呼叫的。

### 異常狀態 / 怪物能力的視覺(2026-07-23 加的)

**沒有另外產新美術**,全部用既有手段表現:

- **異常狀態**:`statusTintColor()` 直接把整隻怪 `setTint()` 染色(纏繞綠 > 冰緩藍 > 破甲黃 > 灼燒橘,同時中多個時只顯示優先度最高的那個)。⚠️ 沒有狀態時要記得 `setTint(0xffffff)` 清回白色,不然會一直留著上一次的顏色
- **護盾兵**:血條正上方多一條藍色護盾條(獨立於血條)
- **有特殊能力的怪**:身體外圍一圈能力代表色的環(`ABILITY_RING_COLORS`)+ 右上角一個代表能力的小符號(`drawAbilityGlyph()`,十字/盾牌/分裂/速度線/炸彈)。光有顏色環只分得出「這隻特別」,分不出「特別在哪」。**刻意用 Graphics 畫幾何符號不另外產美術**:5 種能力 × 5 種元素 = 25 張圖,產圖跟維護成本都不划算,而且能力是「疊加在既有怪物上的標記」,本來就不該換掉整隻怪的造型;幾何符號縮到約 5px 反而比縮小的插圖好認。造型對齊 `index.html` 裡對應的 SVG 圖示,玩家在 tooltip 跟地圖上看到的是同一個形狀
- **纏繞中**:腳下多畫一圈綠色的圓,強調牠「被定住不動」而不是走得慢
- **飄動傷害數字**:被護盾吸收的部分用藍色另外標出來(`-30 (盾20)`),玩家才知道「傷害有進去,只是被護盾擋了」,不會誤以為打不動;附加狀態時另外飄一個狀態名稱(灼燒不飄,它每次跳傷已經是橘色數字了,再飄會洗版)
- **技能特效**:`spawnSkillEffect()` 在施放中心畫一個從小放大、淡出的圓。跟飄動傷害數字走同一套模式(tween 自己銷毀,不需要 id-keyed 追蹤,也就不用管 `resetCamera()` 的清理)

### 移動類型的視覺效果

`groundEffectsLayer`(`setDepth(0.5)`,蓋在地板材質上面、塔/怪物圖片下面)畫兩件事:

- `moveType==='water'` 的怪物出現時,牠所在的整條路徑(`tilesForPath()` 逐條路徑分開算,不是整張地圖)浮現半透明藍色疊加(用 `Math.sin` 做明暗脈動模擬水流,不是真的流動動畫)
- `moveType==='air'` 的怪物在地面多畫一個影子,`renderMonster()` 把牠的圖片本身(連同血條/首領框)往上位移一點製造懸浮感,**這個視覺位移不影響 `m.pos` 本身的戰鬥判定座標**

`drawGroundEffects()` 也負責符文圖騰的範圍圈——**2026-07-23 改成只在游標停在那座圖騰的格子上才顯示**(原本是全部常駐,玩家反映圖騰一多畫面同時好幾個大圓圈,跟塔的攻擊範圍混在一起太雜亂),跟塔的射程圈「指到/選到才顯示」同一套哲學。

### 個人生命模式的「你負責的路徑」標示(2026-07-24 加的)

玩家反映進了個人生命模式認不出地圖上哪條路是自己要守的(HUD 只有文字「路徑N(你)」)。三個提示,都只在 `individualLivesMode` 畫:

- **路徑鋪色**(`drawGroundEffects()`):每條路徑鋪一層負責玩家的識別色(`ownerColorHex()`,跟塔底識別色/記分板同一套),自己的路徑 alpha 0.16 明顯、別人的 0.06 淡淡的、無人負責不鋪
- **起點標籤**(`updatePathOwnerLabels()`):「路徑N(你負責)」/「路徑N」文字,顏色用負責人識別色,跟 HUD 的「路徑N(名字)」對得上;錨點沿路徑方向往內移 1.5 格(起點常貼地圖邊緣會被裁)。整場固定,依簽章(地圖/負責人/本機玩家)重建,`resetCamera()` 要清
- **浮動箭頭**:自己路徑的起點標籤下方畫一個上下浮動(`Math.sin(time)`)的往下箭頭,每 tick 重畫在 groundEffectsLayer

渲染層需要知道「本機玩家是誰」:`GameRenderer.setLocalPlayerId()`,`main.ts` 在對局開始時設(這是每台機器各自不同的純顯示,不是模擬狀態)。

## 對局結算彈窗與出局觀戰(2026-07-24 加的)

**結算彈窗 `#matchResultOverlay`**:勝敗/中止(desync、斷線)都跳全螢幕置中的明顯結算(`showMatchResultOverlay()`)——原本只有畫面底部一行 `#resultBanner` 小字,玩家的體感是「畫面整個卡住」。兩顆按鈕:「回到選單」(跟 `#backToMenuBtn` 共用 `returnToMenu()`)、「觀看戰場」(收掉彈窗看最後戰場)。**每場只跳一次**(`matchResultShown` 旗標)——對局結束後 `onStateUpdated` 每 tick 還會繼續來(多人引擎不會馬上停),沒有旗標的話玩家按「觀看戰場」後彈窗會自己彈回來;旗標在 `resetResultBanner()`(對局開始/回選單)歸零。

**出局觀戰**(個人生命模式,對應 `docs/SIMULATION.md` 的 `isPlayerEliminated()`):自己負責的路徑全失守時——`#eliminatedBanner` 常駐提示(HUD 下方置中)、建造選單/塔選單不開(改跳 toast)、技能列整排 disabled 顯示「觀戰」、跳波按鈕停用;記分板送金幣與緊急補命(復活手段)保持可用。`wasEliminated` 旗標讓「剛出局」那一刻才跳 toast/收選單,不是每 tick 洗版;補命復活後全部自動解鎖。

### 鏡頭與縮放(2026-07-23 加了滾輪/雙指縮放與拖曳平移)

**預設顯示整張地圖(fit),玩家可以用滾輪/雙指放大、拖曳平移**:

- `applyViewportZoom()`:實際 zoom = `fitZoom`(整張地圖剛好塞進畫布的基準值,隨畫布尺寸變)× `userZoom`(使用者倍率,滾輪/雙指調,夾在 1~`MAX_USER_ZOOM`)。`userZoom=1` 時行為跟原本 fit 全圖完全相同
- `zoomAt()`:以游標/兩指中點為錨點縮放(縮放後錨點下方仍是同一個世界位置)。**`getWorldPoint` 用的是上一影格的矩陣,要在 `setZoom` 之前取**
- 拖曳平移:`pointerdown` 記錄起點,位移超過 `DRAG_THRESHOLD_PX`(觸控放寬)進入拖曳;**點擊判定(建塔/選塔)因此從 `pointerdown` 移到 `pointerup`**,拖曳放開不會觸發建造選單
- 雙指縮放:`create()` 要 `this.input.addPointer(1)`(Phaser 預設只給 1 個觸點),`updatePinch()` 每影格檢查兩指間距變化
- `resetCamera()` 把 `userZoom` 歸 1——`Phaser.Game` 跨對局重複使用,縮放不歸零會殘留到下一場
- 舊的世紀帝國式邊緣平移**已移除**(fit 時本來就是 no-op,加了縮放後會「復活」變成游標貼邊就捲動,跟拖曳平移互相干擾,而且玩家 2026-07-16 就反映過不好操作)
- **畫面縮放按鈕 `#zoomControls`**(2026-07-24 加的):畫面右側直排 ＋/－/全圖 三顆,`GameRenderer.zoomBy()`(以畫布中心為錨)/`resetZoom()`——筆電沒滾輪、不想用觸控板手勢的人用按鈕
- **擋掉瀏覽器頁面縮放**:觸控板捏合手勢會送 ctrl+wheel = 瀏覽器頁面縮放,整個版面突然變小,玩家體感是「畫面不知道為什麼縮小」——`main.ts` 在 `#gameCanvasWrap` 上 `wheel` + `preventDefault`(`passive:false`)整個擋掉;不影響 Phaser 自己的 wheel 鏡頭縮放

**scroll 超界不用自己夾,交給 `setBounds` 的 `useBounds` clamp**(每次 preRender 都會夾)。讀過 Phaser 4.2.1 的 `clampX` 原始碼確認:公式 `bx = (displayWidth - cam.width) / 2`、`bw = bx + bounds.width - displayWidth` 對任何 zoom 都正確——fit 全圖時範圍收斂成單一點,等同**強制置中**(這正是 `setScroll(0,0)` 也能置中顯示的原因;之前「zoom!=1 時 bounds 對不上」的踩坑是想手動置中「視野比地圖大」的軸,跟放大情境不同)。鏡頭 zoom 以畫布中心為原點(`screen = zoom*(world - scroll - w/2) + w/2`),`tileToCanvas()` 的反算也是照這條公式。

**畫布是滿版、跟著版面尺寸動態縮放**(2026-07-15 改的,原本固定 880x560 太小):`PhaserGame.ts` 用 `Phaser.Scale.RESIZE` 模式;`GameScene.ts` 的 `create()` 監聽 `this.scale.on('resize', ...)`,同步更新 `Camera.setViewport()`,不然畫布變大了鏡頭視野卻沒跟著變,只會畫在左上角一小塊。

**對局中整頁不能上下左右拖曳/滾動**(`body.game-active { overflow: hidden; }`,`main.ts` 的 `showGameScreen()` 切換這個 class),要像真的裝了一套遊戲一樣。

**新對局開始一定要呼叫 `gameRenderer.resetCamera()`**——`Phaser.Game` 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零。

### 畫布尺寸與比例(2026-07-23 改成 JS 計算)

畫布要永遠跟地圖同比例(40:24 = 5:3),`applyViewportZoom()` 取保守軸縮放後兩軸才會剛好貼合、沒有任何一軸留白。**比例改由 `main.ts` 的 `layoutGameCanvas()` 用 JS 算 contain**:

- `#gameCanvasArea`(flex:1 佔滿 `#gameScreen` 剩餘空間,任何比例都行)> `#gameCanvasWrap`(JS 算出的 5:3 contain 盒,絕對定位置中)> `#gameCanvas`(Phaser 掛載點)
- `ResizeObserver` 觀察 `#gameCanvasArea`,尺寸變了(視窗縮放、行動瀏覽器工具列收放、display:none 切回可見)就重排 + `gameRenderer.refreshSize()`
- **為什麼不用 CSS `aspect-ratio`**:CSS 規範裡 aspect-ratio 的軸間轉移只在兩軸皆 auto 時發生——單軸 definite(例如 `height:100%`)時,另一軸被 `max-width` 夾住後 definite 軸**不會**跟著縮,視窗比 5:3 窄的時候比例整個破掉(畫布變窄高、地圖貼上緣、下方一塊背景色)。2026-07-21/07-23 兩版 CSS 寫法都只是把破比例的情境從一軸搬到另一軸,JS 算 contain 才是兩軸都對

> ⚠️ **不能直接在 `#gameCanvas` 本身設定尺寸**:Phaser 的 `Scale.RESIZE` 模式會把它的 inline style 直接設成 `width:100%;height:100%`,蓋過任何 CSS,尺寸只能設在它外面 Phaser 不會碰的元素上。

### 行動裝置 / RWD(2026-07-21 加的,2026-07-23 擴充)

- `index.html` 的 `<meta name="viewport">`:`maximum-scale=1.0, user-scalable=no`(瀏覽器層級縮放會把版面弄亂;遊戲內已有自己的滾輪/雙指縮放)+ `viewport-fit=cover`(瀏海機種搭配 `env(safe-area-inset-*)`)
- **`100vh` 全部補一行 `100dvh`**(body/`#gameScreen`):行動瀏覽器的 100vh 是「最大視口」(含被工具列蓋住的區域),工具列展開時底部會被裁掉;dvh 是動態可視高度,舊瀏覽器自動退回前一行的 vh
- `#hud` 加 `flex-wrap` + `max-width`(窄螢幕換行置中,不再左右被裁);`top`/`bottom` 都套 `safe-area-inset`
- `@media (max-width: 700px)`:body padding 縮到 6px 把空間還給畫布、`#hudToggles` 移到右下(跟置中 HUD 錯開)、`.menu-card`/`.scoreboard-panel` 的 `min-width` 夾住不水平溢出
- **手機直式提醒 `#rotateHint`**:地圖是 5:3 橫向,直式螢幕畫布只剩約 1/4 高度——「對局中 + 直式 + 觸控」顯示全螢幕提示請玩家轉橫向,可以按「知道了」關掉繼續直式玩(`body.rotate-hint-dismissed`),不是強制
- `body.game-active` 加上 `touch-action: none`(擋掉 iOS Safari 的橡皮筋捲動/下拉刷新在點地圖時偶發搶走觸控事件的問題,`overflow:hidden` 只能擋 body 捲動,擋不了手勢層級的干擾)
- `@media (pointer: coarse)` 區塊只在觸控為主的裝置放大 `.hud-action-btn`/技能按鈕/記分板送禮按鈕的熱區
- 觸控輸入跟滑鼠共用同一套 pointer 事件;雙指縮放需要 `this.input.addPointer(1)`,單指拖曳/點擊判定見「鏡頭與縮放」

### 小地圖(2026-07-23 已移除)

2026-07-16 把畫面改成「一次顯示整張地圖」之後,小地圖就變成純粹的重複資訊——它畫的縮小版全圖跟主畫面看到的是同一塊區域,標示鏡頭範圍的白框也幾乎跟小地圖外框完全重疊。留著只是佔掉右下角一塊、讓實際可看的遊戲畫面顯得更小,已經整個拿掉(連帶移除「點小地圖跳鏡頭」的功能——鏡頭本來就不會捲動,那個功能早就沒有作用了)。

### 裝飾物

非路徑格上有 `drawDecorations()` 灑的樹/草叢/石頭/花/小動物裝飾(用 `tileHash()` 固定雜湊決定,**不是 `Math.random()`**),**純視覺、不影響能不能蓋塔**(2026-07-15 曾有玩家誤以為裝飾物擋住建造,實測程式邏輯本來就沒有這個限制;順便把 `DECOR_SCALE`——只用在這幾個 `drawDecor*()` 函式,不影響塔/怪物等其他用 `SCALE` 的地方——調大到 1.6 倍、AI 生圖的 `placeDecorImage()` 顯示比例從 0.72 調到 0.95,解決裝飾物太小看不清楚的問題)。裝飾物優先用 `preload()` 載入的 AI 生圖,沒圖或載入失敗才退回程序生成造型。

首領怪(`Monster.isBoss`)畫大 1.8 倍+金框。

### 文字標籤(id-keyed GameObject)

- **塔/陷阱/圖騰正上方顯示「Lv.N」文字**(2026-07-15 改的,原本是塔尖上方一排小白點,升到高等級後不好一眼數清楚):`drawLevelLabel()` 用 `Phaser.GameObjects.Text`(不是 Graphics——Graphics 沒辦法畫文字,只能畫幾何圖形),依物件 `id` 建立/更新/銷毀,跟 `towerSprites`/`monsterSprites` 走同一套模式
- **塔/陷阱/圖騰各自一個 `Map<number, Text>` 存放**(`towerLevelTexts`/`trapLevelTexts`/`totemLevelTexts`),因為三者的 id 是各自獨立的計數器、共用同一個 Map 依 id 存取會撞號
- **怪物頭上顯示元素名稱**(2026-07-15 加的,`drawMonsterNameLabel()`,顯示 `ELEMENT_NAMES[element]`,圖片版跟幾何圖形備援版共用同一個畫法,`monsterNameTexts` 也是依 id 建立/更新/銷毀的獨立 Map)
- `pruneStaleSprites()` 泛型化成接受任何有 `destroy()` 的物件,賣塔時一併清掉

> ⚠️ **`resetCamera()` 必須清掉全部 id-keyed 的 GameObject**(`towerSprites`/`monsterSprites`/`towerLevelTexts`/`trapLevelTexts`/`totemLevelTexts`/`monsterNameTexts`)。新增這類「依 id 持久保留的 GameObject」時如果忘記一併加進 `resetCamera()` 的清理清單,新對局會因為 id 從頭編號而誤用上一局殘留的物件。

### 符文圖騰的畫法

`drawRuneTotem()`(幾何圖形,水晶方尖碑,刻意跟塔的五行配色/資源建築的金色都不同,一眼看出是純支援建築):1 級是紫色,2 級依分歧路線換色——`damage` 偏紅紫、`haste` 偏藍紫,不用點進去看數字就能分辨狀態。

### 相生連接線

`drawAdjacencyLinks()` 在地圖上用鄰居元素的顏色畫一條連接線——**不畫的話玩家完全看不出這個機制存在,等於白做**。

## 多人時分辨「這座塔/陷阱/資源建築是誰蓋的」(2026-07-15 加的)

`src/game/playerColors.ts` 是共用小模組(**不是 sim 的一部分,純顯示用**,`Tower`/`Trap`/`ResourceBuilding` 的 `ownerId` 本來就有,不用改模擬層):

- `ownerColorHex()`/`ownerColorCss()` 依 `Object.keys(state.gold).sort()` 排序後的 index 從固定 8 色調色盤取色(對局開始玩家集合就固定,不支援中途加入,所有機器排序結果一定一樣,不會兜不起來)
- `isMultiplayer()` 只有 2 人以上才回傳 true
- `GameScene.ts` 的 `drawDynamicLayer()` 只在多人時才算顏色(單人畫了也沒意義,徒增畫面雜訊),`drawOwnerMark()` 在塔/陷阱/資源建築底部畫一圈識別色橢圓,圖片版跟幾何圖形備援版共用同一個畫法
- 同一個玩家在小地圖、建築底色、記分板上看到的顏色是同一個,單人模式不顯示

## 滑鼠懸停說明(2026-07-15 加的,2026-07-16 補上符文圖騰)

`GameScene.ts` 的 `computeHoverInfo()` 每影格算一次滑鼠底下是什麼(回傳 `HoverInfo | null`,`{kind, id}`,`kind` 五選一:塔/怪物/陷阱/資源建築/符文圖騰),透過 `onHoverInfoChanged` callback 交給 `main.ts` 的 `renderObjectTooltip()` 決定要顯示什麼內容、定位在游標旁邊(`#objectTooltip`,換算成頁面座標同 `showFloatingBuildMenu()` 的做法)。

- **怪物用滑鼠世界座標比實際像素位置的距離平方**(不是比格子座標)——怪物不像塔/陷阱固定在格子中心,走在路徑上的位置是連續像素座標,用格子比對會抓不到
- 同格有怪物又有陷阱時(陷阱蓋在路徑格,怪物走過去),**優先顯示怪物**(滑鼠停在那邊通常是想看怪物資訊)

> ⚠️ **這個 callback 每影格都會呼叫,不是只在「換了不同物件」時才呼叫**——塔的攻速/怪物血量這些數值會持續變動,浮動說明要能跟著即時更新,不能只在切換物件時才重畫;`main.ts` 收到 `null` 代表滑鼠沒停在任何物件上,要把說明藏起來。

顯示內容:塔顯示 `describeTower()` 的即時數值(含相生/圖騰兩種加成是否生效),陷阱顯示目前減速%跟升級花費,資源建築顯示收入週期,符文圖騰顯示加成%跟範圍,怪物顯示血量/移動類型。
