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

**✅ 塔升級初版已完成**(`src/sim/towers.ts` 的 `Tower.level`/`upgradeCost`/`MAX_TOWER_LEVEL`,`src/sim/simulation.ts` 的 `upgrade_tower` action):範圍/冷卻不受等級影響,漲價曲線是 `cost * level`,封頂 5 級。之後平衡調整可以再改成非線性曲線,或讓範圍/冷卻也一起變化。

**✅ 升級分岐路線已完成(參考 WC3 TD 手塔技能)**:1~2 級是共通線性升級(`TOWER_DEFS[element].damage * level`,跟以前一樣),到 `UPGRADE_PATH_LEVEL=3`(`src/sim/towers.ts`)這一級必須二選一、選定後 3~5 級都沿著這條路線走,不能反悔:
- **burst(路線:單體強化)**:傷害是線性公式的 `BURST_DAMAGE_PERCENT=150%`(1.5 倍),沒有範圍效果,適合打單一高血量目標(例如首領波)。
- **splash(路線:範圍擴散)**:傷害維持原本線性(沒有額外加成),但 `tryAttack()` 打中主目標後,`SPLASH_RANGE_FP=700` 定點數距離內的其他怪物也各自挨一下 `SPLASH_DAMAGE_PERCENT=50%` 折扣傷害(用距離平方比較,不用 sqrt,一樣是決定性計算)。適合同時清一群小怪。

實作上 `tryAttack()` 的回傳型別從 `CombatEvent | null` 改成 `CombatEvent[]`(空陣列代表沒打中),`simulation.ts` 的 `applyUpgradeTower` 在**恰好**升到 `UPGRADE_PATH_LEVEL` 那一次呼叫時,`action.params.path` 必須是 `'burst'` 或 `'splash'` 其中之一,不是就整個升級安全忽略(不會扣了錢卻沒定案路線)。`computeChecksum` 的塔序列化把 `upgradePath` 也算進去。UI 上 `main.ts` 的升級按鈕在偵測到「這次升級剛好會到分岐級」時,會先跳選擇彈窗(`showChoiceModal()`)讓玩家選路線,選完才送出真正的 `upgrade_tower` 指令;`#towerPanel` 選到分岐後的塔會多顯示一行目前路線。

**✅ 塔升級造型已完成(2026-07-15,呼應「升級後要更有強化感覺」的需求)**:`scripts/generate-tower-evolution-assets.mjs` 用同一套去背管線,產了 10 張圖(5 屬性 x burst/splash),burst 造型加尖刺/利刃呼應「單體強化」,splash 造型加光環/擴散元素呼應「範圍波及」,视觉上都比基礎造型更高聳/更精緻。`GameScene.ts` 的 `resolveTowerTextureKey()` 做三層備援:選了路線且到分岐級 → 找 evolved 材質 → 找不到退回基礎 `<element>.png` → 都沒有退回幾何圖形;evolved 造型額外放大 1.15 倍加強「變強了」的感覺。

**✅ 隨機英雄選擇已完成(參考 WC3 TD 手塔選擇)**:蓋塔不再是「建塔列直接選屬性」,而是點空地時 `main.ts` 的 `randomTowerOffer()` 從玩家自己允許的屬性清單裡隨機抽最多 3 個(用 `Math.random()`,純本地 UI 用,不影響模擬層決定性——最終選了哪個屬性還是透過正常的 `build_tower` action 決定性送出),跳 `showChoiceModal()` 讓玩家從隨機提供的選項裡挑一個蓋;只允許 1 個屬性時沒有真的選擇可言,直接蓋不跳彈窗。每個屬性額外配了一個角色名(`TOWER_CHARACTER_NAMES`,例如金塔叫「黃金衛士」)顯示在選項按鈕上,加強「英雄選擇」的風味,純顯示用不影響任何數值。建塔列(`#buildBar`)因此簡化成「蓋塔/陷阱/資源建築」三個固定模式,不再逐屬性列出,數字鍵快捷鍵範圍也跟著改回 1~3。

