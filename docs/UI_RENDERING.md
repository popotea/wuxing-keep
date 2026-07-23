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

**選單選項數上限與數字鍵快捷鍵**:非路徑格最多 8 個選項(5 種屬性 + 資源建築 + 符文圖騰 + 雙屬性塔),數字鍵快捷鍵範圍因此是 **1~8**(2026-07-21 從 1~7 擴充)。**新增選單選項時要記得同步調整這個上限**。

「雙屬性塔」選項只在玩家允許屬性 ≥2 種時才顯示,跳兩層 `showChoiceModal()` 選第一種/第二種屬性(不是列出全部組合塞爆選單)。

每個屬性配了 `TOWER_CHARACTER_NAMES` 角色名顯示在選項上。點地圖建造若金幣不足會跳 `#toast` 浮動訊息提示(`showToast()`,通用機制,之後別的地方需要跳提示也能直接複用)且不會送出注定失敗的指令。

數字鍵快捷鍵的行為是「哪個浮動選單開著就選它的第 N 個選項」(浮動建造選單或升級選路線的 `showChoiceModal()`,`main.ts` 的 `keydown` 監聽,游標在文字輸入框裡時忽略)。

## 塔的選取面板

點地圖上已有的塔是**選取**(WC3 式,`GameScene.ts` 的 `onTowerSelected`),不是直接升級:

- 選到的塔會有白框標示
- 畫面下方 `#towerPanel` 顯示即時攻擊力/範圍/攻速 + 集火策略下拉選單(`#towerPanelStrategy`,送 `set_target_strategy` action,任何人都能改)+ 分岐路線(選定後才顯示)
- 升級/賣出要在面板裡按按鈕(或 `Delete`/`Backspace` 快捷鍵賣塔、`Esc` 取消選取)才會真的送出指令
- 升級到分岐級(`UPGRADE_PATH_LEVEL`)會先跳 `showChoiceModal()` 選路線,選完才送出真正的 `upgrade_tower` 指令

點到已經有陷阱的格子會跳升級選單(封頂了才單純跳 `#toast`)、資源建築格子會跳 `#toast` 提示、圖騰格子直接跳分歧路線選擇(`main.ts` 的 `onTilePlaced` 檢查 `latestState.traps`/`resourceBuildings`/`runeTotems`),不會像以前一樣靜默不做事,方便分辨「這格真的被佔用」跟「裝飾物純視覺不影響蓋塔」兩種情況。

## HUD

**金幣/生命/波次浮動貼在畫面上方置中**(2026-07-15 改的,原本是滿版寬度的實體面板,佔掉一整塊畫面;同一天稍晚又從「整組貼右上角」改成「數值置中、按鈕留右上角」,因為右上角那組擠在螢幕角落不好看也不好讀):

- `#hud` 是 `position:fixed; left:50%; transform:translateX(-50%);` 的橫排小面板,整個容器 `pointer-events:none` 不擋地圖點擊
- 裡面每個 `.hud-stat` 各自是小圓角膠囊,金幣/波次數字用 `--accent` 上色跟其他文字區分
- **記分板/精簡檢視這兩顆操作按鈕獨立放在 `#hudToggles`**(`top:14px; right:14px`),跟置中的純顯示數值分開,理由是「數值給大家看、按鈕才是操作」
- 加碼波提示 `#bonusWave` 是獨立浮在主狀態列正下方置中的元素(`:empty` 時不佔位置)
- **精簡檢視模式**:`#hudCompactBtn` 切換 `body.hud-compact` class,拿掉膠囊底色只留浮動文字(靠文字陰影維持可讀性),偏好存 `localStorage`(`wuxing-keep:hudCompact`)

UI 圖示是自繪 SVG(`<symbol>` 定義在 `index.html` 的 `<body>` 開頭,`<svg class="icon"><use href="#icon-xxx"/></svg>` 引用),**不是 emoji**;卡片/面板用 `.panel-frame` 統一加邊角裝飾框(`#hud` 現在是浮動小面板,不再套用 `.panel-frame`)。

### 主動技能列(2026-07-23 加的)

`#skillBar` 固定貼在畫面**下緣**置中,跟上緣的 HUD 數值分兩邊不會擠在一起。容器 `pointer-events:none`,只有按鈕接得到點擊。

