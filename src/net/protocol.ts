// Phase 3 連線協定的純資料定義。這個檔案不碰 PeerJS、不碰模擬邏輯,
// 只負責「線路上會出現哪些訊息長什麼樣子」以及「怎麼安全地解析外來資料」。

import { isElement, type Element } from '../sim/elements';
import { isMapId } from '../sim/map';
import type { SimulationState } from '../sim/simulation';

export const PROTOCOL_VERSION = 1;

/**
 * 應用版本識別(build 時由 vite.config.ts 注入 git commit hash)。跟 PROTOCOL_VERSION
 * 是兩層不同的檢查:PROTOCOL_VERSION 管「訊息格式」,APP_VERSION 管「模擬規則」——
 * lockstep 要求所有 peer 跑同一份 step(),src/sim/ 隨便一改新舊 bundle 就會分岔跑飛,
 * 但訊息格式往往沒變。2026-07-23 排查「加入者不能玩」確認過:GitHub Pages 快取讓兩人
 * 拿到不同版本 bundle 是真實會發生的情境,必須在 HELLO/REJOIN 就明確拒絕,不能放進來
 * 靜默分裂。verify 腳本用 esbuild 打包(沒有 vite 的 define)拿不到這個值,退回 'dev'。
 */
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export type PlayerId = string;

export interface PlayerInfo {
  playerId: PlayerId;
  slot: number;
  name: string;
  /** 這個玩家開局前選好、之後整局只能蓋這些屬性的塔(至少 1 個)。 */
  elements: Element[];
  /** 房主要等所有人都準備好才能開始對局。 */
  ready: boolean;
}

export interface Action {
  kind: string;
  params: Record<string, unknown>;
}

export interface TimedCommand {
  playerId: PlayerId;
  action: Action;
}

export type RejectReason = 'room_full' | 'match_in_progress' | 'version_mismatch' | 'unknown_player';

export interface HelloMsg {
  type: 'HELLO';
  protocolVersion: number;
  /** build 版本(git hash),跟房主不同就會被 REJECT(version_mismatch)——見 APP_VERSION。 */
  appVersion: string;
  name: string;
  elements: Element[];
}

export interface RejectMsg {
  type: 'REJECT';
  reason: RejectReason;
}

/**
 * 房主斷線自動換房主(見 room.ts 的 attemptRehost()):對局中重新連上新房主時送這個,
 * 不是 HELLO——HELLO 是「全新加入房間」,REJOIN 是「我是已經在 roster 裡的既有玩家,
 * 只是連線層斷了重新接上」,帶著原本的 playerId 讓新房主重新對應這條新連線,不會被
 * 誤判成新玩家、也不會影響 roster(不觸發 PLAYER_JOINED)。
 */
export interface RejoinMsg {
  type: 'REJOIN';
  protocolVersion: number;
  /** 同 HelloMsg.appVersion——換房主重連也要驗,新房主可能剛好是不同版本。 */
  appVersion: string;
  playerId: PlayerId;
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
  difficultyPercent: number;
  /** 無限模式:沒有固定波次終點,難度隨波次持續往上疊,直到守不住為止。 */
  endlessMode: boolean;
  /** 個人生命模式:每條路徑各自的生命池子,漏怪只扣該路徑的血,不影響其他路徑。 */
  individualLivesMode: boolean;
  /** 這場對局用哪張地圖(見 sim/map.ts 的 MAP_DEFS)。 */
  mapId: string;
}

export interface SetReadyMsg {
  type: 'SET_READY';
  ready: boolean;
}

