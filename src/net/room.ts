// 房間生命週期:房號產生/碰撞重試、roster 管理、人數上限、鎖房、
// 房主權威的 startMatch()(種子分發、slot 分配)。
// 這一層只認識「房間」的概念;實際怎麼連線是 net.ts 的事,tick 怎麼跑是 lockstep.ts 的事。

import type { DataConnection } from 'peerjs';
import type { Element } from '../sim/elements';
import type { SimulationState } from '../sim/simulation';
import { NetPeer, type IceConfig, type NetError } from './net';
import {
  PROTOCOL_VERSION,
  type Action,
  type CmdMsg,
  type NetMessage,
  type PlayerId,
  type PlayerInfo,
  type RejectReason,
  type StartMatchMsg,
  type TickMsg,
} from './protocol';

const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32,排除易混淆的 I/L/O/U
const ROOM_CODE_LENGTH = 5;
const ROOM_PREFIX = 'gld-';
const MAX_PLAYERS = 8;
const MAX_OPEN_RETRIES = 5;
/** 換房主時,接手的人要先把新 Peer open() 起來,其他人才連得到——重連端多試幾次、
 * 每次間隔這麼久,涵蓋這段時間差(見 Room.attemptRehost())。 */
const REHOST_JOIN_RETRIES = 6;
const REHOST_JOIN_RETRY_DELAY_MS = 500;
/**
 * 客戶端偵測房主是否還活著的心跳逾時(見 Room 的 hostWatchdog)。**不能只靠 PeerJS/WebRTC
 * 原生的斷線事件**——實測 iceConnectionState 從 'disconnected' 轉成 'failed'(PeerJS 只有
 * 轉成 failed 才會真的觸發 DataConnection 的 close 事件)在瀏覽器裡可能要等超過 2 分鐘,
 * 對「自動換房主」這個功能來說完全不能接受(玩家早就以為當機放棄了)。改成應用層自己計時:
 * 對局中房主的 TICK 訊息固定每個 tickRateMs(目前 50ms)就會送一次,是天然的心跳,
 * 只要追蹤「多久沒收到房主任何訊息」,超過這個逾時就直接判定房主已經斷線,不等原生事件
 * (原生斷線事件還是有掛,只是通常會晚到,心跳這邊搶先觸發是正常且預期的情況)。
 */
const HOST_HEARTBEAT_TIMEOUT_MS = 3000;
const HOST_HEARTBEAT_CHECK_INTERVAL_MS = 500;