操作流程是**兩段式**:點技能按鈕 → 進入「施放模式」(按鈕高亮 `.skill-arming` + 畫布游標變十字 `body.skill-arming`)→ 點地圖決定圓心 → 送出 `cast_skill` 指令。再點一次同一顆、或按 `Esc` 都可以取消。

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
- 每列(自己除外)多一顆禮物按鈕(`.scoreboard-gift-btn`,事件代理綁在 `scoreboardBodyEl` 上,不用每次重畫 innerHTML 後重新綁定個別按鈕)

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
- **有特殊能力的怪**:身體外圍一圈能力代表色的環(`ABILITY_RING_COLORS`),不用點進 tooltip 就分得出哪隻要優先處理
- **纏繞中**:腳下多畫一圈綠色的圓,強調牠「被定住不動」而不是走得慢
- **飄動傷害數字**:被護盾吸收的部分用藍色另外標出來(`-30 (盾20)`),玩家才知道「傷害有進去,只是被護盾擋了」,不會誤以為打不動;附加狀態時另外飄一個狀態名稱(灼燒不飄,它每次跳傷已經是橘色數字了,再飄會洗版)
- **技能特效**:`spawnSkillEffect()` 在施放中心畫一個從小放大、淡出的圓。跟飄動傷害數字走同一套模式(tween 自己銷毀,不需要 id-keyed 追蹤,也就不用管 `resetCamera()` 的清理)

### 移動類型的視覺效果

`groundEffectsLayer`(`setDepth(0.5)`,蓋在地板材質上面、塔/怪物圖片下面)畫兩件事:

- `moveType==='water'` 的怪物出現時,牠所在的整條路徑(`tilesForPath()` 逐條路徑分開算,不是整張地圖)浮現半透明藍色疊加(用 `Math.sin` 做明暗脈動模擬水流,不是真的流動動畫)
- `moveType==='air'` 的怪物在地面多畫一個影子,`renderMonster()` 把牠的圖片本身(連同血條/首領框)往上位移一點製造懸浮感,**這個視覺位移不影響 `m.pos` 本身的戰鬥判定座標**

`drawGroundEffects()` 也負責固定顯示符文圖騰的範圍圈(不用選取就看得到覆蓋範圍,這跟塔的射程圈「只在選取時才顯示」**故意不同**——圖騰範圍是擺放策略的核心資訊,不是攻擊判定細節)。

### 鏡頭與縮放

**畫面固定顯示整張地圖(`GRID_WIDTH x GRID_HEIGHT`),不管螢幕多大,不用平移鏡頭**(2026-07-16 改的——原本是固定只看得到約 `VIEWPORT_TILES_W x VIEWPORT_TILES_H` 格、滑鼠貼邊緣平移鏡頭的世紀帝國式設計,玩家反應滑鼠平移不好操作):

`applyViewportZoom()` 依目前畫布實際尺寸(`this.scale.width/height`)算 `zoomX`/`zoomY`(= 畫布像素 ÷ `GRID_WIDTH`(或 `GRID_HEIGHT`)× `TILE_PX`),取兩者較保守(較小)的一邊當 `Camera.setZoom()` 的縮放倍率,確保地圖完整塞得下不會被裁掉,**不再夾底線 1 倍**(現在通常是縮小,不是放大)。`create()` 跟 `resize` 事件都要呼叫,不然畫布尺寸變了但 zoom 沒跟著重算。

**這個改動讓 `update()` 裡的邊緣平移邏輯自動變成 no-op**(`maxScrollX`/`maxScrollY` 算出來就是 0,因為 `cam.worldView` 已經跟整張地圖一樣大或更大)——程式碼還留著沒刪,只是永遠不會真的觸發捲動,這是刻意的最小改動。

> ⚠️ **鏡頭有 zoom 之後,任何原本直接拿 `cam.width`/`cam.height`(螢幕像素)當「目前看得到多少世界座標」的地方都要改成 `cam.worldView.width`/`cam.worldView.height`**(已經把 zoom 算進去的世界座標範圍)——`jumpCameraFromMinimapClick()`、`update()` 邊緣平移的捲動上限、`drawMinimap()` 畫的鏡頭範圍白框,三處都改了,漏改的話 zoom!=1 時小地圖白框大小或捲動範圍會算錯。

**畫布是滿版、跟著版面尺寸動態縮放**(2026-07-15 改的,原本固定 880x560 太小):`PhaserGame.ts` 用 `Phaser.Scale.RESIZE` 模式;`GameScene.ts` 的 `create()` 監聽 `this.scale.on('resize', ...)`,同步更新 `Camera.setViewport()`,不然畫布變大了鏡頭視野卻沒跟著變,只會畫在左上角一小塊。

**對局中整頁不能上下左右拖曳/滾動**(`body.game-active { overflow: hidden; }`,`main.ts` 的 `showGameScreen()` 切換這個 class),要像真的裝了一套遊戲一樣。

**新對局開始一定要呼叫 `gameRenderer.resetCamera()`**——`Phaser.Game` 整個網頁只建立一次、跨對局重複使用,鏡頭捲動位置不會自己歸零。

### 手機直式螢幕的黑邊死區(2026-07-21 修的)

