# 未來功能構想(Backlog)

這份文件收集還沒排進 `CLAUDE.md` 路線圖 Phase 表格的功能點子。跟那張表格是互補關係:表格是「已排定/進行中」,這份是「構想收集,尚未排進 Phase、優先度未定」。可以隨時繼續往裡面加東西。

**✅ 塔/怪物正式美術已完成,風格是 Q 版可愛(Kingdom Rush 系列,不是魔獸爭霸暗黑奇幻)**:`src/game/GameScene.ts` 的 `preload()` 載入 `public/assets/towers|monsters/<element>.png`(5 種元素各 1 張),`renderTower()`/`renderMonster()` 用 `this.textures.exists()` 判斷載入成功沒——有圖就建立/更新 `Phaser.GameObjects.Image`(依 tower/monster 的 `id` 追蹤,tick 之間持續存在,不像原本 Graphics 每 tick 清掉重畫;等級光點、血條、選取框、射程圈等疊加資訊仍畫在 `dynamicLayer` 上蓋在圖片上面,靠明確 `setDepth()` 固定疊放順序),沒圖或載入失敗就退回原本的 `drawTower()`/`drawMonster()` 幾何圖形畫法(留著當保險,塔是底座+尖塔+等級小點,怪物是圓身+眼睛+頭上血條)。**圖已經產好了**:`scripts/generate-tower-monster-assets.mjs` 直接呼叫 Pollinations API(prompt 沿用 `tools/ai-hub` 的 `GAME_ASSETS` 清單措辭,額外要求「站在純白背景上」方便去背),存進 `public/assets/towers|monsters/<element>.png`。**跟裝飾物不同,這裡有做真正的 alpha 去背**:塔/怪物是前景遊戲物件,沒去背的方形背景會很明顯,所以裝了 `jpeg-js`(純 JS JPEG 解碼,無原生相依)解碼 Pollinations 回傳的 JPEG,從四個邊框做 flood fill(抓邊框平均色當背景參考色,顏色夠接近才挖成透明,挖到主體邊界就停手),再用 `pngjs`(純 JS PNG 編碼)存成真正透明背景的 PNG。實測第一版(暗黑奇幻風)去背比例落在 48%~83% 之間,已用 Node 直接檢查過輸出 PNG 的 alpha channel 數值、也視覺抽查過幾張確認品質正常。**2026-07-15 改風格**:使用者提供「其他遊戲UI參考/」資料夾裡蒐集的 Kingdom Rush 系列等塔防截圖當參考(圓潤厚實卡通造型、粗描邊、飽和暖色調),把 `TOWER_STYLE`/`MONSTER_STYLE`/五個元素的描述 prompt 全部改成 Q 版可愛語氣,10 張圖整批重新產過(去背比例 49.6%~69.2%),`tools/ai-hub/index.html` 的手動生圖模板(`ASSET_LIB.master`/`MASTER_CREATURE`/`GAME_ASSETS`)也同步改了措辭,避免之後手動補圖風格對不上。這兩個套件(`jpeg-js`/`pngjs`)只在這支一次性腳本用得到,不影響遊戲本身的執行期依賴。

**✅ 地形材質(地板/路徑)正式美術已完成**:`src/game/GameScene.ts` 的 `drawStaticLayer()` 改成:有 `public/assets/tiles/floor.png`/`path.png` 就用 `Phaser.GameObjects.TileSprite` 整片鋪滿(地板蓋住全部格子,路徑材質疊上去再用只蓋路徑格形狀的 `GeometryMask` 裁掉非路徑部分),沒圖就退回原本的棋盤格/純色填滿畫法。**圖是用 `scripts/generate-terrain-assets.mjs` 產的**,改呼叫 HuggingFace Inference API(免金鑰帳號自己申請,注意舊的 `api-inference.huggingface.co` 網域已停用,要用 `router.huggingface.co/hf-inference/models/<model>`,腳本需要環境變數 `HF_TOKEN`,**不要把 token 寫死在檔案裡或 commit 進 git**)。**地形不用去背(整格鋪滿覆蓋),但需要「無縫可鋪磚」**:AI 生的圖天生邊緣對不起來,直接鋪滿會有明顯格線接縫,腳本額外做 seamless tiling 後處理(wrap-shift 位移半張圖讓外緣自然接起來,再用「原圖 vs 位移圖」的漸層混合修掉位移後正中央出現的十字接縫)。**已知限制**:漸層混合會在材質正中央留下一圈稍微模糊的過渡區,鋪滿地圖時每隔一個材質週期(256px)會重複出現一次,不是完美無縫,但比硬接縫好很多,遊戲裡也會疊裝飾物打散單調感。第一版 prompt 沒有明確禁止「物體」,結果生出來的草地材質裡混了小箱子/羊群之類的離散造型,重複貼滿地圖會變成很怪的圖案;加強 prompt 明確要求「plain...surface, absolutely no crates, no sheep, no animals...」後才修正成乾淨的純粹地面材質。