**✅ WC3 式選取面板已完成**:點空地蓋塔;點已經有塔的格子是**選取**(不是直接升級),`src/game/GameScene.ts` 用白色框線標示選到誰,畫面下方 `#towerPanel` 顯示即時屬性(攻擊力/範圍/攻速)跟「升級/賣出/取消選取」三顆按鈕,升級/賣出才是真的送出指令。`src/sim/towers.ts` 的 `describeTower()` 統一算這些顯示用數值,`sellValue()` 跟 `simulation.ts` 的 `applySellTower` 共用同一個公式避免兩邊算法各改各的漂掉。

**✅ 非攻擊型放置物(陷阱、資源建築)初版已完成**:`src/sim/placements.ts` 定義 `Trap`/`ResourceBuilding` 兩個型別,沒有抽象出共用的「放置物」介面(`Tower` 也還是獨立的,沒有跟這兩個共用基底型別)——目前三種放置物的規則差異夠大(塔可升級/可集火策略、陷阱只能蓋路徑格、資源建築定期產被動金幣只給自己),硬抽共用介面不會少寫多少程式碼,先維持三個獨立型別。
- **陷阱**(`TRAP_COST=30`):只能蓋在路徑格(跟塔相反,`isOnPath` 必須是 true),`step()` 裡怪物移動前用 `worldPositionFp` 換算目前格子座標查有沒有陷阱,踩到的話這個 tick 的移動速度打 `TRAP_SLOW_PERCENT=50` 折扣。持續生效(不是觸發一次就消失),沒有計時/冷卻狀態。
- **資源建築**(`RESOURCE_BUILDING_COST=80`):規則跟塔一樣蓋在非路徑格,`ticksSinceLastIncome` 每 `RESOURCE_BUILDING_INTERVAL_TICKS=200`(10 秒)給建造者自己 `RESOURCE_BUILDING_INCOME=15` 金幣——**只給 owner 自己,不是全員均分**(呼應團隊經濟「賣塔限本人」的精神:這是個人投資報酬,不是團隊共同資源)。
- **v1 刻意不支援賣出/升級**:選到陷阱/資源建築的格子目前沒有選取面板,`main.ts` 的 `onTilePlaced` 只是擋掉「點到已佔用格子誤送建造指令」並跳 `#toast` 提示(2026-07-15 從 `GameScene.ts` 靜默擋掉改成這樣,方便玩家分辨是裝飾物純視覺不影響蓋塔、還是這格真的已經有陷阱/資源建築),沒有真的做選取互動。之後要補的話,`towerPanel` 那套 WC3 式選取面板可以參考,但陷阱/資源建築目前沒有等級/集火策略,面板會比塔面板簡單很多(大概只需要一個賣出按鈕)。
- **視覺**:兩者都還沒有正式美術,`GameScene.ts` 的 `drawTrap()`(一排小尖刺)/`drawResourceBuilding()`(金頂小房子)是佔位幾何圖形,跟塔/怪物當初上正式美術前走的是同一套「先求能玩」路線;小地圖上也各配一個小點。
- **✅ 建造 UI 已改成點格子才浮現的選單(拿掉固定佔用畫面底部的建塔列)**:2026-07-15 再改一版,原本「蓋塔/陷阱/資源建築」三個固定模式的 `#buildBar` 整個拿掉了,改成點地圖格子當下才浮現的 `#floatingBuildMenu`(定位在點擊處附近,`#floatingBuildBackdrop` 是透明點擊接收層,點選單以外的地方關掉選單但不會讓畫面變暗)。選單內容依格子是不是路徑格動態決定:路徑格只顯示陷阱,非路徑格顯示隨機英雄選擇(見上面)+ 資源建築。陷阱/資源建築不受玩家選的屬性限制、任何人都能蓋。數字鍵快捷鍵改成「哪個浮動選單開著就選它的第 N 個選項」(建造選單或升級選路線共用同一套邏輯)。金幣不足時的浮動訊息提示(`#toast`,`showToast()`)還在,建造花費現在直接顯示在每個選項按鈕的 sublabel 裡,不再需要獨立的 `#buildCostHint`。

## HUD 精簡檢視模式 + 記分板