行動裝置觸控支援排查時發現的既有 bug。`applyViewportZoom()` 取寬高比較保守的那一邊縮放,窄長比例的畫布(手機直式螢幕)另一軸會留下大片空白,而且貼齊左上角不置中——桌面寬螢幕這個死區窄到不容易注意到,手機上卻佔掉六成以上畫面。

**修法特意不在 Phaser 鏡頭這邊**(試過 scrollX/Y 負值置中、也試過 `setViewport()` 縮小置中兩種寫法,這個版本的 Phaser——4.2.1——在 zoom!=1 時,鏡頭 `useBounds` 的內建 `clampX`/`clampY` 跟 `setViewport`+`setZoom` 疊加的內部計算都對不太上,實測會把手動置中的結果整個蓋掉,或算出跟預期不符的縮放結果),改成從根源避免「視野比地圖大」發生:

`index.html` 新增 `#gameCanvasWrap` 包住 `#gameCanvas`,用 `aspect-ratio: 40/24`(對應 `GRID_WIDTH:GRID_HEIGHT`)+ `max-height:100%` + `margin-block:auto` 讓畫布本身永遠跟地圖同比例、在 `#gameScreen` 裡置中,縮放後自然剛好貼合。

> ⚠️ **不能直接在 `#gameCanvas` 本身套用寬高比**:Phaser 的 `Scale.RESIZE` 模式會把它的 inline style 直接設成 `width:100%;height:100%`,蓋過任何寫在 `<style>` 裡的 CSS(這是排查這個 bug 時繞了一圈才發現的關鍵坑,只能在它外面再包一層 Phaser 不會碰的元素)。`applyViewportZoom()` 因此維持最原始最簡單的寫法就好(縮放取比較保守的一邊,不用再處理置中)。

小地圖(`MINIMAP_SCALE_MAX`/`minimapScale` 實例欄位)原本是固定像素倍率,畫布縮小後會佔掉快一半畫面,`applyViewportZoom()` 依畫布尺寸動態算 `minimapScale`(`MINIMAP_MAX_CANVAS_RATIO=0.2`,取寬高比較保守的一邊跟桌面倍率取較小值),桌面大畫布上維持原本手感不變。

### 觸控裝置支援(2026-07-21 加的)

- `index.html` 的 `<meta name="viewport">` 加上 `maximum-scale=1.0, user-scalable=no`(遊戲畫面已經自動縮放塞滿,不需要瀏覽器層級再縮放一次,雙指/雙擊縮放只會把版面弄亂)
- `body.game-active` 加上 `touch-action: none`(擋掉 iOS Safari 的橡皮筋捲動/下拉刷新在點地圖時偶發搶走觸控事件的問題,`overflow:hidden` 只能擋 body 捲動,擋不了手勢層級的干擾)
- `@media (pointer: coarse)` 區塊只在觸控為主的裝置放大 `.hud-action-btn`(呼叫下一波/緊急補命/記分板/精簡檢視)、塔面板升級賣出按鈕、記分板送禮按鈕的 padding,滑鼠/軌跡板裝置的精簡尺寸不受影響(這些按鈕平常刻意做得小巧是設計選擇,但小於 40px 的熱區在手機上很容易點不準)
- Phaser 的 `pointerdown` 事件本身已經同時處理滑鼠跟觸控,不用另外寫觸控專屬的輸入邏輯;邊緣平移本來就已經是 no-op,不存在「沒有觸控等價操作」的問題

### 小地圖與裝飾物

畫面右下角固定貼著(`scrollFactor(0)`)一份小地圖(顯示路徑/塔/怪物小點+鏡頭範圍白框,可以點小地圖跳鏡頭)——地圖整張都看得到之後這份小地圖某種程度上是重複資訊(白框會跟小地圖外框幾乎重疊),先留著沒拿掉,單純沒有另外要求移除。

非路徑格上有 `drawDecorations()` 灑的樹/草叢/石頭/花/小動物裝飾(用 `tileHash()` 固定雜湊決定,**不是 `Math.random()`**),**純視覺、不影響能不能蓋塔**(2026-07-15 曾有玩家誤以為裝飾物擋住建造,實測程式邏輯本來就沒有這個限制;順便把 `DECOR_SCALE`——只用在這幾個 `drawDecor*()` 函式,不影響塔/怪物等其他用 `SCALE` 的地方——調大到 1.6 倍、AI 生圖的 `placeDecorImage()` 顯示比例從 0.72 調到 0.95,解決裝飾物太小看不清楚的問題)。裝飾物優先用 `preload()` 載入的 AI 生圖,沒圖或載入失敗才退回程序生成造型。

首領怪(`Monster.isBoss`)畫大 1.8 倍+金框,小地圖上也是比較大的金點。

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