**✅ 地圖裝飾物(樹/草叢/石頭/花/小動物)已完成(程序生成版)**:`GameScene.ts` 的 `drawDecorations()` 在非路徑格上用固定雜湊(`tileHash`,不是 `Math.random()`)決定要不要灑裝飾、灑哪一種,純視覺、跟 checksum/決定性無關,蓋在裝飾物上的塔一樣正常疊上去。**✅ AI 生圖已接進遊戲**:`scripts/generate-decor-assets.mjs` 直接呼叫 Pollinations API(跳過 `tools/ai-hub` 的瀏覽器互動+去背流程,使用者已同意這個取捨)產了 10 張(五行各配 1 種植物+1 種動物)存進 `public/assets/decor/`(`manifest.json` 記錄實際檔名)。**免金鑰匿名額度 `maxAllowed:1`,常態性回 429/500**,腳本內建重試+退避,實測跑一次要好幾分鐘、其中一張甚至要手動再單獨重試一次才成功,但最終 10 張都拿到了。`GameScene.ts` 的 `preload()` 載入這 10 張圖,`drawDecorations()` 會優先用圖片(`this.textures.exists(key)` 判斷載入成功沒),失敗才退回程序生成造型,不會整格空白。圖片沒有透明背景,用圓形 `GeometryMask` 裁掉方角讓它看起來比較像貼在地上的裝飾物(`placeDecorImage()`)。

## 鏡頭 / 地圖瀏覽

**✅ 已完成**:地圖放大到 40x24 格(1600x960px,`src/sim/map.ts` 的 `GRID_WIDTH`/`GRID_HEIGHT`),可視視窗維持原本 22x14 格大小(`VIEWPORT_TILES_W`/`VIEWPORT_TILES_H`,880x560px 沒變),滑鼠移到畫布邊緣(`GameScene.ts` 的 `EDGE_PAN_MARGIN_PX`/`EDGE_PAN_SPEED_PX_PER_SEC`)會像世紀帝國一樣平移鏡頭(`Phaser.Cameras.Scene2D.Camera.setBounds`+每影格 `update()` 裡的滾動計算),滑鼠離開畫布(`gameout`/`gameover` 事件)會停止平移。路徑改成 2 條各自延伸過整張大地圖,重新設計後剛好還是 1 個交叉點(`(29,14)`,用暫存腳本驗證過邊界跟交叉點數量)。**✅ 小地圖也一併做了**:畫面右下角固定貼著(`scrollFactor(0)`)一張縮小版全圖,顯示路徑、塔、怪物的小點,以及一個白框標示目前鏡頭在看哪裡,點小地圖可以直接把鏡頭跳過去——這樣多人連線時才看得到隊友在地圖其他地方蓋了什麼,不用真的把鏡頭移過去。
- 沒做滾輪縮放:使用者明確表示不想要滑鼠滾輪這種互動方式,所以只做了邊緣平移,沒有 `camera.zoom`。
- 換路徑之後的怪物移動總距離、生怪節奏都還是舊的數值,只是跑在更大的地圖上,尚未針對新的路徑長度重新平衡(跟其他數值一樣,先求「能跑」的版本)。

## 塔 / 放置物升級與擴充

新增可放置物件種類(非攻擊型,例如減速陷阱、資源建築),加上既有塔的升級系統(花金幣把已蓋好的塔升級,提升傷害/範圍/冷卻)。