**✅ 已完成(2026-07-15)**:
- **精簡檢視模式**:`#hudCompactBtn` 切換 `body.hud-compact` class,拿掉 `.hud-stat` 膠囊底色只留浮動文字(靠文字陰影維持可讀性),偏好存 `localStorage`(`wuxing-keep:hudCompact`),重開遊戲記得上次選的模式。
- **記分板(參考 WC3)**:`#scoreboardBtn` 切換 `#scoreboardOverlay` 常顯/隱藏,不像升級選路線的選擇彈窗那樣擋住地圖,可以邊玩邊看。內容是金幣/目前蓋了幾座塔(即時算,不是累計蓋過幾座)/擊殺數/造成傷害,依傷害由高到低排序。新增 `SimulationState.playerStats`(`Record<PlayerId, {damageDealt, kills}>`),`step()` 的塔攻擊迴圈依 `tower.ownerId` 累加傷害,擊殺數用當下 tick 的 Set 去重(splash 路線或剛好都在冷卻尾聲,同一隻怪被好幾座塔同個 tick 一起打死只算一次,算給第一個打進 0 血以下的塔主人)。這是純顯示統計,跟團隊經濟「賞金全員均分、不追蹤攻擊貢獻」是分開的兩件事,不會互相影響。用 esbuild 打包模擬層直接跑 Node 腳本驗證過傷害累加/擊殺去重(含刻意製造同一 tick 雙塔一起擊殺的邊界案例)。
- **裝飾物太小看不清楚**:`DECOR_SCALE`(只用在 `drawDecor*()` 這幾個程序生成裝飾物函式)調大到 1.6 倍,AI 生圖裝飾物的顯示比例從 0.72 調到 0.95。**裝飾物本來就不影響能不能蓋塔**(純視覺,程式邏輯從頭到尾沒有這個限制),之前有玩家誤以為裝飾物擋住建造,追查後發現是「點到已經有陷阱/資源建築的格子」被靜默忽略沒有任何提示,容易讓人誤會是旁邊的裝飾物擋住了——改成跳 `#toast` 明確提示「這格已經有陷阱/資源建築了」,不再靜默不做事。

## 怪物移動類型(空中/陸地/水路)

**✅ 已完成(2026-07-15,影響戰鬥規則版,不是純視覺差異)**:參考 Bloons TD 的 flying/camo 概念,簡化成互斥三選一的 `Monster.moveType`(`'ground' | 'air' | 'water'`,獨立於 `Element` 五行傷害倍率,兩者互不影響)。

- **戰鬥規則**:`src/sim/towers.ts` 的 `canTargetMoveType(element, moveType)`——土屬性打不到 `'air'`(純地面系搆不到天上)、火屬性打不到 `'water'`(呼應五行水克火),其餘一律打得到。刻意讓每種特殊類型都還有 4/5 屬性打得到,不會有「這個屬性組合完全打不到某種怪」的卡死情況。`陷阱對 'air' 怪無效`(飛在空中,陷阱在地面搆不到)。
- **波次資料**:`WaveDef.moveType` 可選欄位,不填預設 `'ground'`。目前 `WAVES[0]`(水波)是 `'water'`,`WAVES[5]`(金屬波)是 `'air'`,其餘波次維持 `'ground'`。
- **視覺**:`GameScene.ts` 新增 `groundEffectsLayer`(`depth 0.5`,蓋在地板材質上面、塔/怪物圖片下面)——`'water'` 怪出現時,牠所在的整條路徑浮現半透明藍色疊加(`tilesForPath()` 逐條路徑分開算,用 `Math.sin` 做明暗脈動模擬水流,不是真的流動動畫,先求「看得出有水」的簡化版);`'air'` 怪多畫一個地面影子,牠自己的圖片(連同血條/首領框)往上位移一點製造懸浮感——**這個視覺位移不影響戰鬥判定座標**。HUD 的「下一波」提示新增 `icon-wing`/`icon-wave` 兩個自繪 SVG 圖示,空中/水路波次會提前顯示提示,讓玩家知道要準備打得到的屬性。
- **驗證**:核心規則(哪些屬性打不到哪種類型、陷阱對飛行怪無效)用 esbuild 打包模擬層直接跑 Node 腳本驗證過,不是只看 typecheck。
- **已知限制/未來可以做的**:目前只有「打不打得到」這個二元判定,沒有做 Bloons TD 那種更細緻的疊加標記(例如同時是飛行+特殊抗性);水流視覺是固定路徑通殺,沒有依水怪實際走到哪裡做局部/漸進的流動效果;移動速度/路徑本身沒有因為 moveType 而不同(飛行怪視覺上飄浮但實際還是走同一條固定路徑,不是真的抄近路)。

