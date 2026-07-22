// Tick 引擎:房主端固定間隔跑 tick、收齊指令、排序、廣播、餵給本地模擬;
// 客戶端依 tick 編號緩衝,嚴格依序把 TICK 餵給本地模擬,漏收就暫停等待,不跳號。

import type { Element } from '../sim/elements';
import { createInitialState, step, type SimulationState } from '../sim/simulation';
import type { MatchConfig, Room } from './room';
import type { Action, CmdMsg, PlayerId, PlayerInfo, TickMsg, TimedCommand } from './protocol';

export interface LockstepHandlers {
  onStateUpdated?: (state: SimulationState) => void;
  /** 客戶端專用:目前這個 tick 還沒收到確認,模擬正在暫停等待房主 */
  onWaitingForTick?: (tick: number) => void;
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
    } else {
      this.state = createInitialState(
        seed,
        config.difficultyPercent,
        playerElementsFromRoster(room.getRoster()),
        config.endlessMode,
        config.individualLivesMode,
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
    const commands = this.pending.get(this.currentTick) ?? [];
    this.pending.delete(this.currentTick);
    // 空陣列也照樣送出(心跳 tick)——否則安靜期間客戶端會永遠等不到確認而卡住
    this.room.broadcastTick({ type: 'TICK', tick: this.currentTick, commands });
    this.state = step(this.state, this.currentTick, commands);
    this.handlers.onStateUpdated?.(this.state);
    this.currentTick += 1;
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
    private handlers: LockstepHandlers,
  ) {
    this.state = createInitialState(
      seed,
      difficultyPercent,
      playerElementsFromRoster(room.getRoster()),
      endlessMode,
      individualLivesMode,
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
      const commands = this.buffer.get(this.nextTickToApply)!;
      this.buffer.delete(this.nextTickToApply);
      this.state = step(this.state, this.nextTickToApply, commands);
      this.handlers.onStateUpdated?.(this.state);
      this.nextTickToApply += 1;
    }
    this.handlers.onWaitingForTick?.(this.nextTickToApply);
  }
}