**✅ 塔升級初版已完成**(`src/sim/towers.ts` 的 `Tower.level`/`upgradeCost`/`MAX_TOWER_LEVEL`,`src/sim/simulation.ts` 的 `upgrade_tower` action):目前只有傷害隨等級線性增加(`TOWER_DEFS[element].damage * level`),範圍/冷卻不受影響,漲價曲線是 `cost * level`,封頂 5 級。這是刻意先求「能玩」的簡化版,之後平衡調整可以再改成非線性曲線,或讓範圍/冷卻也一起變化。

**✅ WC3 式選取面板已完成**:點空地蓋塔;點已經有塔的格子是**選取**(不是直接升級),`src/game/GameScene.ts` 用白色框線標示選到誰,畫面下方 `#towerPanel` 顯示即時屬性(攻擊力/範圍/攻速)跟「升級/賣出/取消選取」三顆按鈕,升級/賣出才是真的送出指令。`src/sim/towers.ts` 的 `describeTower()` 統一算這些顯示用數值,`sellValue()` 跟 `simulation.ts` 的 `applySellTower` 共用同一個公式避免兩邊算法各改各的漂掉。

**✅ 非攻擊型放置物(陷阱、資源建築)初版已完成**:`src/sim/placements.ts` 定義 `Trap`/`ResourceBuilding` 兩個型別,沒有抽象出共用的「放置物」介面(`Tower` 也還是獨立的,沒有跟這兩個共用基底型別)——目前三種放置物的規則差異夠大(塔可升級/可集火策略、陷阱只能蓋路徑格、資源建築定期產被動金幣只給自己),硬抽共用介面不會少寫多少程式碼,先維持三個獨立型別。
- **陷阱**(`TRAP_COST=30`):只能蓋在路徑格(跟塔相反,`isOnPath` 必須是 true),`step()` 裡怪物移動前用 `worldPositionFp` 換算目前格子座標查有沒有陷阱,踩到的話這個 tick 的移動速度打 `TRAP_SLOW_PERCENT=50` 折扣。持續生效(不是觸發一次就消失),沒有計時/冷卻狀態。
- **資源建築**(`RESOURCE_BUILDING_COST=80`):規則跟塔一樣蓋在非路徑格,`ticksSinceLastIncome` 每 `RESOURCE_BUILDING_INTERVAL_TICKS=200`(10 秒)給建造者自己 `RESOURCE_BUILDING_INCOME=15` 金幣——**只給 owner 自己,不是全員均分**(呼應團隊經濟「賣塔限本人」的精神:這是個人投資報酬,不是團隊共同資源)。
- **v1 刻意不支援賣出/升級**:選到陷阱/資源建築的格子目前沒有選取面板,`GameScene.ts` 只是擋掉「點到已佔用格子誤送建造指令」,沒有真的做選取互動。之後要補的話,`towerPanel` 那套 WC3 式選取面板可以參考,但陷阱/資源建築目前沒有等級/集火策略,面板會比塔面板簡單很多(大概只需要一個賣出按鈕)。
- **視覺**:兩者都還沒有正式美術,`GameScene.ts` 的 `drawTrap()`(一排小尖刺)/`drawResourceBuilding()`(金頂小房子)是佔位幾何圖形,跟塔/怪物當初上正式美術前走的是同一套「先求能玩」路線;小地圖上也各配一個小點。
- **建造 UI**:建塔列(`#buildBar`)在五行屬性後面固定加了「陷阱」「資源建築」兩個選項(不受玩家選的屬性限制,任何人都能蓋),數字鍵快捷鍵範圍從 1~5 延伸到 1~7 涵蓋這兩個新選項。順便新增了建造花費提示(`#buildCostHint`,金幣不夠會變色)跟金幣不足時的浮動訊息提示(`#toast`),這兩個是通用機制,以後別的地方需要「錢不夠彈提示」也能直接複用 `showToast()`。

## 元素組合玩法延伸

目前 `src/sim/elements.ts` 只有單一固定克制環(金克木→木克土→土克水→水克火→火克金,`BEATS` 表,強/弱/中三種倍率,無疊加、無組合機制)。