export interface RosterUpdatedMsg {
  type: 'ROSTER_UPDATED';
  roster: PlayerInfo[];
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

/**
 * 房主偵測到某個客戶端的 checksum 跟自己對不上(lockstep 跑飛)時廣播,所有人收到就
 * 中止對局並提示。跑飛沒辦法自動修(RESYNC 是設計給換房主用的,拿來救 desync 只會把
 * 「兩邊規則不同」的根本問題藏起來),只報錯不自動救。
 */
export interface DesyncMsg {
  type: 'DESYNC';
  tick: number;
  /** checksum 對不上的那個玩家(顯示用)。 */
  playerId: PlayerId;
}

/**
 * 房主斷線自動換房主(見 room.ts 的 attemptRehost()):新房主回應 REJOIN 時附上目前的權威
 * 模擬狀態,重連的客戶端要整份取代自己手上的 state,不能只跳號對齊 tick 編號——只跳號但
 * 沒換 state 的話,tick 計數器跟實際模擬內容會對不上(計數器說「已經算到 tick N 了」,但
 * state 內容其實還停在斷線那一刻,中間漏算的 tick 永遠補不回來),兩個客戶端後續的模擬
 * 結果會跑飛(checksum 對不起來)。整份 state 直接照抄 sim/simulation.ts 的 SimulationState,
 * 都是 plain object/array/Record,JSON 序列化不會遺失資訊。
 */
export interface ResyncMsg {
  type: 'RESYNC';
  tick: number;
  state: SimulationState;
}

export type NetMessage =
  | HelloMsg
  | RejectMsg
  | RejoinMsg
  | WelcomeMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | StartMatchMsg
  | SetReadyMsg
  | RosterUpdatedMsg
  | CmdMsg
  | TickMsg
  | PingMsg
  | PongMsg
  | ChecksumMsg
  | DesyncMsg
  | ResyncMsg;

export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

function isElementArray(v: unknown): v is Element[] {
  return Array.isArray(v) && v.length > 0 && v.every(isElement);
}

function isPlayerInfo(v: unknown): v is PlayerInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.playerId === 'string' &&
    typeof o.slot === 'number' &&
    typeof o.name === 'string' &&
    isElementArray(o.elements) &&
    typeof o.ready === 'boolean'
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
      if (typeof o.protocolVersion === 'number' && typeof o.name === 'string' && isElementArray(o.elements)) {
        // appVersion 缺漏(舊版 bundle 不會送)當空字串——比對時自然不等於任何真實版本,
        // 會被房主明確 REJECT,而不是解析失敗被靜默丟掉(那樣加入者只會看到沒反應)。
        return {
          type: 'HELLO',
          protocolVersion: o.protocolVersion,
          appVersion: typeof o.appVersion === 'string' ? o.appVersion : '',
          name: o.name,
          elements: o.elements,
        };
      }
      return null;

    case 'REJECT':
      if (
        o.reason === 'room_full' ||
        o.reason === 'match_in_progress' ||
        o.reason === 'version_mismatch' ||
        o.reason === 'unknown_player'
      ) {
        return { type: 'REJECT', reason: o.reason };
      }
      return null;

    case 'REJOIN':
      if (typeof o.protocolVersion === 'number' && typeof o.playerId === 'string') {
        return {
          type: 'REJOIN',
          protocolVersion: o.protocolVersion,
          appVersion: typeof o.appVersion === 'string' ? o.appVersion : '',
          playerId: o.playerId,
        };
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
        typeof o.countdownMs === 'number' &&
        typeof o.difficultyPercent === 'number' &&
        typeof o.endlessMode === 'boolean' &&
        typeof o.individualLivesMode === 'boolean' &&
        isMapId(o.mapId)
      ) {
        return {
          type: 'START_MATCH',
          seed: o.seed,
          roster: o.roster,
          tickRateMs: o.tickRateMs,
          inputDelayTicks: o.inputDelayTicks,
          countdownMs: o.countdownMs,
          difficultyPercent: o.difficultyPercent,
          endlessMode: o.endlessMode,
          individualLivesMode: o.individualLivesMode,
          mapId: o.mapId,
        };
      }
      return null;

    case 'SET_READY':
      if (typeof o.ready === 'boolean') {
        return { type: 'SET_READY', ready: o.ready };
      }
      return null;

    case 'ROSTER_UPDATED':
      if (isPlayerInfoArray(o.roster)) {
        return { type: 'ROSTER_UPDATED', roster: o.roster };
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

    case 'DESYNC':
      if (typeof o.tick === 'number' && typeof o.playerId === 'string') {
        return { type: 'DESYNC', tick: o.tick, playerId: o.playerId };
      }
      return null;

    case 'RESYNC':
      // state 只做最基本的「是個物件」檢查,不逐欄位驗證——朋友間連線的信任制慣例(跟
      // Action.params 同一套標準),而且這個訊息只會來自剛接手的新房主,不是外來未知輸入。
      if (typeof o.tick === 'number' && typeof o.state === 'object' && o.state !== null) {
        return { type: 'RESYNC', tick: o.tick, state: o.state as SimulationState };
      }
      return null;

    default:
      return null;
  }
}
