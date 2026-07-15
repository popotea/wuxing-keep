// 單人模式本地驅動:直接在本機用 setInterval 固定間隔跑 step(),
// 不經過 Room/PeerJS,也不需要 inputDelay(那是用來蓋掉網路延遲的,單人不需要)。
// 保留跟 HostLockstepEngine 相同的「收指令 -> 下一 tick 套用」節奏,
// 純粹是少了廣播/收指令的網路往返。

import type { Element } from './elements';
import { createInitialState, step, type SimulationState } from './simulation';
import type { Action, PlayerId, TimedCommand } from '../net/protocol';

export const LOCAL_PLAYER_ID: PlayerId = 'local';

export interface LocalEngineHandlers {
  onStateUpdated?: (state: SimulationState) => void;
}

export class LocalEngine {
  private state: SimulationState;
  private currentTick = 0;
  private pendingCommands: TimedCommand[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    seed: number,
    private tickRateMs: number,
    private handlers: LocalEngineHandlers,
    difficultyPercent = 100,
    allowedElements: Element[] = ['metal', 'wood', 'water', 'fire', 'earth'],
    endlessMode = false,
  ) {
    this.state = createInitialState(seed, difficultyPercent, { [LOCAL_PLAYER_ID]: allowedElements }, endlessMode);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.advance(), this.tickRateMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  submitCommand(action: Action): void {
    this.pendingCommands.push({ playerId: LOCAL_PLAYER_ID, action });
  }

  private advance(): void {
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    this.state = step(this.state, this.currentTick, commands);
    this.handlers.onStateUpdated?.(this.state);
    this.currentTick += 1;
  }
}