這項是開放式遊戲設計題,先列幾個候選方向當引子,**不在這裡拍板**,需要另外找時間認真討論:

- 雙屬性塔(同時具備兩種元素的判定)
- 鄰近塔屬性共鳴加成(例如兩座水塔相鄰有小幅加成)
- 屬性組合異常狀態(例如水+冰凍、火+灼燒 DOT)
- **特殊技能/狀況觸發隨機走路方向**:例如怪物中了「冰凍」異常狀態後,可能不會乖乖照原路徑走,會亂走/走錯方向。**重要決定性限制**:模擬層(`src/sim/`)絕對不能用 `Math.random()`(每台機器算出的亂數不一樣,連線會直接跑飛),真的要做「隨機」效果,必須用跟 tick/種子綁定、每台機器都能算出同一個結果的偽隨機(例如用 `tick`、`monster.id`、`seed` 幾個值做雜湊,而不是呼叫 `Math.random()`)。目前的路徑系統(`PathPos.pathId` + `segmentIndex`)要支援「中途換路徑/開倒車」需要額外設計,不是現有結構直接就能長出來的功能。

優先度排在其他項目之後,因為玩法設計本身還沒定案,牽動的範圍也最大。

## 地圖與難度:交叉/多路徑地形

**✅ 已完成**:`src/sim/map.ts` 的 `PATHS` 現在是路徑陣列(不再是單一 `PATH_WAYPOINTS`),`PathPos` 加了 `pathId`,兩條路徑交叉一次(地圖放大到 40x24 格之後交叉點在 `(29,14)`,見上面「鏡頭/地圖瀏覽」)。同一波怪物用 `j % PATH_COUNT` 輪流分配路徑,逼玩家同時顧兩條線。`src/sim/towers.ts` 的 `findTarget` 改用 `map.ts` 新增的 `remainingDistanceFp`(跨路徑通用的剩餘距離)取代原本只能同路徑比較的 `segmentIndex`。

目前只有 2 條路徑、1 個交叉點,路線本身沒有經過美術/關卡設計,純粹是「架構上先跑得動」的初版——路徑形狀、交叉點位置、要不要 3 條以上路徑,都還可以再調整。

## 關卡提示與特殊波次

**✅ 下一波提示已完成**:HUD 上會顯示下一波的元素(`src/sim/monsters.ts` 的 `upcomingWaveDef`),搭配原本就有的倒數秒數/波次編號。

**✅ 特殊加碼波次已完成**:`WaveDef` 加了 `bonusClearWithinTicks`/`bonusGold`,插入了一個血少速度快的加碼波(第 4 波),限時 10 秒內清光可以拿 100 金幣,清不完也沒有懲罰。判定邏輯在 `src/sim/simulation.ts` 的 `applyBonusWaveRewards`,狀態存在 `SimulationState.bonusAwarded`(每波只判定一次,避免重複發放)。數值是佔位測試用,之後平衡調整可以再改。

## 其他一併記錄的延伸構想

