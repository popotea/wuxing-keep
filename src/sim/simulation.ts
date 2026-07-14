// Phase 1 核心模擬:蓋塔/賣塔指令、生怪、怪物移動、塔攻擊、金幣/生命、勝敗判定。
// 對外簽章 step(state, tick, commands) 維持跟 Phase 3 stub 一樣,lockstep.ts 完全不用改。
//
// 決定性守則:全程整數/定點數運算,不合法的指令一律安全忽略(不丟例外),
// 這樣同一組 (state, tick, commands) 在任何一台機器上都會算出完全相同的結果。

import type { Action, PlayerId, TimedCommand } from '../net/protocol';
import { isElement, type Element } from './elements';
import { advanceAlongPath, inBounds, isOnPath } from './map';
import { createMonster, getSpawnEventsForTick, totalWaveTicks, type Monster } from './monsters';
import { TOWER_DEFS, tryAttack, type Tower } from './towers';

export interface SimulationState {
  tick: number;
  gold: number;
  lives: number;
  towers: Tower[];
  monsters: Monster[];
  nextTowerId: number;
  nextMonsterId: number;
  gameOver: boolean;
  victory: boolean;
  /** 除錯用:多台機器互相比對,一旦不一致就代表跑飛了 */
  checksum: string;
}

const STARTING_GOLD = 300;
const STARTING_LIVES = 20;

export function createInitialState(seed: number): SimulationState {
  return {
    tick: 0,
    gold: STARTING_GOLD,
    lives: STARTING_LIVES,
    towers: [],
    monsters: [],
    nextTowerId: 1,
    nextMonsterId: 1,
    gameOver: false,
    victory: false,
    checksum: seed.toString(16),
  };
}

function asFiniteInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cloneState(state: SimulationState): SimulationState {
  return {
    ...state,
    towers: state.towers.map((t) => ({ ...t })),
    monsters: state.monsters.map((m) => ({ ...m, pos: { ...m.pos } })),
  };
}

// 朋友間連線,採信任制:不合法的操作(格子被佔用、錢不夠、id 不存在)一律安全地當no-op,
// 不做防作弊驗證——這在所有機器上都是相同的 no-op,不影響決定性。
function applyBuildTower(state: SimulationState, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  const element = action.params.element;
  if (x === null || y === null || !isElement(element)) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (state.towers.some((t) => t.x === x && t.y === y)) return;
  const def = TOWER_DEFS[element as Element];
  if (state.gold < def.cost) return;
  state.gold -= def.cost;
  state.towers.push({ id: state.nextTowerId++, element: element as Element, x, y, ticksSinceLastAttack: 0 });
}

function applySellTower(state: SimulationState, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const idx = state.towers.findIndex((t) => t.id === towerId);
  if (idx === -1) return;
  const def = TOWER_DEFS[state.towers[idx].element];
  state.gold += Math.floor(def.cost / 2);
  state.towers.splice(idx, 1);
}

function applyCommand(state: SimulationState, _playerId: PlayerId, action: Action): void {
  if (action.kind === 'build_tower') applyBuildTower(state, action);
  else if (action.kind === 'sell_tower') applySellTower(state, action);
  // 其他/未知 kind 一律安全忽略
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function computeChecksum(state: SimulationState): string {
  const towerPart = state.towers.map((t) => `${t.id}:${t.x}:${t.y}:${t.element}`).join(';');
  const monsterPart = state.monsters
    .map((m) => `${m.id}:${m.hp}:${m.pos.segmentIndex}:${m.pos.distanceIntoSegmentFp}`)
    .join(';');
  return simpleHash(`${state.tick}|${state.gold}|${state.lives}|${towerPart}|${monsterPart}`);
}

export function step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState {
  if (state.gameOver || state.victory) {
    return { ...state, tick };
  }

  const next = cloneState(state);
  next.tick = tick;

  // 依 playerId 排序,確保指令套用順序在所有機器上完全一致
  const sorted = [...commands].sort((a, b) => a.playerId.localeCompare(b.playerId));
  for (const cmd of sorted) {
    applyCommand(next, cmd.playerId, cmd.action);
  }

  for (const spawn of getSpawnEventsForTick(tick)) {
    next.monsters.push(createMonster(next.nextMonsterId++, spawn));
  }

  // 怪物移動,漏怪扣生命
  const survivors: Monster[] = [];
  for (const m of next.monsters) {
    const { pos, leaked } = advanceAlongPath(m.pos, m.speedFp);
    if (leaked) {
      next.lives -= 1;
      continue;
    }
    m.pos = pos;
    survivors.push(m);
  }
  next.monsters = survivors;

  for (const tower of next.towers) {
    tryAttack(tower, next.monsters);
  }

  const dead = next.monsters.filter((m) => m.hp <= 0);
  for (const m of dead) next.gold += m.bounty;
  next.monsters = next.monsters.filter((m) => m.hp > 0);

  if (next.lives <= 0) {
    next.gameOver = true;
  } else if (tick >= totalWaveTicks() && next.monsters.length === 0) {
    next.victory = true;
  }

  next.checksum = computeChecksum(next);
  return next;
}
