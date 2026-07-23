# 連線層(`src/net/`)—— Host-Relay Star + Lockstep,無自架伺服器

> 這份文件從 `CLAUDE.md` 拆出來,只在要改 `src/net/` 或排查連線問題時才需要讀。

## 基本架構

- 用 **PeerJS**(WebRTC 包裝)靠它免費的公開訊令 broker(`0.peerjs.com`)牽線,不需要自己架任何伺服器,玩家也不需要註冊任何帳號
- ICE:Google STUN + Open Relay 免費 TURN 當 fallback(帳密要換成自己註冊的,不要用教學文件的共用 demo 帳密)
- 房號格式 `gld-<5碼 Crockford Base32>`,房主固定用這個 ID 開房,客戶端用隨機 ID 連出去敲門
- 拓樸是 **Host-relay Star**:所有客戶端只連房主,房主轉發/排序訊息,不做 8 人全連 mesh
- 同步模型是 **Lockstep**(魔獸爭霸同款):只傳玩家「指令」不傳完整狀態。房主收齊每個 tick 的指令、排序後廣播 `TICK` 訊息(含空陣列心跳,不能只在有事發生時才送),每個 peer(含房主自己)都用同一份 `simulation.step()` 依 tick 序算出**完全相同**的結果

## 檔案分工

| 檔案 | 職責 |
|---|---|
| `protocol.ts` | 線路訊息型別 + 防禦性解析(對外來資料不假設格式正確)。`PlayerInfo` 帶 `elements`(開局前選好、整局固定的可蓋屬性集合,至少 1 個)跟 `ready`(準備狀態) |
| `net.ts` | 薄的 PeerJS 包裝,上層不直接碰 PeerJS API |
| `room.ts` | 房號產生/碰撞重試、roster、人數上限(8人)、`setReady()`/`SET_READY`/`ROSTER_UPDATED` 準備流程、房主權威開局(種子分發,`startMatch()` 會擋到所有人都準備才真的送出 `START_MATCH`) |
| `lockstep.ts` | Tick 引擎:`HostLockstepEngine`(固定間隔跑 tick、收指令、廣播)、`ClientLockstepEngine`(依 tick 序緩衝消費);兩者都會把 roster 的 `elements` 轉成 `playerElements` 表餵給 `createInitialState` |

## MVP 階段的刻意取捨

不是遺漏,改動前先確認是否要一併處理:

- ~~房主中途斷線 = 直接結束對局~~ 2026-07-21 起改成**自動換房主**(見下)——僅在自動換房主也失敗時(沒人可以接手、或多次重連都失敗)才會落回結束對局
- 位置/操作採**信任制,不做防作弊驗證**(朋友間連線,不是公開對戰)
- 不支援對局中途加入

## 房主斷線自動換房主(2026-07-21 加的)

對局中房主斷線,殘存玩家各自獨立算出同一個接手人選,不透過網路協商(房主已經斷線,協商也沒有管道)。

### 偵測

實測 PeerJS/WebRTC 原生的 `iceConnectionState` 從 `disconnected` 轉成 `failed`(PeerJS 只有轉成 `failed` 才會觸發 `DataConnection` 的 `close` 事件)在瀏覽器裡可能要等超過 2 分鐘,對這個功能完全不能接受。改成應用層自己的心跳:`room.ts` 的 `Room` 追蹤「多久沒收到房主任何訊息」(對局中 `TICK` 訊息固定每 `tickRateMs`——目前 50ms——就會送一次,是天然的心跳),超過 `HOST_HEARTBEAT_TIMEOUT_MS`(3 秒)就判定房主斷線,不等原生事件(原生事件還是有掛著當備援,只是通常會晚到,`triggerHostConnectionLost()` 內部用 `hostConnectionLostFired` 擋掉兩邊重複觸發)。

### 選新房主

`room.ts` 的 `pickSuccessorHost(roster, deadHostId)` 純函式,排除斷線房主後取 `slot` 最小的(`slot` 是房主端遞增分配、加入房間當下就定案的資歷順序,換房主不會改變它的意義,不用另外設計新欄位)。只要所有殘存玩家手上的 roster 一致就會算出同一個結果——這也是這個機制最大的風險:如果房主斷線前剛好有一則 `ROSTER_UPDATED` 只送到部分玩家,殘存玩家的 roster 快照可能不一致,選出不同的接手人選造成分裂(兩個房主各自往下跑)。這個 race condition 目前**沒有**額外的仲裁機制去解決,朋友間連線、機率低,先接受這個風險。

### 新房主的 peer id

`deriveHostPeerId(roomCode, generation)`——第 1 代(原始房主)就是房號本身,第 2 代以後加尾碼(`-h2`/`-h3`...)。不能沿用原房號:舊房主的 id 斷線後不保證馬上從 PeerJS 公開訊令伺服器釋放,搶用有 race condition 風險。`hostGeneration` 是每個 `Room` 各自本地維護的計數器(不透過網路同步),靠「所有殘存玩家都經歷同一次房主斷線事件」保持一致遞增。

