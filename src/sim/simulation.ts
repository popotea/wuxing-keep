// Phase 1 核心模擬:蓋塔/賣塔指令、生怪、怪物移動、塔攻擊、金幣/生命、勝敗判定。
// 對外簽章 step(state, tick, commands) 維持跟 Phase 3 stub 一樣,lockstep.ts 完全不用改。
//
// 決定性守則:全程整數/定點數運算,不合法的指令一律安全忽略(不丟例外),
// 這樣同一組 (state, tick, commands) 在任何一台機器上都會算出完全相同的結果。

import type { Action, PlayerId, TimedCommand } from '../net/protocol';
import { isElement, type Element } from './elements';
import { advanceAlongPath, inBounds, isOnPath } from './map';
import {
  createMonster,
  getSpawnEventsForTick,
  SPAWN_INTERVAL_TICKS,
  totalWaveTicks,
  WAVE_INTERVAL_TICKS,
  WAVES,
  type Monster,
  type SpawnEvent,
} from './monsters';
import { sellValue, TOWER_DEFS, tryAttack, upgradeCost, type Tower } from './towers';

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
  /** 第 i 波的加碼獎勵是否已經判定過(不管有沒有趕上時限),避免重複發放 */
  bonusAwarded: boolean[];
  /** New Game+ 風味的難度倍率(百分比,100=普通)。開局後固定不變,只影響生怪時的數值縮放。 */
  difficultyPercent: number;
  /** 每個玩家開局前選好、整局固定的可蓋屬性集合;沒有對應項目代表不限制(單人用預設值時走這條)。 */
  playerElements: Record<PlayerId, Element[]>;
  /** 除錯用:多台機器互相比對,一旦不一致就代表跑飛了 */
  checksum: string;
}

const STARTING_GOLD = 300;
export const STARTING_LIVES = 20;

export function createInitialState(
  seed: number,
  difficultyPercent = 100,
  playerElements: Record<PlayerId, Element[]> = {},
): SimulationState {
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
    bonusAwarded: WAVES.map(() => false),
    difficultyPercent,
    playerElements,
    checksum: seed.toString(16),
  };
}

/** 依難度倍率縮放怪物數值,整數運算(floor),維持決定性。 */
function scaledSpawn(spawn: SpawnEvent, difficultyPercent: number): SpawnEvent {
  if (difficultyPercent === 100) return spawn;
  return {
    ...spawn,
    hp: Math.floor((spawn.hp * difficultyPercent) / 100),
    speedFp: Math.floor((spawn.speedFp * difficultyPercent) / 100),
    bounty: Math.floor((spawn.bounty * difficultyPercent) / 100),
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
    bonusAwarded: [...state.bonusAwarded],
  };
}

// 朋友間連線,採信任制:不合法的操作(格子被佔用、錢不夠、id 不存在)一律安全地當no-op,
// 不做防作弊驗證——這在所有機器上都是相同的 no-op,不影響決定性。
function applyBuildTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  const element = action.params.element;
  if (x === null || y === null || !isElement(element)) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (state.towers.some((t) => t.x === x && t.y === y)) return;
  const allowed = state.playerElements[playerId];
  if (allowed && !allowed.includes(element)) return; // 不是這個玩家選好的屬性,安全忽略
  const def = TOWER_DEFS[element as Element];
  if (state.gold < def.cost) return;
  state.gold -= def.cost;
  state.towers.push({
    id: state.nextTowerId++,
    element: element as Element,
    x,
    y,
    level: 1,
    ticksSinceLastAttack: 0,
  });
}

function applySellTower(state: SimulationState, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const idx = state.towers.findIndex((t) => t.id === towerId);
  if (idx === -1) return;
  state.gold += sellValue(state.towers[idx]);
  state.towers.splice(idx, 1);
}

function applyUpgradeTower(state: SimulationState, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const tower = state.towers.find((t) => t.id === towerId);
  if (!tower) return;
  const cost = upgradeCost(tower);
  if (cost === null || state.gold < cost) return;
  state.gold -= cost;
  tower.level += 1;
}

function applyCommand(state: SimulationState, playerId: PlayerId, action: Action): void {
  if (action.kind === 'build_tower') applyBuildTower(state, playerId, action);
  else if (action.kind === 'sell_tower') applySellTower(state, action);
  else if (action.kind === 'upgrade_tower') applyUpgradeTower(state, action);
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
  const towerPart = state.towers.map((t) => `${t.id}:${t.x}:${t.y}:${t.element}:${t.level}`).join(';');
  const monsterPart = state.monsters
    .map((m) => `${m.id}:${m.hp}:${m.pos.pathId}:${m.pos.segmentIndex}:${m.pos.distanceIntoSegmentFp}`)
    .join(';');
  const bonusPart = state.bonusAwarded.map((b) => (b ? '1' : '0')).join('');
  return simpleHash(`${state.tick}|${state.gold}|${state.lives}|${towerPart}|${monsterPart}|${bonusPart}`);
}

/** 加碼波判定:限時內把整波怪物清光,發放額外金幣;不管有沒有趕上時限,都只判定一次。 */
function applyBonusWaveRewards(state: SimulationState, tick: number): void {
  for (let i = 0; i < WAVES.length; i++) {
    if (state.bonusAwarded[i]) continue;
    const wave = WAVES[i];
    if (wave.bonusClearWithinTicks === undefined || wave.bonusGold === undefined) continue;

    const waveStartTick = i * WAVE_INTERVAL_TICKS;
    const deadline = waveStartTick + wave.bonusClearWithinTicks;
    if (tick > deadline) {
      state.bonusAwarded[i] = true; // 過期了,不用再檢查
      continue;
    }

    const lastSpawnTick = waveStartTick + (wave.count - 1) * SPAWN_INTERVAL_TICKS;
    if (tick < lastSpawnTick) continue; // 這波還沒生完,還不用判定清光了沒

    const stillAlive = state.monsters.some((m) => m.waveIndex === i);
    if (!stillAlive) {
      state.gold += wave.bonusGold;
      state.bonusAwarded[i] = true;
    }
  }
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
    next.monsters.push(createMonster(next.nextMonsterId++, scaledSpawn(spawn, next.difficultyPercent)));
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

  applyBonusWaveRewards(next, tick);

  if (next.lives <= 0) {
    next.gameOver = true;
  } else if (tick >= totalWaveTicks() && next.monsters.length === 0) {
    next.victory = true;
  }

  next.checksum = computeChecksum(next);
  return next;
}
