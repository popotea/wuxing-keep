// Tick 引擎:房主端固定間隔跑 tick、收齊指令、排序、廣播、餵給本地模擬;
// 客戶端依 tick 編號緩衝,嚴格依序把 TICK 餵給本地模擬,漏收就暫停等待,不跳號。

import type { Element } from '../sim/elements';
import { setActiveMap } from '../sim/map';
import { createInitialState, step, type SimulationState } from '../sim/simulation';
import type { MatchConfig, Room } from './room';
import type { Action, ChecksumMsg, CmdMsg, PlayerId, PlayerInfo, TickMsg, TimedCommand } from './protocol';

export interface LockstepHandlers {
  onStateUpdated?: (state: SimulationState) => void;
  /** 客戶端專用:目前這個 tick 還沒收到確認,模擬正在暫停等待房主 */
  onWaitingForTick?: (tick: number) => void;
  /** 房主專用:某個客戶端回報的 checksum 跟自己對不上(lockstep 跑飛)——呼叫端應廣播 DESYNC 並中止對局。 */
  onDesyncDetected?: (playerId: PlayerId, tick: number) => void;
}

/** 客戶端每隔這麼多 tick 回報一次 checksum 給房主(50ms/tick 下約 2 秒一次,頻寬負擔可忽略)。 */
const CHECKSUM_REPORT_INTERVAL_TICKS = 40;
/** 房主保留最近這麼多 tick 的 checksum 供比對——要涵蓋客戶端最大落後量(網路延遲 + drain 節奏)。 */
const CHECKSUM_HISTORY_TICKS = 200;

/**
 * 呼叫 UI 端的 onStateUpdated 一律包這層:handler 裡是一大串 UI 工作(Phaser 重繪、
 * localStorage 寫入……),丟一次例外不能中斷 lockstep——沒包的話 client 端 drain() 會
 * 「tick 已消費但計數器沒進位」永久凍結(只有這個玩家畫面停住,其他人都正常,2026-07-23
 * 排查「加入者不能玩」時確認過的真實故障模式);host 端更慘,會重複廣播同一 tick。
 */
function notifyStateUpdated(handlers: LockstepHandlers, state: SimulationState): void {
  try {
    handlers.onStateUpdated?.(state);
  } catch (err) {
    console.error('[lockstep] onStateUpdated 例外(已忽略,不中斷 lockstep):', err);
  }
}

/** roster 裡每個玩家開局前選好的屬性集合,轉成 step() 看得懂的 playerId -> elements 對照表。 */
function playerElementsFromRoster(roster: PlayerInfo[]): Record<PlayerId, Element[]> {
  return Object.fromEntries(roster.map((p) => [p.playerId, p.elements]));
}

/**
 * 房主斷線自動換房主時用來搬移進度的快照,兩種場合共用同一個形狀:
 * 1. 接手的玩家用這個接續既有進度,不能從 seed 重新算一次(那樣會把場上塔/怪物/金幣全部
 *    重置回開局狀態)——見 HostLockstepEngine 建構子的 resume 參數。
 * 2. 新房主要回應重連客戶端的 REJOIN 時,把自己目前的快照整份送過去,讓對方用
 *    ClientLockstepEngine.applyResync() 整份取代自己的 state——只跳號對齊 tick 編號但不換
 *    state 內容的話,tick 計數器跟實際模擬內容會對不上,詳見 applyResync() 的註解。
 * 不管哪種場合,快照都來自「當事人自己手上最新的那份 state」,不需要另外重算——lockstep
 * 保證所有玩家的模擬結果位元級相同。`pending`(房主端未來 tick 的待處理指令佇列)則是刻意
 * 留白重新開始:舊房主斷線那一刻還在 `inputDelayTicks` 緩衝視窗內、尚未被排進已廣播 TICK
 * 的指令必然遺失(沒有 ack 機制、也沒人備份),這是換房主接受的代價,不是要修的 bug。
 */
export interface LockstepSnapshot {
  state: SimulationState;
  tick: number;
}