## 元素組合玩法延伸

目前 `src/sim/elements.ts` 只有單一固定克制環(金克木→木克土→土克水→水克火→火克金,`BEATS` 表,強/弱/中三種倍率,無疊加、無組合機制)。

這項原本是開放式遊戲設計題,列了幾個候選方向:雙屬性塔、鄰近塔屬性共鳴加成、屬性組合異常狀態(DOT)、特殊技能觸發隨機走路方向。2026-07-21 拍板先做**雙屬性塔**,其餘候選方向維持未定案、之後有需要再挑。

**✅ 雙屬性塔已完成(2026-07-21)**:`towers.ts` 的 `Tower.secondElement`(可選欄位,不存在就是一般單屬性塔)——蓋塔當下就要指定兩個不同屬性,之後不能改(跟升級分岐路線不同,這不是升級解鎖的,是建塔時的另一種選項)。

- **傷害判定**:`elements.ts` 新增 `bestElementRelation(e1, e2, defender)`,兩個屬性各自對目標算一次 relation,取「比較好」的那個。因為 `BEATS` 是每個屬性只被唯一一個屬性克制的單一循環,目標最多只能克制 e1/e2 其中一個,所以雙屬性塔對任何目標最差就是 neutral,**不會出現「弱」的倍率**——用 Node 腳本窮舉過全部 20 組(e1,e2)× 5 個目標屬性 = 100 種組合驗證過這個不變量成立。這個「沒有致命對位」的一致性用基礎數值折扣去平衡(見下面),不是判定邏輯本身要處理的事。
- **移動類型判定**:`towers.ts` 新增 `canDualTargetMoveType(e1, e2, moveType)`,OR 邏輯(兩個屬性任一個打得到就算打得到)。土屬性打不到空、火屬性打不到水是僅有的兩條限制且不重疊,所以雙屬性塔任兩個屬性組合起來都不會被完全擋死。
- **基礎數值**(`dualTowerStats(e1, e2)`):cost 是兩屬性平均造價的 `DUAL_TOWER_COST_MULTIPLIER_PERCENT`(180%,即 1.8 倍)——比蓋兩座單屬性塔便宜,但比蓋一座貴不少;damage 是兩屬性平均傷害的 `DUAL_TOWER_DAMAGE_PERCENT`(80%)——用「不會出現弱勢傷害」的一致性換取基礎輸出打折;range/cooldown 單純取平均不額外調整。**相生鄰接加成(`hasGeneratingNeighbor`)目前只看主屬性(`tower.element`)**,沒有把 `secondElement` 也算進鄰接判定,先求「能玩」的簡化版,之後如果覺得雙屬性塔在這個機制上被虧待可以再補。
- **建造 UI**:浮動建造選單新增「雙屬性塔」選項(只有玩家自己允許蓋的屬性 ≥ 2 種才會顯示,單一屬性沒有組合可選),點下去跳兩層 `showChoiceModal()` 先選第一種再選第二種屬性(用兩層選單而不是列出所有組合,避免 5 選 2 = 10 種組合塞爆一個選單)。非路徑格選單最多選項數從 7 個增加到 8 個(5 種屬性 + 雙屬性塔 + 資源建築 + 符文圖騰),數字鍵快捷鍵範圍跟著從 1~7 擴到 1~8。
- **視覺**:沒有另外產新美術,`GameScene.ts` 的 `drawSecondElementBadge()` 在塔身右上角畫一個第二屬性顏色的小圓點(用既有的 `ELEMENT_COLORS`),圖片版/幾何圖形備援版共用同一個畫法,每 tick 重畫(跟 `drawOwnerMark()` 同一套模式,不需要額外的 id-keyed GameObject 追蹤)。
- **顯示名稱**:`towerDisplayName(tower)` 雙屬性塔顯示兩個角色名組合(例如「黃金衛士×烈焰武士」),沒有另外設計新角色名。
- **決定性**:`computeChecksum` 的塔序列化把 `secondElement` 也算進去(不存在時用空字串佔位)。用 esbuild 打包 `elements.ts`/`towers.ts` 直接跑 Node 腳本驗證過核心不變量跟造價/傷害折扣公式,用 Playwright 開瀏覽器實測過完整建塔流程(兩層選單、金幣扣款、選取面板顯示、地圖上的第二屬性徽章都正確),無 console error。