function randomSuffix(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

function randomRoomCode(): string {
  return ROOM_PREFIX + randomSuffix(ROOM_CODE_LENGTH);
}

function randomClientPeerId(): string {
  return `${ROOM_PREFIX}p-${randomSuffix(8)}`;
}

/**
 * 換房主時新房主要用的 peer id:第 1 代(原始房主)就是房號本身,不用改;第 2 代以後
 * 加上代數尾碼(`-h2`/`-h3`...)——舊房主的 id 斷線後不保證馬上從 PeerJS 公開訊令伺服器
 * 釋放,搶用原房號有 race condition 風險,乾脆換一個新 id。所有殘存玩家各自本地算這個
 * 函式,不需要透過網路協商(房主已經斷線,協商也沒有管道),只要大家看到的 roomCode/
 * hostGeneration 一致就會算出同一個結果——見 Room.attemptRehost() 的呼叫方式。
 */
function deriveHostPeerId(roomCode: string, generation: number): string {
  return generation <= 1 ? roomCode : `${roomCode}-h${generation}`;
}

/**
 * 換房主:選出接手的人。純函式,只要所有殘存玩家手上的 roster 一致就會算出同一個結果——
 * 取排除掉斷線房主之後、slot 最小的那個(slot 是房主端遞增分配、加入房間當下就定案的
 * 資歷順序,不會因為換房主而改變意義,不用另外設計一個新欄位)。沒有其他人存活就回傳
 * null(只剩自己一人,沒有房間可換,呼叫端要當作換房主失敗處理)。
 */
export function pickSuccessorHost(roster: readonly PlayerInfo[], deadHostId: PlayerId): PlayerInfo | null {
  const survivors = roster.filter((p) => p.playerId !== deadHostId);
  if (survivors.length === 0) return null;
  return survivors.reduce((min, p) => (p.slot < min.slot ? p : min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RoomRole = 'host' | 'client';

export interface MatchConfig {
  tickRateMs: number;
  inputDelayTicks: number;
  countdownMs: number;
  difficultyPercent: number;
  endlessMode: boolean;
  individualLivesMode: boolean;
  /** 這場對局用哪張地圖(見 sim/map.ts 的 MAP_DEFS),房主在建房時選,整場固定不變。 */
  mapId: string;
}

export interface RoomHandlers {
  onRosterChanged?: (roster: PlayerInfo[]) => void;
  onMatchStarted?: (payload: StartMatchMsg) => void;
  onRejected?: (reason: RejectReason) => void;
  /** 房間因故結束(Lobby 階段房主離線、或對局中換房主也失敗——沒人可以接手、或多次重連都失敗) */
  onRoomEnded?: (reasonText: string) => void;
  /**
   * 對局進行中偵測到跟房主的連線斷了——不是直接結束對局,呼叫端(main.ts)應該呼叫
   * attemptRehost() 嘗試自動換房主,失敗才落回 onRoomEnded()。Lobby 階段(還沒開始對局)
   * 斷線維持原本行為,直接走 onRoomEnded(),不會觸發這個 handler(換房主只在對局中才有意義)。
   */
  onHostConnectionLost?: () => void;
  /** 房主端:收到客戶端送來的指令,交給 lockstep 處理 */
  onCommand?: (cmd: CmdMsg) => void;
  /** 客戶端:收到房主廣播的 tick,交給 lockstep 處理 */
  onTick?: (tick: TickMsg) => void;
  /**
   * 新房主端:收到既有玩家的 REJOIN,同步回呼叫端(main.ts)要目前的權威模擬快照
   * (見 lockstep.ts 的 HostLockstepEngine.getSnapshot())——回傳 null 代表還沒有可用的快照
   * (理論上不該發生,因為能收到 REJOIN 代表自己已經是跑起來的房主),整個 REJOIN 安全忽略。
   */
  onRejoinRequest?: (playerId: PlayerId) => { state: SimulationState; tick: number } | null;
  /** 換房主重連後的客戶端:收到新房主回應的完整快照,交給 lockstep 整份取代自己的 state。 */
  onResync?: (tick: number, state: SimulationState) => void;
}

export class Room {
  private net: NetPeer;
  private roster: PlayerInfo[] = [];
  private myPlayerId: PlayerId = '';
  private matchStarted = false;
  private nextSlot = 0;
  private hostConn: DataConnection | null = null; // 客戶端專用:跟房主的唯一連線
  /** 房號本身(不含代數尾碼),換房主時用來算下一代房主的 peer id,見 deriveHostPeerId()。 */
  private roomCode = '';
  /** 第幾代房主,1 = 原始房主。每次換房主(不管是自己接手還是重連新房主)都要 +1,
   * 所有殘存玩家各自本地遞增,靠「大家都經歷同一次房主斷線事件」保持一致,不用網路同步。 */
  private hostGeneration = 1;
  /** 房主端專用:連線層 peer id → 遊戲層 playerId 的對應。兩者平常相等(HELLO 當下用
   * conn.peer 當 playerId),但換房主重連後,同一個 playerId 可能換了一條新連線(新的
   * conn.peer),要靠這張表才能正確對應,不能再假設兩者相等——見 REJOIN 訊息處理。 */
  private connToPlayer = new Map<string, PlayerId>();
  /** 客戶端專用:上次收到房主任何訊息的時間戳,心跳逾時偵測用,見 HOST_HEARTBEAT_TIMEOUT_MS。 */
  private lastHostMessageAt = 0;
  private hostWatchdog: ReturnType<typeof setInterval> | null = null;
  /** 避免心跳逾時判定跟原生斷線事件(可能晚到)重複觸發同一次「房主斷線」處理。 */
  private hostConnectionLostFired = false;

  private constructor(
    private handlers: RoomHandlers,
    iceConfig: IceConfig,
    private role: RoomRole,
  ) {
    this.net = new NetPeer(
      {
        onIncomingConnection: () => {
          // 先不動 roster,等 handleMessage 收到 HELLO 驗證過再加入
        },
        onMessage: (conn, msg) => this.handleMessage(conn, msg),
        onConnectionClose: (conn) => this.handleConnectionClose(conn),
        onFatalError: () => {
          if (this.role === 'client') this.handlers.onRoomEnded?.('連線中斷');
        },
      },
      iceConfig,
    );
  }

  /** 房主開房。房號被佔用(unavailable-id)會自動換碼重試,其他錯誤直接拋出。 */
  static async host(
    hostName: string,
    elements: Element[],
    iceConfig: IceConfig,
    handlers: RoomHandlers,
  ): Promise<{ room: Room; roomCode: string }> {
    let lastErr: unknown = new Error('無法建立房間:多次嘗試房號都被佔用');
    for (let attempt = 0; attempt < MAX_OPEN_RETRIES; attempt++) {
      const code = randomRoomCode();
      const room = new Room(handlers, iceConfig, 'host');
      try {
        const peerId = await room.net.open(code);
        room.myPlayerId = peerId;
        room.roomCode = code;
        room.roster = [{ playerId: peerId, slot: 0, name: hostName, elements, ready: false }];
        room.nextSlot = 1;
        handlers.onRosterChanged?.(room.roster);
        return { room, roomCode: code };
      } catch (err) {
        room.net.destroy();
        const netErr = err as NetError;
        if (netErr.type !== 'id-taken') throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** 客戶端加入房間。roomCode 需為房主分享出來的完整房號(含 gld- 前綴)。 */
  static async join(
    roomCode: string,
    myName: string,
    elements: Element[],
    iceConfig: IceConfig,
    handlers: RoomHandlers,
  ): Promise<Room> {
    const room = new Room(handlers, iceConfig, 'client');
    room.roomCode = roomCode;
    const conn = await room.net.join(randomClientPeerId(), roomCode);
    room.hostConn = conn;
    room.net.send(conn, { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, name: myName, elements });
    return room;
  }

  getRoster(): PlayerInfo[] {
    return this.roster;
  }

  getMyPlayerId(): PlayerId {
    return this.myPlayerId;
  }

  getRole(): RoomRole {
    return this.role;
  }

  /** 切換「我」的準備狀態。房主直接改本地 roster 後廣播;客戶端送給房主裁決。 */
  setReady(ready: boolean): void {
    if (this.role === 'host') {
      this.roster = this.roster.map((p) => (p.playerId === this.myPlayerId ? { ...p, ready } : p));
      this.net.broadcast({ type: 'ROSTER_UPDATED', roster: this.roster });
      this.handlers.onRosterChanged?.(this.roster);
    } else {
      if (!this.hostConn) throw new Error('尚未連上房主');
      this.net.send(this.hostConn, { type: 'SET_READY', ready });
    }
  }

  /** 房主專用:鎖房、產生種子、廣播 START_MATCH。所有人都準備好之前不會真的開始。 */
  startMatch(config: MatchConfig): void {
    if (this.role !== 'host') throw new Error('只有房主可以開始對局');
    if (this.matchStarted) return;
    if (!this.roster.every((p) => p.ready)) return; // 還有人沒準備好,安全忽略
    this.matchStarted = true;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const payload: StartMatchMsg = {
      type: 'START_MATCH',
      seed,
      roster: this.roster,
      tickRateMs: config.tickRateMs,
      inputDelayTicks: config.inputDelayTicks,
      countdownMs: config.countdownMs,
      difficultyPercent: config.difficultyPercent,
      endlessMode: config.endlessMode,
      individualLivesMode: config.individualLivesMode,
      mapId: config.mapId,
    };
    this.net.broadcast(payload);
    this.handlers.onMatchStarted?.(payload);
  }

  /** 客戶端專用:把操作送給房主排序。 */
  sendCommand(action: Action, localSeq: number): void {
    if (this.role !== 'client' || !this.hostConn) {
      throw new Error('只有客戶端可以送出指令給房主');
    }
    this.net.send(this.hostConn, {
      type: 'CMD',
      playerId: this.myPlayerId,
      localSeq,
      action,
    });
  }

  /** 房主專用:把排序好的 tick 廣播給所有人(lockstep.ts 呼叫)。 */
  broadcastTick(tick: TickMsg): void {
    if (this.role !== 'host') throw new Error('只有房主可以廣播 tick');
    this.net.broadcast(tick);
  }

  destroy(): void {
    this.stopHostWatchdog();
    this.net.destroy();
  }

  /** 對局中,客戶端定期檢查多久沒收到房主任何訊息,超過門檻就判定房主斷線——見 HOST_HEARTBEAT_TIMEOUT_MS 的說明。 */
  private startHostWatchdog(): void {
    this.lastHostMessageAt = Date.now();
    this.hostConnectionLostFired = false;
    this.stopHostWatchdog();
    this.hostWatchdog = setInterval(() => {
      if (Date.now() - this.lastHostMessageAt > HOST_HEARTBEAT_TIMEOUT_MS) {
        this.stopHostWatchdog();
        this.triggerHostConnectionLost();
      }
    }, HOST_HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private stopHostWatchdog(): void {
    if (this.hostWatchdog) clearInterval(this.hostWatchdog);
    this.hostWatchdog = null;
  }

  /**
   * 房主斷線的統一入口,不管是心跳逾時先發現、還是原生斷線事件後來才到,只會真的處理一次
   * (`hostConnectionLostFired` 擋掉重複觸發)。對局中走 onHostConnectionLost(嘗試換房主),
   * 還在 Lobby 就斷線維持原本行為直接結束。
   */
  private triggerHostConnectionLost(): void {
    if (this.hostConnectionLostFired) return;
    this.hostConnectionLostFired = true;
    if (this.matchStarted) {
      this.handlers.onHostConnectionLost?.();
    } else {
      this.handlers.onRoomEnded?.('房主已離線');
    }
  }

  private handleMessage(conn: DataConnection, msg: NetMessage): void {
    if (this.role === 'host') {
      this.handleHostMessage(conn, msg);
    } else {
      this.handleClientMessage(msg);
    }
  }

  private handleHostMessage(conn: DataConnection, msg: NetMessage): void {
    switch (msg.type) {
      case 'HELLO': {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.net.send(conn, { type: 'REJECT', reason: 'version_mismatch' });
          this.net.closeConnection(conn.peer);
          return;
        }
        if (this.matchStarted) {
          this.net.send(conn, { type: 'REJECT', reason: 'match_in_progress' });
          this.net.closeConnection(conn.peer);
          return;
        }
        if (this.roster.length >= MAX_PLAYERS) {
          this.net.send(conn, { type: 'REJECT', reason: 'room_full' });
          this.net.closeConnection(conn.peer);
          return;
        }
        const player: PlayerInfo = {
          playerId: conn.peer,
          slot: this.nextSlot++,
          name: msg.name,
          elements: msg.elements,
          ready: false,
        };
        this.roster = [...this.roster, player];
        this.connToPlayer.set(conn.peer, conn.peer); // 初次加入,連線層 id 跟遊戲層 playerId 相等
        this.net.send(conn, { type: 'WELCOME', youAre: conn.peer, roster: this.roster });
        this.net.broadcast({ type: 'PLAYER_JOINED', player }, conn.peer);
        this.handlers.onRosterChanged?.(this.roster);
        return;
      }
      case 'REJOIN': {
        // 換房主後的重連,不是新玩家加入——只重新對應連線,不動 roster、不廣播 PLAYER_JOINED
        // (roster 內容沒有變,其他人不用知道這件事)。
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.net.send(conn, { type: 'REJECT', reason: 'version_mismatch' });
          this.net.closeConnection(conn.peer);
          return;
        }
        if (!this.roster.some((p) => p.playerId === msg.playerId)) {
          this.net.send(conn, { type: 'REJECT', reason: 'unknown_player' });
          this.net.closeConnection(conn.peer);
          return;
        }
        this.connToPlayer.set(conn.peer, msg.playerId);
        const snapshot = this.handlers.onRejoinRequest?.(msg.playerId);
        if (snapshot) {
          this.net.send(conn, { type: 'RESYNC', tick: snapshot.tick, state: snapshot.state });
        }
        return;
      }
      case 'SET_READY': {
        const idx = this.roster.findIndex((p) => p.playerId === conn.peer);
        if (idx === -1) return;
        this.roster = this.roster.map((p, i) => (i === idx ? { ...p, ready: msg.ready } : p));
        this.net.broadcast({ type: 'ROSTER_UPDATED', roster: this.roster });
        this.handlers.onRosterChanged?.(this.roster);
        return;
      }
      case 'CMD':
        this.handlers.onCommand?.(msg);
        return;
      default:
        return; // 房主不處理 WELCOME/TICK 這類只該由房主自己送出的訊息
    }
  }

  private handleClientMessage(msg: NetMessage): void {
    // 心跳:房主傳來的任何訊息都算「還活著」,不是只有 TICK——START_MATCH 之前 TICK 還沒開始送,
    // 但這個時間點 watchdog 也還沒啟動(見 START_MATCH case),不影響邏輯。
    this.lastHostMessageAt = Date.now();
    switch (msg.type) {
      case 'WELCOME':
        this.myPlayerId = msg.youAre;
        this.roster = msg.roster;
        this.handlers.onRosterChanged?.(this.roster);
        return;
      case 'PLAYER_JOINED':
        this.roster = [...this.roster, msg.player];
        this.handlers.onRosterChanged?.(this.roster);
        return;
      case 'PLAYER_LEFT':
        this.roster = this.roster.filter((p) => p.playerId !== msg.playerId);
        this.handlers.onRosterChanged?.(this.roster);
        return;
      case 'ROSTER_UPDATED':
        this.roster = msg.roster;
        this.handlers.onRosterChanged?.(this.roster);
        return;
      case 'REJECT':
        this.handlers.onRejected?.(msg.reason);
        return;
      case 'START_MATCH':
        this.matchStarted = true;
        this.startHostWatchdog();
        this.handlers.onMatchStarted?.(msg);
        return;
      case 'TICK':
        this.handlers.onTick?.(msg);
        return;
      case 'RESYNC':
        this.handlers.onResync?.(msg.tick, msg.state);
        return;
      default:
        return;
    }
  }

  private handleConnectionClose(conn: DataConnection): void {
    if (this.role === 'host') {
      // 換房主重連後,同一個 playerId 可能換了一條新連線(conn.peer 不等於 playerId 了),
      // 要透過 connToPlayer 對應回去,不能再直接假設兩者相等(見 REJOIN 訊息處理)。
      const playerId = this.connToPlayer.get(conn.peer) ?? conn.peer;
      const left = this.roster.find((p) => p.playerId === playerId);
      if (left) {
        this.roster = this.roster.filter((p) => p.playerId !== playerId);
        this.connToPlayer.delete(conn.peer);
        this.net.broadcast({ type: 'PLAYER_LEFT', playerId });
        this.handlers.onRosterChanged?.(this.roster);
      }
    } else {
      // 客戶端只跟房主一條連線,斷了就等同房主離線——通常心跳(HOST_HEARTBEAT_TIMEOUT_MS)
      // 會搶先偵測到,這個原生斷線事件多半是晚到的第二次觸發,triggerHostConnectionLost()
      // 內部會擋掉重複處理。
      this.stopHostWatchdog();
      this.triggerHostConnectionLost();
    }
  }

  /**
   * 房主斷線自動換房主:所有殘存玩家各自呼叫,獨立算出同一個結果(見 pickSuccessorHost()/
   * deriveHostPeerId() 的說明——不需要透過網路協商,協商也沒有管道,舊房主已經斷線)。
   * - 選中的是「我」:我方 net 重新 open() 一個新 peer id,升格成房主,回傳 'promoted'。
   * - 選中的是別人:嘗試連到新房主(有重試,新房主可能還沒 open() 完成),回傳 'reconnected'。
   * - 沒有其他人存活(只剩自己):回傳 'failed',呼叫端(main.ts)應該落回結束對局的既有流程。
   * - 重連新房主多次都失敗(新房主也掛了、或網路問題):同樣回傳 'failed'。
   * 呼叫前會先把斷線的舊房主從本地 roster 移除——這一步每個殘存玩家各自做,結果一致,
   * 不需要廣播同步。
   */
  async attemptRehost(): Promise<'promoted' | 'reconnected' | 'failed'> {
    if (this.role !== 'client') return 'failed'; // 房主自己斷線是別人的事,不會走到這裡
    const deadHostId = this.hostConn?.peer ?? '';
    this.roster = this.roster.filter((p) => p.playerId !== deadHostId);
    this.handlers.onRosterChanged?.(this.roster);

    const successor = pickSuccessorHost(this.roster, deadHostId);
    if (!successor) return 'failed';

    this.hostGeneration += 1;
    const newHostPeerId = deriveHostPeerId(this.roomCode, this.hostGeneration);
    this.net.destroy();
    this.hostConn = null;

    if (successor.playerId === this.myPlayerId) {
      try {
        await this.net.open(newHostPeerId);
      } catch {
        return 'failed'; // 新房號被卡住(理論上不該發生,同一代不會有人搶)或網路本身有問題
      }
      this.role = 'host';
      this.connToPlayer.clear();
      return 'promoted';
    }

    for (let attempt = 0; attempt < REHOST_JOIN_RETRIES; attempt++) {
      try {
        const conn = await this.net.join(randomClientPeerId(), newHostPeerId);
        this.hostConn = conn;
        this.net.send(conn, { type: 'REJOIN', protocolVersion: PROTOCOL_VERSION, playerId: this.myPlayerId });
        this.startHostWatchdog(); // 繼續當客戶端,重新開始追蹤新房主的心跳(以防新房主之後也掛了)
        return 'reconnected';
      } catch {
        this.net.destroy(); // 這次嘗試留下的半成品 Peer 清掉,下一輪重新開一個乾淨的
        await sleep(REHOST_JOIN_RETRY_DELAY_MS);
      }
    }
    return 'failed';
  }
}
