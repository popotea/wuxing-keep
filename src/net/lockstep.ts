// Tick 引擎:房主端固定間隔跑 tick、收齊指令、排序、廣播、餵給本地模擬;
// 客戶端依 tick 編號緩衝,嚴格依序把 TICK 餵給本地模擬,漏收就暫停等待,不跳號。

import { createInitialState, step, type SimulationState } from '../sim/simulation';
import type { MatchConfig, Room } from './room';
import type { Action, CmdMsg, PlayerId, TickMsg, TimedCommand } from './protocol';

export interface LockstepHandlers {
  onStateUpdated?: (state: SimulationState) => void;
  /** 客戶端專用:目前這個 tick 還沒收到確認,模擬正在暫停等待房主 */
  onWaitingForTick?: (tick: number) => void;
}

/** 房主端:固定間隔跑 tick,收齊指令、排序、廣播,並用同一條路徑餵給自己的本地模擬。 */
export class HostLockstepEngine {
  private state: SimulationState;
  private currentTick = 0;
  private pending = new Map<number, TimedCommand[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private room: Room,
    private config: MatchConfig,
    seed: number,
    private handlers: LockstepHandlers,
  ) {
    this.state = createInitialState(seed);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.advance(), this.config.tickRateMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    private handlers: LockstepHandlers,
  ) {
    this.state = createInitialState(seed);
  }

  /** 收到房主 TICK 訊息時呼叫(外部把 Room 的 onTick 接到這裡)。 */
  receiveTick(msg: TickMsg): void {
    this.buffer.set(msg.tick, msg.commands);
    this.drain();
  }

  submitLocalCommand(action: Action): void {
    this.room.sendCommand(action, this.localSeq++);
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
