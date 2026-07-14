// Phase 3 連線協定的純資料定義。這個檔案不碰 PeerJS、不碰模擬邏輯,
// 只負責「線路上會出現哪些訊息長什麼樣子」以及「怎麼安全地解析外來資料」。

export const PROTOCOL_VERSION = 1;

export type PlayerId = string;

export interface PlayerInfo {
  playerId: PlayerId;
  slot: number;
  name: string;
}

export interface Action {
  kind: string;
  params: Record<string, unknown>;
}

export interface TimedCommand {
  playerId: PlayerId;
  action: Action;
}

export type RejectReason = 'room_full' | 'match_in_progress' | 'version_mismatch';

export interface HelloMsg {
  type: 'HELLO';
  protocolVersion: number;
  name: string;
}

export interface RejectMsg {
  type: 'REJECT';
  reason: RejectReason;
}

export interface WelcomeMsg {
  type: 'WELCOME';
  youAre: PlayerId;
  roster: PlayerInfo[];
}

export interface PlayerJoinedMsg {
  type: 'PLAYER_JOINED';
  player: PlayerInfo;
}

export interface PlayerLeftMsg {
  type: 'PLAYER_LEFT';
  playerId: PlayerId;
}

export interface StartMatchMsg {
  type: 'START_MATCH';
  seed: number;
  roster: PlayerInfo[];
  tickRateMs: number;
  inputDelayTicks: number;
  countdownMs: number;
}

export interface CmdMsg {
  type: 'CMD';
  playerId: PlayerId;
  localSeq: number;
  action: Action;
}

export interface TickMsg {
  type: 'TICK';
  tick: number;
  commands: TimedCommand[];
}

export interface PingMsg {
  type: 'PING';
  sentAt: number;
}

export interface PongMsg {
  type: 'PONG';
  sentAt: number;
}

export interface ChecksumMsg {
  type: 'CHECKSUM';
  tick: number;
  playerId: PlayerId;
  hash: string;
}

export type NetMessage =
  | HelloMsg
  | RejectMsg
  | WelcomeMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | StartMatchMsg
  | CmdMsg
  | TickMsg
  | PingMsg
  | PongMsg
  | ChecksumMsg;

export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

function isPlayerInfo(v: unknown): v is PlayerInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.playerId === 'string' &&
    typeof o.slot === 'number' &&
    typeof o.name === 'string'
  );
}

function isPlayerInfoArray(v: unknown): v is PlayerInfo[] {
  return Array.isArray(v) && v.every(isPlayerInfo);
}

function isAction(v: unknown): v is Action {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === 'string' && typeof o.params === 'object' && o.params !== null;
}

function isTimedCommandArray(v: unknown): v is TimedCommand[] {
  if (!Array.isArray(v)) return false;
  return v.every((c) => {
    if (typeof c !== 'object' || c === null) return false;
    const o = c as Record<string, unknown>;
    return typeof o.playerId === 'string' && isAction(o.action);
  });
}

/**
 * 解析外來(對面 peer 送來的)資料。訊息可能來自版本不符、格式錯誤,
 * 甚至是不相干的 app 誤連進來(房號是公開 broker 上的共用命名空間),
 * 所以每個欄位都要驗證型別,不能假設 JSON.parse 出來的東西長得跟預期一樣。
 */
export function parse(raw: unknown): NetMessage | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;

  switch (o.type) {
    case 'HELLO':
      if (typeof o.protocolVersion === 'number' && typeof o.name === 'string') {
        return { type: 'HELLO', protocolVersion: o.protocolVersion, name: o.name };
      }
      return null;

    case 'REJECT':
      if (
        o.reason === 'room_full' ||
        o.reason === 'match_in_progress' ||
        o.reason === 'version_mismatch'
      ) {
        return { type: 'REJECT', reason: o.reason };
      }
      return null;

    case 'WELCOME':
      if (typeof o.youAre === 'string' && isPlayerInfoArray(o.roster)) {
        return { type: 'WELCOME', youAre: o.youAre, roster: o.roster };
      }
      return null;

    case 'PLAYER_JOINED':
      if (isPlayerInfo(o.player)) {
        return { type: 'PLAYER_JOINED', player: o.player };
      }
      return null;

    case 'PLAYER_LEFT':
      if (typeof o.playerId === 'string') {
        return { type: 'PLAYER_LEFT', playerId: o.playerId };
      }
      return null;

    case 'START_MATCH':
      if (
        typeof o.seed === 'number' &&
        isPlayerInfoArray(o.roster) &&
        typeof o.tickRateMs === 'number' &&
        typeof o.inputDelayTicks === 'number' &&
        typeof o.countdownMs === 'number'
      ) {
        return {
          type: 'START_MATCH',
          seed: o.seed,
          roster: o.roster,
          tickRateMs: o.tickRateMs,
          inputDelayTicks: o.inputDelayTicks,
          countdownMs: o.countdownMs,
        };
      }
      return null;

    case 'CMD':
      if (
        typeof o.playerId === 'string' &&
        typeof o.localSeq === 'number' &&
        isAction(o.action)
      ) {
        return { type: 'CMD', playerId: o.playerId, localSeq: o.localSeq, action: o.action };
      }
      return null;

    case 'TICK':
      if (typeof o.tick === 'number' && isTimedCommandArray(o.commands)) {
        return { type: 'TICK', tick: o.tick, commands: o.commands };
      }
      return null;

    case 'PING':
      if (typeof o.sentAt === 'number') {
        return { type: 'PING', sentAt: o.sentAt };
      }
      return null;

    case 'PONG':
      if (typeof o.sentAt === 'number') {
        return { type: 'PONG', sentAt: o.sentAt };
      }
      return null;

    case 'CHECKSUM':
      if (
        typeof o.tick === 'number' &&
        typeof o.playerId === 'string' &&
        typeof o.hash === 'string'
      ) {
        return { type: 'CHECKSUM', tick: o.tick, playerId: o.playerId, hash: o.hash };
      }
      return null;

    default:
      return null;
  }
}