**尚未做的延伸**:鄰近塔屬性共鳴加成、屬性組合異常狀態(DOT)、特殊技能觸發隨機走路方向——這三項維持原本未拍板的狀態,優先度未定。

## 地圖與難度:交叉/多路徑地形

**✅ 已完成**:`src/sim/map.ts` 的 `PATHS` 現在是路徑陣列(不再是單一 `PATH_WAYPOINTS`),`PathPos` 加了 `pathId`,兩條路徑交叉一次(地圖放大到 40x24 格之後交叉點在 `(29,14)`,見上面「鏡頭/地圖瀏覽」)。同一波怪物用 `j % PATH_COUNT` 輪流分配路徑,逼玩家同時顧兩條線。`src/sim/towers.ts` 的 `findTarget` 改用 `map.ts` 新增的 `remainingDistanceFp`(跨路徑通用的剩餘距離)取代原本只能同路徑比較的 `segmentIndex`。

目前只有 2 條路徑、1 個交叉點,路線本身沒有經過美術/關卡設計,純粹是「架構上先跑得動」的初版——路徑形狀、交叉點位置、要不要 3 條以上路徑,都還可以再調整。

## 關卡提示與特殊波次

**✅ 下一波提示已完成**:HUD 上會顯示下一波的元素(`src/sim/monsters.ts` 的 `upcomingWaveDef`),搭配原本就有的倒數秒數/波次編號。

**✅ 特殊加碼波次已完成**:`WaveDef` 加了 `bonusClearWithinTicks`/`bonusGold`,插入了一個血少速度快的加碼波(第 4 波),限時 10 秒內清光可以拿 100 金幣,清不完也沒有懲罰。判定邏輯在 `src/sim/simulation.ts` 的 `applyBonusWaveRewards`,狀態存在 `SimulationState.bonusAwarded`(每波只判定一次,避免重複發放)。數值是佔位測試用,之後平衡調整可以再改。

**✅ 無限模式已完成**(2026-07-15,跟固定 8 波並存的另一個選項,見 `CLAUDE.md` `monsters.ts` 段落的完整說明):選單多了「無限模式」核取方塊(單人/多人建房都有),沒有終點,怪物血量/賞金每波線性疊加不封頂,速度也會漲但封頂在基準值 160%,每 5 波一次首領波,約 1/3 機率混 2 種元素,全靠決定性雜湊(`waveHash`)生成、不是 `Math.random()`。唯一結局是撐不住(`lives<=0`),`victory` 永遠不會被設。

**✅ 怪物隻數隨波次增加已完成(2026-07-21)**:`monsters.ts` 的 `generateEndlessWave()` 非首領波隻數從固定 `ENDLESS_WAVE_MONSTER_COUNT` 改成 `ENDLESS_WAVE_MONSTER_COUNT_BASE`(8)每 `ENDLESS_MONSTER_COUNT_GROWTH_INTERVAL`(2)波 +1 隻,封頂 `ENDLESS_WAVE_MONSTER_COUNT_CAP`(16)——封頂值刻意留在 `WAVE_INTERVAL_TICKS / SPAWN_INTERVAL_TICKS = 20` 這個硬限制之下(超過的話最後幾隻的生怪 tick 會落在下一波時間範圍內,被下一波排程蓋掉、永遠不會生出來)。用 esbuild 打包 `monsters.ts` 直接跑 Node 腳本驗證過各波次隻數確實遞增且沒有跨波溢出。