### `Room.attemptRehost()`(客戶端專用)

先把斷線房主從本地 roster 移除、算出接手人選:

- **選中的是自己**:`net.destroy()` 後 `net.open(新id)` 升格成房主(`role` 改成 `'host'`,`myPlayerId` **不變**,因為這是遊戲層的身分,塔的 `ownerId`/金幣的 key 都靠它,只有連線層監聽的 peer id 換了)
- **選中的是別人**:重連過去,帶 `REJOIN` 訊息(不是 `HELLO`——`HELLO` 是全新加入,對局中會被擋,`REJOIN` 帶著原本的 `playerId` 讓新房主重新對應這條新連線,不觸發 `PLAYER_JOINED`)。重連有重試(`REHOST_JOIN_RETRIES=6` 次、間隔 `REHOST_JOIN_RETRY_DELAY_MS=500ms`),因為新房主可能還沒 `open()` 完成
- **都失敗**(沒有其他人存活、或重連多次都失敗):回傳 `'failed'`,呼叫端落回結束對局的既有流程

### `connToPlayer` 對應表(房主端)

連線層 peer id 平常等於遊戲層 `playerId`(`HELLO` 當下用 `conn.peer` 當 `playerId`),但換房主重連後,同一個 `playerId` 會換一條新連線(新的 `conn.peer`)——`handleConnectionClose` 判斷「誰斷線了」時改查這張表,不能再假設兩者相等。

### 接續模擬進度,不能重算

`lockstep.ts` 的 `HostLockstepEngine` 建構子多一個可選的 `resume: LockstepSnapshot`(`{state, tick}`)參數,提供的話直接拿來當起點,不呼叫 `createInitialState()`(那樣會把塔/怪物/金幣全部重置)。`resume` 來自接手前那個玩家自己的 `ClientLockstepEngine.exportForPromotion()`——lockstep 保證所有玩家模擬結果位元級相同,接手瞬間自己手上的 state 就是最新權威狀態,不用跟任何人要資料。

**代價**:舊房主斷線那一刻還在 `inputDelayTicks` 緩衝視窗內、尚未被排進已廣播 `TICK` 的指令會遺失(沒有 ack 機制、也沒人備份),接受這個代價,不是要修的 bug。

### 重連客戶端的整份 state 同步(`RESYNC`)

最早的版本只讓重連客戶端跳號對齊新房主起算的 `tick`,**結果換房主後不同客戶端的 checksum 對不起來**——因為只改 `nextTickToApply` 不換 `state` 內容的話,計數器宣稱「已經算到 tick N 了」但 `state` 其實還停在斷線那一刻,中間差的那幾個 tick(舊房主斷線到新房主起算之間的網路時間差,不同客戶端可能差 1~2 個 tick)永遠補不回來。

修法是新增 `protocol.ts` 的 `ResyncMsg`(帶完整 `SimulationState`,plain object 直接 JSON 序列化,不會遺失資訊),`room.ts` 的 `REJOIN` 處理收到後透過 `RoomHandlers.onRejoinRequest` 同步跟 `main.ts` 要目前的權威快照(`hostEngine.getSnapshot()`)、送回給重連的客戶端;客戶端收到 `RESYNC` 呼叫 `ClientLockstepEngine.applyResync(tick, state)` **整份取代**自己的 `state`,不是只改 `tick`。

### `main.ts` 的接線

`roomHandlers.onHostConnectionLost` 呼叫 `room.attemptRehost()`,依結果三選一:

- `'promoted'` — 建立新的 `HostLockstepEngine`(帶 `resume`)並 `.start()`
- `'reconnected'` — 什麼都不用做,等 `onResync` 觸發
- `'failed'` — 落回既有的 `endMatchAfterUnrecoverableDisconnect()`

`lastMatchConfig` 是對局開始時快取的 `MatchConfig`(`tickRateMs` 等等整場固定不變),換房主時新蓋的 `HostLockstepEngine` 要重用同一份,不是從 `payload` 重新讀(那時候已經沒有 `payload` 可讀了)。全程用 `showToast()` 給進度回饋(「正在嘗試自動換房主...」→「已接手成為新房主」或「正在同步進度...」→「已同步...」),讓玩家知道不是當機。

### 已知限制,不是要修的 bug

同時多人斷線(不只房主一個)、選舉 race condition(見上面 roster 快照不一致的情況)、換房主當下遺失的指令——這些都是「朋友間連線、機率低」可以接受的取捨,不是這次要解決的問題,之後真的常遇到再處理。

## 驗證方式

見 `multiplayer-verify` skill(Playwright 多 `BrowserContext` + checksum 比對)。