- **✅ 單人模式進度保存已完成**:用 localStorage(`wuxing-keep:bestRecord`)記錄最高波次/是否全破,HUD 上顯示,破紀錄才會覆蓋。
- **✅ 難度選擇已完成(簡化版 New Game+),單人/多人都有**:開局前可選「普通/困難」,困難模式怪物 HP/速度 ×150%、獎勵金幣也 ×150%(`SimulationState.difficultyPercent`,`src/sim/simulation.ts` 的 `scaledSpawn`)。單人在選單直接選;多人由房主在「建立房間」表單選,經 `MatchConfig.difficultyPercent`/`StartMatchMsg.difficultyPercent` 傳給所有人。目前沒有「破關才解鎖困難」的門檻,一開始就能選。
- **✅ 分工的第一版已完成:每人開局選固定的可蓋屬性集合**:`PlayerInfo.elements`(至少 1 個,可複選,單人也適用),`src/sim/simulation.ts` 的 `applyBuildTower` 會擋掉不在允許清單內的建塔指令。
- **✅ 團隊經濟模型已定案並完成**:`SimulationState.gold` 改成 `Record<PlayerId, number>`,每人金幣各自獨立(各自 300 起始),**生命維持團隊共用一份**(`SimulationState.lives` 不變)。`Tower.ownerId` 記錄誰蓋的:**升級不分誰的塔,任何人都能幫忙升級,但花的是升級者自己的錢**;**賣塔限本人**(避免動到別人的投資,退款算自己的)。怪物死亡賞金/加碼波獎勵都是**每個現存玩家各自拿全額**(不追蹤是誰的塔打死的,多座塔常常一起打中同一隻,追蹤攻擊貢獻太複雜,選最簡單的規則)——代表人數越多,團隊總金幣量越大,還沒有針對這點做平衡(呼應下面「依人數縮放波次強度」還沒做)。`computeChecksum` 的金幣序列化有排序 key,避免不同機器 Record 插入順序不同誤判跑飛。
- **✅ 多人房間流程已完成**:選單改成「單人模式/多人連線」頁籤,多人頁籤裡就有建房/加入/房間狀態(不用展開才看得到)。**新增「準備」機制**:每個人(含房主)要在房間狀態按過「✅ 準備」,房主的「開始對局」按鈕才會解鎖(`Room.setReady()`/`SET_READY`/`ROSTER_UPDATED` 訊息,`src/net/room.ts`)。
- **✅ 浮動傷害數字已完成**:`src/sim/towers.ts` 的 `tryAttack` 改成回傳 `CombatEvent | null`(打中就回傳打了誰、扣多少血、在哪個座標),`simulation.ts` 每個 tick 收集進 `SimulationState.combatEvents`(純 UI 用的暫存資料,每 tick 開頭清空重算,不進 checksum)。`GameScene.ts` 收到後用 Phaser Text + tween 畫「-傷害值」往上飄淡出。**已知限制**:只有「非致命一擊」保證看得到——一擊斃命的怪物在同一個 tick 內就從 `state.monsters` 移除,但傷害數字本身是從 `tryAttack` 直接產生的事件(不是靠比較前後 tick 的血量差),所以其實**連斃命一擊也看得到數字**,這點比原本用血量差比對的做法更準。
- **音效/BGM**:五行對應音效點綴,歸在 Phase 5 美術範疇,先記一筆避免遺漏。
- **✅ 依人數縮放波次強度已完成**:`SimulationState.playerCountScalePercent`(`src/sim/simulation.ts` 的 `createInitialState`)依開局時的玩家數算出,每多一人 +20%,跟 `difficultyPercent`(New Game+ 倍率)相乘後套用在生怪的血量/速度上(`scaledSpawn`)。**賞金刻意不跟著這個加成**,只跟著 `difficultyPercent` 走——賞金已經因為「每個現存玩家各自拿全額」隨人數自動翻倍,人數加成再乘上去會雙重放大團隊經濟雪球。單人固定 `playerCount=1` → 100%,solo 平衡完全不受影響。這個倍率(每人 +20%)是先求「有在補償」的初版數字,還沒有實際多人測試調過手感。
- **✅ 快捷鍵已完成**:對局畫面按數字鍵 1~5 切換建塔屬性(對應建塔列由左到右的順序)、Delete/Backspace 賣掉目前選中的塔(尊重原本「賣塔限本人」的限制,`towerSellBtn.disabled` 是 true 就不會動作)、Esc 取消選取。游標在任何文字輸入框(暱稱、房號等)裡時全部忽略,避免打字誤觸(`src/main.ts` 的 `keydown` 監聽,判斷 `document.activeElement`)。
- **✅ 小地圖已完成**:見上面「鏡頭/地圖瀏覽」。
- **✅ 記住最近房號已完成**:`joinCodeInput` 加了 `list="recentRoomsList"`,`main.ts` 的 `rememberRecentRoom()`/`loadRecentRooms()` 用 localStorage(`wuxing-keep:recentRooms`,最多存 5 筆)記錄建立/加入過的房號,靠原生 `<datalist>` 做自動完成下拉,不用額外自己刻 UI。
- **✅ 塔的集火策略已完成**:`Tower.targetStrategy`(`'first' | 'lowest_hp' | 'highest_hp'`,`src/sim/towers.ts`)決定 `findTarget` 怎麼在範圍內選目標,新蓋的塔預設 `'first'`(維持原本「打最前面」行為)。新增 `set_target_strategy` action(`simulation.ts` 的 `applySetTargetStrategy`),**不分誰的塔、任何隊友都能改**(跟升級同一套邏輯),塔面板加了下拉選單。`computeChecksum` 有把 `targetStrategy` 算進去,策略不同步會直接反映在 checksum 上。
- **✅ 首領波已完成**:`WaveDef`/`SpawnEvent`/`Monster` 都加了 `isBoss`,最後一波(第 7 波)換成單隻厚血(`hp:1200`)慢速(`speedFp:45`)、賞金 150 的首領怪當收尾挑戰,其餘波次/生怪邏輯完全沒動(`isBoss` 只是多一個標記欄位)。`GameScene.ts` 把首領怪畫大 1.8 倍+加一圈金框,小地圖上也是比較大的金點;HUD 的「下一波」提示是首領波時會顯示皇冠圖示+「XX首領」。數值(1200 血、150 賞金)是先求「有差異化」的初版,沒有實際多人測試調過。

