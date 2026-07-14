// 房間生命週期:房號產生/碰撞重試、roster 管理、人數上限、鎖房、
// 房主權威的 startMatch()(種子分發、slot 分配)。
// 這一層只認識「房間」的概念;實際怎麼連線是 net.ts 的事,tick 怎麼跑是 lockstep.ts 的事。

import type { DataConnection } from 'peerjs';
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

export type RoomRole = 'host' | 'client';

export interface MatchConfig {
  tickRateMs: number;
  inputDelayTicks: number;
  countdownMs: number;
}

export interface RoomHandlers {
  onRosterChanged?: (roster: PlayerInfo[]) => void;
  onMatchStarted?: (payload: StartMatchMsg) => void;
  onRejected?: (reason: RejectReason) => void;
  /** 房間因故結束(目前 MVP 只有一種情境:房主斷線/客戶端與房主的連線斷掉) */
  onRoomEnded?: (reasonText: string) => void;
  /** 房主端:收到客戶端送來的指令,交給 lockstep 處理 */
  onCommand?: (cmd: CmdMsg) => void;
  /** 客戶端:收到房主廣播的 tick,交給 lockstep 處理 */
  onTick?: (tick: TickMsg) => void;
}

export class Room {
  private net: NetPeer;
  private roster: PlayerInfo[] = [];
  private myPlayerId: PlayerId = '';
  private matchStarted = false;
  private nextSlot = 0;
  private hostConn: DataConnection | null = null; // 客戶端專用:跟房主的唯一連線

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
        room.roster = [{ playerId: peerId, slot: 0, name: hostName }];
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
    iceConfig: IceConfig,
    handlers: RoomHandlers,
  ): Promise<Room> {
    const room = new Room(handlers, iceConfig, 'client');
    const conn = await room.net.join(randomClientPeerId(), roomCode);
    room.hostConn = conn;
    room.net.send(conn, { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, name: myName });
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

  /** 房主專用:鎖房、產生種子、廣播 START_MATCH。 */
  startMatch(config: MatchConfig): void {
    if (this.role !== 'host') throw new Error('只有房主可以開始對局');
    if (this.matchStarted) return;
    this.matchStarted = true;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const payload: StartMatchMsg = {
      type: 'START_MATCH',
      seed,
      roster: this.roster,
      tickRateMs: config.tickRateMs,
      inputDelayTicks: config.inputDelayTicks,
      countdownMs: config.countdownMs,
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
    this.net.destroy();
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
        const player: PlayerInfo = { playerId: conn.peer, slot: this.nextSlot++, name: msg.name };
        this.roster = [...this.roster, player];
        this.net.send(conn, { type: 'WELCOME', youAre: conn.peer, roster: this.roster });
        this.net.broadcast({ type: 'PLAYER_JOINED', player }, conn.peer);
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
      case 'REJECT':
        this.handlers.onRejected?.(msg.reason);
        return;
      case 'START_MATCH':
        this.matchStarted = true;
        this.handlers.onMatchStarted?.(msg);
        return;
      case 'TICK':
        this.handlers.onTick?.(msg);
        return;
      default:
        return;
    }
  }

  private handleConnectionClose(conn: DataConnection): void {
    if (this.role === 'host') {
      const left = this.roster.find((p) => p.playerId === conn.peer);
      if (left) {
        this.roster = this.roster.filter((p) => p.playerId !== conn.peer);
        this.net.broadcast({ type: 'PLAYER_LEFT', playerId: conn.peer });
        this.handlers.onRosterChanged?.(this.roster);
      }
    } else {
      // 客戶端只跟房主一條連線,斷了就等同房主離線 —— MVP 決定:直接結束對局,不做自動換房主
      this.handlers.onRoomEnded?.('房主已離線');
    }
  }
}
