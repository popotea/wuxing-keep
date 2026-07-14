# 未來功能構想(Backlog)

這份文件收集還沒排進 `CLAUDE.md` 路線圖 Phase 表格的功能點子。跟那張表格是互補關係:表格是「已排定/進行中」,這份是「構想收集,尚未排進 Phase、優先度未定」。可以隨時繼續往裡面加東西。

**目前視覺呈現狀態**:`src/game/GameScene.ts` 用 Phaser Graphics 畫了比較有辨識度的造型(塔是底座+尖塔+等級小點,怪物是圓身+眼睛+頭上血條),但仍然是幾何圖形佔位,不是真正的美術圖片/精靈。**✅ 產圖工具已就緒**:`npm run assets` 開啟 `tools/ai-hub/` 的 AI Hub,可以用 AI 生圖 API(含免金鑰的 Pollinations)產生五行塔/怪物/地形素材並存進 `public/assets/`,細節見 [`docs/ART_PIPELINE.md`](ART_PIPELINE.md)。工具已就緒不代表已經用它產過圖——`GameScene.ts` 目前還沒有任何程式碼會讀取 `public/assets/`,之後只要把 `drawTower`/`drawMonster` 內部畫法換成讀取圖片/Sprite 即可,外部呼叫介面不用改。

## 鏡頭 / 地圖瀏覽

**滑鼠滾輪縮放 + 拖曳/平移鏡頭**,讓玩家能巡視隊友在地圖上其他地方的建塔狀況(魔獸爭霸小地圖的概念,不是切到別人的獨立畫面——目前架構本來就是所有玩家共用同一份地圖/`SimulationState`)。

- 現況:地圖已經放大到 22x14 格(880x560px,原本是 16x10),全景一次還看得完,目前還不需要平移。
- 這個功能要有意義,前提是地圖之後做得比視窗大(全螢幕化 + 8 人 co-op 可能需要更大的地圖才有足夠空間讓大家蓋塔)。
- 落點:純 Phaser 鏡頭功能(`camera.zoom`、滾輪/拖曳事件),不用動 `src/sim/`。
- 依賴:Phase 4/5 決定地圖尺寸與是否全螢幕之後才好排進時程。

## 塔 / 放置物升級與擴充

新增可放置物件種類(非攻擊型,例如減速陷阱、資源建築),加上既有塔的升級系統(花金幣把已蓋好的塔升級,提升傷害/範圍/冷卻)。

**✅ 塔升級初版已完成**(`src/sim/towers.ts` 的 `Tower.level`/`upgradeCost`/`MAX_TOWER_LEVEL`,`src/sim/simulation.ts` 的 `upgrade_tower` action):目前只有傷害隨等級線性增加(`TOWER_DEFS[element].damage * level`),範圍/冷卻不受影響,漲價曲線是 `cost * level`,封頂 5 級。這是刻意先求「能玩」的簡化版,之後平衡調整可以再改成非線性曲線,或讓範圍/冷卻也一起變化。

**✅ WC3 式選取面板已完成**:點空地蓋塔;點已經有塔的格子是**選取**(不是直接升級),`src/game/GameScene.ts` 用白色框線標示選到誰,畫面下方 `#towerPanel` 顯示即時屬性(攻擊力/範圍/攻速)跟「升級/賣出/取消選取」三顆按鈕,升級/賣出才是真的送出指令。`src/sim/towers.ts` 的 `describeTower()` 統一算這些顯示用數值,`sellValue()` 跟 `simulation.ts` 的 `applySellTower` 共用同一個公式避免兩邊算法各改各的漂掉。

非攻擊型放置物(陷阱、資源建築)還沒做,維持原本規劃:可以抽一個更廣義的「放置物」介面,`Tower` 只是其中一種實作。

## 元素組合玩法延伸

目前 `src/sim/elements.ts` 只有單一固定克制環(金克木→木克土→土克水→水克火→火克金,`BEATS` 表,強/弱/中三種倍率,無疊加、無組合機制)。

這項是開放式遊戲設計題,先列幾個候選方向當引子,**不在這裡拍板**,需要另外找時間認真討論:

- 雙屬性塔(同時具備兩種元素的判定)
- 鄰近塔屬性共鳴加成(例如兩座水塔相鄰有小幅加成)
- 屬性組合異常狀態(例如水+冰凍、火+灼燒 DOT)
- **特殊技能/狀況觸發隨機走路方向**:例如怪物中了「冰凍」異常狀態後,可能不會乖乖照原路徑走,會亂走/走錯方向。**重要決定性限制**:模擬層(`src/sim/`)絕對不能用 `Math.random()`(每台機器算出的亂數不一樣,連線會直接跑飛),真的要做「隨機」效果,必須用跟 tick/種子綁定、每台機器都能算出同一個結果的偽隨機(例如用 `tick`、`monster.id`、`seed` 幾個值做雜湊,而不是呼叫 `Math.random()`)。目前的路徑系統(`PathPos.pathId` + `segmentIndex`)要支援「中途換路徑/開倒車」需要額外設計,不是現有結構直接就能長出來的功能。

優先度排在其他項目之後,因為玩法設計本身還沒定案,牽動的範圍也最大。

## 地圖與難度:交叉/多路徑地形

**✅ 已完成**:`src/sim/map.ts` 的 `PATHS` 現在是路徑陣列(不再是單一 `PATH_WAYPOINTS`),地圖放大到 22x14 格,`PathPos` 加了 `pathId`,兩條路徑在 `(16,8)` 交叉。同一波怪物用 `j % PATH_COUNT` 輪流分配路徑,逼玩家同時顧兩條線。`src/sim/towers.ts` 的 `findTarget` 改用 `map.ts` 新增的 `remainingDistanceFp`(跨路徑通用的剩餘距離)取代原本只能同路徑比較的 `segmentIndex`。

目前只有 2 條路徑、1 個交叉點,路線本身沒有經過美術/關卡設計,純粹是「架構上先跑得動」的初版——路徑形狀、交叉點位置、要不要 3 條以上路徑,都還可以再調整。

## 關卡提示與特殊波次

**✅ 下一波提示已完成**:HUD 上會顯示下一波的元素(`src/sim/monsters.ts` 的 `upcomingWaveDef`),搭配原本就有的倒數秒數/波次編號。

**✅ 特殊加碼波次已完成**:`WaveDef` 加了 `bonusClearWithinTicks`/`bonusGold`,插入了一個血少速度快的加碼波(第 4 波),限時 10 秒內清光可以拿 100 金幣,清不完也沒有懲罰。判定邏輯在 `src/sim/simulation.ts` 的 `applyBonusWaveRewards`,狀態存在 `SimulationState.bonusAwarded`(每波只判定一次,避免重複發放)。數值是佔位測試用,之後平衡調整可以再改。

## 其他一併記錄的延伸構想

- **✅ 單人模式進度保存已完成**:用 localStorage(`wuxing-keep:bestRecord`)記錄最高波次/是否全破,HUD 上顯示,破紀錄才會覆蓋。
- **✅ 難度選擇已完成(簡化版 New Game+),單人/多人都有**:開局前可選「普通/困難」,困難模式怪物 HP/速度 ×150%、獎勵金幣也 ×150%(`SimulationState.difficultyPercent`,`src/sim/simulation.ts` 的 `scaledSpawn`)。單人在選單直接選;多人由房主在「建立房間」表單選,經 `MatchConfig.difficultyPercent`/`StartMatchMsg.difficultyPercent` 傳給所有人。目前沒有「破關才解鎖困難」的門檻,一開始就能選。
- **✅ 分工的第一版已完成:每人開局選固定的可蓋屬性集合**:`PlayerInfo.elements`(至少 1 個,可複選,單人也適用),`src/sim/simulation.ts` 的 `applyBuildTower` 會擋掉不在允許清單內的建塔指令。**金幣/生命仍然是全員共用一份**(單一 `SimulationState.gold`/`lives`),沒有各自獨立;塔升級也**不分「誰的塔」**,任何玩家都能升級任何人蓋的塔——這兩點還是 Phase 4 尚未定案的部分,要不要進一步做「各自獨立資源」是獨立的下一步決策。
- **✅ 多人房間流程已完成**:選單改成「單人模式/多人連線」頁籤,多人頁籤裡就有建房/加入/房間狀態(不用展開才看得到)。**新增「準備」機制**:每個人(含房主)要在房間狀態按過「✅ 準備」,房主的「開始對局」按鈕才會解鎖(`Room.setReady()`/`SET_READY`/`ROSTER_UPDATED` 訊息,`src/net/room.ts`)。
- **音效/BGM**:五行對應音效點綴,歸在 Phase 5 美術範疇,先記一筆避免遺漏。