## 這次盤點順手記下的新點子(尚未實作,優先度未定)

沒有一個是拍板決定,單純腦力激盪順手記錄,避免想法飄走。跟其他 backlog 項目一樣「隨時可以繼續往裡面加東西」。

- **✅ 成就系統已完成**:`main.ts` 新增 `ACHIEVEMENTS`(全破/無傷/節儉/專精 4 個,`localStorage` key `wuxing-keep:achievements`,只會解鎖不會反悔取消),在 `evaluateAchievements()` 於 victory 當下判定,跟 `bestRecord` 用同一個時機點。「無傷」看 `state.lives === STARTING_LIVES`,「節儉」看本場對局有沒有點過賣塔(`everSoldTowerThisMatch`,純前端追蹤、對局開始重置),「專精」看這個玩家開局選了幾種屬性(`myElementCountThisMatch`)。**多人連線時只反映「我自己」這局的行為**,不追蹤隊友有沒有賣塔/選了幾種屬性——跟賞金「每人各自算」的既有設計精神一致,不試圖追蹤誰做了什麼共同貢獻。選單畫面「最佳紀錄」下方多了一排徽章,解鎖了會發光,滑鼠移上去有文字說明。
- **房主斷線自動換房主 / 重連**:目前 MVP 決定「房主斷線 = 直接結束對局」(`CLAUDE.md` 已寫明是刻意取捨),但如果之後常常玩到一半斷線覺得很痛,這是最直接能救回來的方向。牽動 `src/net/room.ts` 的角色轉換邏輯跟 `lockstep.ts` 的 tick 權威轉移,工程量不小,建議真的常常遇到斷線問題再排。
- **✅ 「今日最佳」已完成(不是原本設想的「每日挑戰種子」)**:動工時發現 `seed` 目前只拿來當 `SimulationState.checksum` 的起始值,完全不影響任何生怪/數值(`WAVES`/`getSpawnEventsForTick` 都是純看 `tick` 的固定腳本,`src/sim/` 裡沒有任何隨機性),所以「當天所有人拿同一個 seed」其實跟平常玩沒有任何差別——每天、每個人本來就都是同一張地圖同一組波次。因此把這個點子改成誠實一點的版本:`main.ts` 新增「今日最佳」(`wuxing-keep:dailyBest`,`todayDateString()` 用 `Asia/Taipei` 時區的 `en-CA` locale 算今天日期),每天重新歸零,單純是給「今天想再挑戰一次」的理由,不是真的每天不同的挑戰內容。跟 `bestRecord` 同一時機判定跟顯示。
- **成就/里程碑**:例如「不賣塔通關」「只用單一屬性通關」「全破且沒漏怪」,搭配現有的 `bestRecord` localStorage 機制擴充,UI 上一個小徽章列表。
- **行動裝置觸控支援**:目前操作(邊緣平移、點擊蓋塔/選塔)都是滑鼠事件,手機瀏覽器點得到但體驗生硬(尤其邊緣平移完全沒有觸控等價操作),要支援的話至少要補雙指縮放/拖曳平移的觸控手勢,還有按鈕尺寸/版面要重新檢視是否夠大好點。