/** 房主端:固定間隔跑 tick,收齊指令、排序、廣播,並用同一條路徑餵給自己的本地模擬。 */
export class HostLockstepEngine {
  private state: SimulationState;
  private currentTick: number;
  private pending = new Map<number, TimedCommand[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 最近 CHECKSUM_HISTORY_TICKS 個 tick 的 checksum,收到客戶端回報時同 tick 比對用。 */
  private recentChecksums = new Map<number, string>();
  /** 跑飛只通報一次就好——中止流程觸發後,後續遲到的 CHECKSUM 不用再各報一次。 */
  private desyncReported = false;

  constructor(
    private room: Room,
    private config: MatchConfig,
    seed: number,
    private handlers: LockstepHandlers,
    resume?: LockstepSnapshot,
  ) {
    if (resume) {
      this.state = resume.state;
      this.currentTick = resume.tick;
      // 接手既有進度時沒有走 createInitialState(),map.ts 的模組層級地圖快取不會被設定——
      // 這台機器如果是重整過/剛升格,活躍地圖可能還停在預設值,路徑資料一錯就直接跑飛。
      setActiveMap(resume.state.mapId);
    } else {
      this.state = createInitialState(
        seed,
        config.difficultyPercent,
        playerElementsFromRoster(room.getRoster()),
        config.endlessMode,
        config.individualLivesMode,
        config.mapId,
      );
      this.currentTick = 0;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.advance(), this.config.tickRateMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 房主斷線自動換房主:新房主回應重連客戶端的 REJOIN 時,把目前的權威狀態整份給對方
   * (見 protocol.ts 的 ResyncMsg、room.ts 的 attemptRehost() 呼叫方式)。
   */
  getSnapshot(): LockstepSnapshot {
    return { state: this.state, tick: this.currentTick };
  }

  /** 收到客戶端 CMD 訊息時呼叫(外部把 Room 的 onCommand 接到這裡)。 */
  enqueueRemoteCommand(cmd: CmdMsg): void {
    this.enqueue(cmd.playerId, cmd.action);
  }

  /**
   * 收到客戶端定期回報的 checksum(外部把 Room 的 onChecksum 接到這裡):**一定要同 tick
   * 比對**,不同 tick 的 checksum 沒有比較意義。太舊(超出保留窗)或還沒算到的 tick 安靜
   * 跳過;對不上就通知呼叫端(只報一次),lockstep 跑飛沒辦法自動救,交給 UI 中止對局。
   */
  receiveChecksum(msg: ChecksumMsg): void {
    if (this.desyncReported) return;
    const mine = this.recentChecksums.get(msg.tick);
    if (mine === undefined || mine === msg.hash) return;
    this.desyncReported = true;
    this.handlers.onDesyncDetected?.(msg.playerId, msg.tick);
  }

  /** 房主自己的操作,直接進佇列,不需要透過網路送給自己。 */
  submitLocalCommand(action: Action): void {
    this.enqueue(this.room.getMyPlayerId(), action);
  }

  private enqueue(playerId: PlayerId, action: Action): void {
    const targetTick = this.currentTick + this.config.inputDelayTicks;
    const list = this.pending.get(targetTick) ?? [];
    list.push({ playerId, action });
    this.pending.set(targetTick, list);
  }

  private advance(): void {
    const tick = this.currentTick;
    const commands = this.pending.get(tick) ?? [];
    this.pending.delete(tick);
    // 空陣列也照樣送出(心跳 tick)——否則安靜期間客戶端會永遠等不到確認而卡住
    this.room.broadcastTick({ type: 'TICK', tick, commands });
    this.state = step(this.state, tick, commands);
    // tick 推進要在通知 UI **之前**完成(原子性):onStateUpdated 丟例外的話,推進沒做到
    // 會讓下個 interval 重複廣播同一 tick、對自己的 state 重複 step,直接毀掉決定性。
    this.currentTick = tick + 1;
    this.recentChecksums.set(tick, this.state.checksum);
    this.recentChecksums.delete(tick - CHECKSUM_HISTORY_TICKS);
    notifyStateUpdated(this.handlers, this.state);
  }
}

/** 客戶端:依 tick 編號緩衝 TICK 訊息,嚴格依序消費,漏收就暫停等待。 */
export class ClientLockstepEngine {
  private state: SimulationState;
  private nextTickToApply = 0;
  private buffer = new Map<number, TimedCommand[]>();
  private localSeq = 0;

  constructor(
    private room: Room,
    seed: number,
    difficultyPercent: number,
    endlessMode: boolean,
    individualLivesMode: boolean,
    mapId: string,
    private handlers: LockstepHandlers,
  ) {
    this.state = createInitialState(
      seed,
      difficultyPercent,
      playerElementsFromRoster(room.getRoster()),
      endlessMode,
      individualLivesMode,
      mapId,
    );
  }

  /** 收到房主 TICK 訊息時呼叫(外部把 Room 的 onTick 接到這裡)。 */
  receiveTick(msg: TickMsg): void {
    this.buffer.set(msg.tick, msg.commands);
    this.drain();
  }

  submitLocalCommand(action: Action): void {
    this.room.sendCommand(action, this.localSeq++);
  }

  /**
   * 房主斷線自動換房主(見 room.ts 的 attemptRehost()):重連到新房主後,新房主會回應一份
   * 完整快照(protocol.ts 的 ResyncMsg),用這個整份取代自己的 state/tick、清空緩衝區。
   * **不能只跳號對齊 tick 編號、state 內容不換**——舊房主斷線那一刻,自己手上的
   * nextTickToApply 不一定剛好等於新房主起算的 tick(網路時間差可能讓兩邊差個 1、2 個
   * tick),如果只改 nextTickToApply 不換 state,計數器會宣稱「已經算到 tick N 了」但
   * state 內容其實還停在斷線當下,中間差的那幾個 tick 永遠補不回來——實測會讓換房主後不同
   * 客戶端的 checksum 對不起來(跑飛)。整份 state 换掉才能保證跟新房主的權威狀態位元級一致。
   */
  applyResync(tick: number, state: SimulationState): void {
    this.buffer.clear();
    this.state = state;
    this.nextTickToApply = tick;
    // 跟 HostLockstepEngine 的 resume 分支同樣的理由:整份換掉 state 沒有經過
    // createInitialState(),要自己補設定 map.ts 的活躍地圖,不然接下來每一步移動都會算錯。
    setActiveMap(state.mapId);
  }

  /**
   * 房主斷線自動換房主:如果換房主的結果是「我」被選中接手,呼叫這個把目前的模擬進度
   * (state/tick)交給新建的 HostLockstepEngine(見 LockstepSnapshot)——lockstep 保證所有玩家
   * 的模擬結果位元級相同,不需要跟任何人要資料,自己手上的就是最新權威狀態。
   */
  exportForPromotion(): LockstepSnapshot {
    return { state: this.state, tick: this.nextTickToApply };
  }

  private drain(): void {
    while (this.buffer.has(this.nextTickToApply)) {
      const tick = this.nextTickToApply;
      const commands = this.buffer.get(tick)!;
      this.buffer.delete(tick);
      this.state = step(this.state, tick, commands);
      // 計數器推進要在通知 UI **之前**完成(原子性):onStateUpdated 丟一次例外的話,
      // 這個 tick 已從 buffer 消費、state 已前進,但計數器沒進位——之後 buffer.has()
      // 永遠 false,這個客戶端就永久凍結(其他人完全正常),見 notifyStateUpdated 的說明。
      this.nextTickToApply = tick + 1;
      // 定期把 checksum 回報給房主比對,跑飛才會被發現(不然兩邊各玩各的都以為自己正常)。
      if (tick % CHECKSUM_REPORT_INTERVAL_TICKS === 0) {
        this.room.sendChecksum(tick, this.state.checksum);
      }
      notifyStateUpdated(this.handlers, this.state);
    }
    this.handlers.onWaitingForTick?.(this.nextTickToApply);
  }
}