**✅ 首領波多樣化已完成(2026-07-21)**:`generateEndlessWave()` 的首領波不再只有 1 種收尾造型,靠 `waveHash(waveIndex, 3) % 3` 三選一(跟其餘「隨機」邏輯同一套決定性雜湊,不是 `Math.random()`):`single`(原本的單隻厚血慢速)、`group`(三隻一組的首領小隊,單隻血量沒有 single 型誇張但要同時分散顧三個目標)、`swift`(血薄速度快,考驗集火反應速度而不是耐力)。三種造型的總賞金刻意維持同一個量級,不會因為選到哪種而讓團隊經濟跑掉。`upcomingWaveDefEndless()` 多回傳 `bossType`,`main.ts` 的 `renderWaveHud()` 依此在 HUD 下一波預覽顯示「首領」/「首領小隊」/「迅捷首領」三種不同文字,讓玩家提前知道要準備耐力戰、分兵戰還是反應戰。

**這次順手修的既有 bug**:驗證這兩項改動時發現 `main.ts` 的 `renderWaveHud()`/`currentWaveNumberFor()` 一直是拿 `state.tick`(真實 tick)在算「目前第幾波」/「下一波倒數」/「下一波預覽」,沒有用 `simulation.ts` 已經匯出的 `effectiveWaveTick(state)`——導致「呼叫下一波」按鈕點下去之後,HUD 顯示的波次/倒數/下一波預覽完全沒反應,要等真實時間追上才會變(場上實際生怪邏輯本身是對的,因為 `step()` 內部本來就用 `effectiveWaveTick`,只有 HUD 顯示這層算錯)。已改成兩個函式都吃 `effectiveWaveTick(state)`,用 Playwright 開瀏覽器實測按「呼叫下一波」後波次數字會立刻跳,不用等真實時間。

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
- **✅ 房主斷線自動換房主已完成(2026-07-21)**:完整設計脈絡跟實作細節見 `CLAUDE.md` 連線層段落的「房主斷線自動換房主」。摘要:偵測靠應用層心跳(不能等 WebRTC 原生斷線事件,實測可能要等超過 2 分鐘)、選新房主靠所有殘存玩家各自本地算 `pickSuccessorHost`(排除斷線房主後取 slot 最小的,不透過網路協商)、新房主 peer id 用房號+代數尾碼讓大家不用溝通也能算出同一個目標、換房主接手/重連都要接續既有模擬進度而不是重新開局(尤其重連客戶端一定要整份 `RESYNC` state,只跳號對齊 tick 編號會讓 checksum 跑飛,這是實測抓到的真實 bug)。用 Playwright 開多個獨立 `BrowserContext`(各自獨立 PeerJS 身分)驗證過 2 人跟 3 人情境,真的砍掉房主的 context 模擬斷線,而且在同一個 tick 上比對過兩台機器的 checksum 完全一致。已知限制(同時多人斷線、選舉 race condition、換房主當下遺失指令)是刻意接受的取捨,不是這次要解決的問題。
- **✅ 「今日最佳」已完成(不是原本設想的「每日挑戰種子」)**:動工時發現 `seed` 目前只拿來當 `SimulationState.checksum` 的起始值,完全不影響任何生怪/數值(`WAVES`/`getSpawnEventsForTick` 都是純看 `tick` 的固定腳本,`src/sim/` 裡沒有任何隨機性),所以「當天所有人拿同一個 seed」其實跟平常玩沒有任何差別——每天、每個人本來就都是同一張地圖同一組波次。因此把這個點子改成誠實一點的版本:`main.ts` 新增「今日最佳」(`wuxing-keep:dailyBest`,`todayDateString()` 用 `Asia/Taipei` 時區的 `en-CA` locale 算今天日期),每天重新歸零,單純是給「今天想再挑戰一次」的理由,不是真的每天不同的挑戰內容。跟 `bestRecord` 同一時機判定跟顯示。
- **成就/里程碑**:例如「不賣塔通關」「只用單一屬性通關」「全破且沒漏怪」,搭配現有的 `bestRecord` localStorage 機制擴充,UI 上一個小徽章列表。
- **✅ 行動裝置觸控支援已完成(2026-07-21)**:調查後發現「邊緣平移沒有觸控等價操作」這個舊有的擔心已經因為 2026-07-16 的「畫面固定顯示整張地圖」改動而不成立——邊緣平移本來就已經是 no-op(見 `CLAUDE.md` `GameScene.ts` 段落),Phaser 的 `pointerdown` 事件本身也已經同時處理滑鼠跟觸控,不用另外寫觸控專屬的輸入邏輯。真正需要補的是三塊:
  - **手機直式螢幕的黑邊死區(這次意外發現的既有 bug,不是原本規劃要修的)**:`GameScene.ts` 的 `applyViewportZoom()` 縮放地圖時取寬高比較保守的那一邊,窄長比例的畫布(例如手機直式螢幕)另一軸會留下大片空白,而且貼齊左上角不是置中——桌面寬螢幕這個死區窄到不容易注意到,手機上卻會佔掉六成以上畫面。**修法不是在 Phaser 鏡頭這邊(試過用 scrollX/Y 負值置中、也試過 setViewport 縮小置中,這個版本的 Phaser 4.2.1 在 zoom!=1 時鏡頭 bounds/viewport 的內部計算兩種寫法都對不太上,實測會整個蓋掉或算出不對的結果)**,改成從根源避免「視野比地圖大」發生:`index.html` 新增 `#gameCanvasWrap` 包住原本的 `#gameCanvas`,用 `aspect-ratio: 40/24`(對應 `GRID_WIDTH:GRID_HEIGHT`)+ `max-height:100%` + `margin-block:auto` 讓畫布本身永遠跟地圖同比例、在 `#gameScreen` 裡置中——縮放後自然剛好貼合,不需要另外處理任何一軸的留白。（不能直接在 `#gameCanvas` 本身套用寬高比:Phaser 的 `Scale.RESIZE` 模式會把它的 inline style 直接設成 `width:100%;height:100%`,蓋過任何寫在 `<style>` 裡的 CSS,只能在它外面再包一層 Phaser 不會碰的元素。）小地圖(`GameScene.ts` 的 `MINIMAP_SCALE_MAX`/`minimapScale`)原本是固定像素倍率,畫布縮小後會佔掉快一半畫面,改成依畫布尺寸動態縮小(`MINIMAP_MAX_CANVAS_RATIO=0.2`,取寬高比較保守的一邊,跟桌面倍率取較小值),桌面大畫布上維持原本手感不變。
  - **觸控裝置的觸控熱區放大**:`index.html` 新增 `@media (pointer: coarse)` 區塊,只在觸控為主的裝置放大 `.hud-action-btn`(呼叫下一波/緊急補命/記分板/精簡檢視)、塔面板升級賣出按鈕、記分板送禮按鈕等操作按鈕的 padding,滑鼠/軌跡板裝置的精簡尺寸不受影響——這些按鈕平常刻意做得小巧是設計選擇(精簡 HUD),但小於 40px 的熱區在手機上很容易點不準。
  - **手勢干擾**:`<meta name="viewport">` 加上 `maximum-scale=1.0, user-scalable=no`(遊戲畫面已經自動縮放塞滿,不需要瀏覽器層級再縮放一次,雙指/雙擊縮放只會把版面弄亂);`body.game-active` 加上 `touch-action: none`,擋掉 iOS Safari 的橡皮筋捲動/下拉刷新在點地圖時偶發搶走觸控事件的問題(`overflow:hidden` 只能擋 body 捲動,擋不了手勢層級的干擾)。
  - **驗證**:用 Playwright 的 iPhone 13 裝置模擬(觸控事件 + 375 寬直式視窗)實測過完整流程——開單人模式、`touchscreen.tap()` 點地圖開建造選單、點選項蓋塔扣款正確、地圖無死區置中顯示、小地圖縮小到合理比例;另外用普通桌面視窗跑過一輪確認沒有影響原本的桌面體驗(畫布寬高比/小地圖大小/建塔流程都不變)。
