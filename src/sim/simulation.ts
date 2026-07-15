// Phase 1 核心模擬:蓋塔/賣塔指令、生怪、怪物移動、塔攻擊、金幣/生命、勝敗判定。
// 對外簽章 step(state, tick, commands) 維持跟 Phase 3 stub 一樣,lockstep.ts 完全不用改。
//
// 決定性守則:全程整數/定點數運算,不合法的指令一律安全忽略(不丟例外),
// 這樣同一組 (state, tick, commands) 在任何一台機器上都會算出完全相同的結果。

import type { Action, PlayerId, TimedCommand } from '../net/protocol';
import { isElement, type Element } from './elements';
import { advanceAlongPath, FP_SCALE, inBounds, isOnPath, worldPositionFp } from './map';
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
import {
  RESOURCE_BUILDING_COST,
  RESOURCE_BUILDING_INCOME,
  RESOURCE_BUILDING_INTERVAL_TICKS,
  TRAP_COST,
  TRAP_SLOW_PERCENT,
  type ResourceBuilding,
  type Trap,
} from './placements';
import {
  sellValue,
  TARGET_STRATEGIES,
  TOWER_DEFS,
  tryAttack,
  upgradeCost,
  type CombatEvent,
  type TargetStrategy,
  type Tower,
} from './towers';

export interface SimulationState {
  tick: number;
  /** 團隊模式:每個玩家自己一份、彼此獨立的金幣。塔可以互相幫忙升級,但花的是升級者自己的錢。 */
  gold: Record<PlayerId, number>;
  /** 生命是團隊共用一份,不分誰漏的怪。 */
  lives: number;
  towers: Tower[];
  monsters: Monster[];
  /** 非攻擊型放置物:陷阱只能蓋在路徑格,踩到會減速;資源建築規則跟塔一樣蓋在非路徑格,定期給 owner 被動金幣。 */
  traps: Trap[];
  resourceBuildings: ResourceBuilding[];
  nextTowerId: number;
  nextMonsterId: number;
  nextTrapId: number;
  nextResourceBuildingId: number;
  gameOver: boolean;
  victory: boolean;
  /** 第 i 波的加碼獎勵是否已經判定過(不管有沒有趕上時限),避免重複發放 */
  bonusAwarded: boolean[];
  /** New Game+ 風味的難度倍率(百分比,100=普通)。開局後固定不變,只影響生怪時的數值縮放。 */
  difficultyPercent: number;
  /**
   * 依房間人數算出的怪物強度加成(百分比,100=沒有加成、單人固定是這個值)。
   * 人數越多,團隊防守火力(塔的數量)通常也越強,用這個補一點怪物血量/速度回來,
   * 賞金刻意不跟著這個加成(賞金是每人各自領全額,人數多本來就已經加倍團隊總金幣,
   * 賞金再乘這個加成會雙重放大,滾雪球滾更大)。開局後固定不變。
   */
  playerCountScalePercent: number;
  /** 每個玩家開局前選好、整局固定的可蓋屬性集合;沒有對應項目代表不限制(單人用預設值時走這條)。 */
  playerElements: Record<PlayerId, Element[]>;
  /** 這個 tick 發生的攻擊事件,只給 UI 顯示飄動傷害數字用,每個 tick 開始都會清空重算,不是累積狀態。 */
  combatEvents: CombatEvent[];
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
  const gold: Record<PlayerId, number> = {};
  for (const playerId of Object.keys(playerElements)) gold[playerId] = STARTING_GOLD;

  const playerCount = Math.max(1, Object.keys(playerElements).length);
  // 每多一個玩家 +20% 血量/速度,單人(playerCount=1)固定是 100%,不影響既有單人平衡。
  const playerCountScalePercent = 100 + (playerCount - 1) * 20;

  return {
    tick: 0,
    gold,
    lives: STARTING_LIVES,
    towers: [],
    monsters: [],
    traps: [],
    resourceBuildings: [],
    nextTowerId: 1,
    nextMonsterId: 1,
    nextTrapId: 1,
    nextResourceBuildingId: 1,
    gameOver: false,
    victory: false,
    bonusAwarded: WAVES.map(() => false),
    difficultyPercent,
    playerCountScalePercent,
    playerElements,
    combatEvents: [],
    checksum: seed.toString(16),
  };
}

/** 依難度倍率+人數加成縮放怪物數值,整數運算(floor),維持決定性。賞金只跟著難度倍率,不跟人數加成。 */
function scaledSpawn(spawn: SpawnEvent, difficultyPercent: number, playerCountScalePercent: number): SpawnEvent {
  const combatPercent = Math.floor((difficultyPercent * playerCountScalePercent) / 100);
  return {
    ...spawn,
    hp: Math.floor((spawn.hp * combatPercent) / 100),
    speedFp: Math.floor((spawn.speedFp * combatPercent) / 100),
    bounty: Math.floor((spawn.bounty * difficultyPercent) / 100),
  };
}

function asFiniteInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 每個現存玩家的金幣都各加 amount——擊殺賞金/加碼波獎勵都是「全員各自拿全額」,不用追蹤是誰打的。 */
function grantGoldToAllPlayers(state: SimulationState, amount: number): void {
  for (const playerId of Object.keys(state.gold)) {
    state.gold[playerId] += amount;
  }
}

function cloneState(state: SimulationState): SimulationState {
  return {
    ...state,
    gold: { ...state.gold },
    towers: state.towers.map((t) => ({ ...t })),
    monsters: state.monsters.map((m) => ({ ...m, pos: { ...m.pos } })),
    traps: state.traps.map((t) => ({ ...t })),
    resourceBuildings: state.resourceBuildings.map((r) => ({ ...r })),
    bonusAwarded: [...state.bonusAwarded],
  };
}

/** 塔/資源建築都只能蓋在非路徑格,而且彼此不能疊在同一格上。 */
function isBuildableTileFree(state: SimulationState, x: number, y: number): boolean {
  if (state.towers.some((t) => t.x === x && t.y === y)) return false;
  if (state.resourceBuildings.some((r) => r.x === x && r.y === y)) return false;
  return true;
}

// 朋友間連線,採信任制:不合法的操作(格子被佔用、錢不夠、id 不存在)一律安全地當no-op,
// 不做防作弊驗證——這在所有機器上都是相同的 no-op,不影響決定性。
function applyBuildTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  const element = action.params.element;
  if (x === null || y === null || !isElement(element)) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (!isBuildableTileFree(state, x, y)) return;
  const allowed = state.playerElements[playerId];
  if (allowed && !allowed.includes(element)) return; // 不是這個玩家選好的屬性,安全忽略
  const def = TOWER_DEFS[element as Element];
  const gold = state.gold[playerId] ?? 0;
  if (gold < def.cost) return;
  state.gold[playerId] = gold - def.cost;
  state.towers.push({
    id: state.nextTowerId++,
    element: element as Element,
    x,
    y,
    level: 1,
    ticksSinceLastAttack: 0,
    ownerId: playerId,
    targetStrategy: 'first',
  });
}

/** 賣塔只有蓋的本人能賣(避免動到別人的投資),退回的錢算他自己的。 */
function applySellTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const idx = state.towers.findIndex((t) => t.id === towerId);
  if (idx === -1) return;
  const tower = state.towers[idx];
  if (tower.ownerId !== playerId) return;
  state.gold[playerId] = (state.gold[playerId] ?? 0) + sellValue(tower);
  state.towers.splice(idx, 1);
}

/** 升級不分誰的塔,誰都能幫忙出錢升級,但花的是出手升級這個人自己的錢。 */
function applyUpgradeTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const tower = state.towers.find((t) => t.id === towerId);
  if (!tower) return;
  const cost = upgradeCost(tower);
  const gold = state.gold[playerId] ?? 0;
  if (cost === null || gold < cost) return;
  state.gold[playerId] = gold - cost;
  tower.level += 1;
}

/** 集火策略不分誰的塔,任何隊友都能改(跟升級一樣),不花錢、純戰術選擇。 */
function applySetTargetStrategy(state: SimulationState, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  const strategy = action.params.strategy;
  if (towerId === null || typeof strategy !== 'string') return;
  if (!(TARGET_STRATEGIES as readonly string[]).includes(strategy)) return;
  const tower = state.towers.find((t) => t.id === towerId);
  if (!tower) return;
  tower.targetStrategy = strategy as TargetStrategy;
}

/** 陷阱只能蓋在路徑格(跟塔相反),踩到的怪物會被減速,見 step() 裡的移動計算。 */
function applyBuildTrap(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  if (x === null || y === null) return;
  if (!inBounds(x, y) || !isOnPath(x, y)) return;
  if (state.traps.some((t) => t.x === x && t.y === y)) return;
  const gold = state.gold[playerId] ?? 0;
  if (gold < TRAP_COST) return;
  state.gold[playerId] = gold - TRAP_COST;
  state.traps.push({ id: state.nextTrapId++, x, y, ownerId: playerId });
}

/** 資源建築規則跟塔一樣蓋在非路徑格,定期(見 step())只給建造者自己被動金幣,不是全員均分。 */
function applyBuildResourceBuilding(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  if (x === null || y === null) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (!isBuildableTileFree(state, x, y)) return;
  const gold = state.gold[playerId] ?? 0;
  if (gold < RESOURCE_BUILDING_COST) return;
  state.gold[playerId] = gold - RESOURCE_BUILDING_COST;
  state.resourceBuildings.push({
    id: state.nextResourceBuildingId++,
    x,
    y,
    ownerId: playerId,
    ticksSinceLastIncome: 0,
  });
}

function applyCommand(state: SimulationState, playerId: PlayerId, action: Action): void {
  if (action.kind === 'build_tower') applyBuildTower(state, playerId, action);
  else if (action.kind === 'sell_tower') applySellTower(state, playerId, action);
  else if (action.kind === 'upgrade_tower') applyUpgradeTower(state, playerId, action);
  else if (action.kind === 'set_target_strategy') applySetTargetStrategy(state, action);
  else if (action.kind === 'build_trap') applyBuildTrap(state, playerId, action);
  else if (action.kind === 'build_resource_building') applyBuildResourceBuilding(state, playerId, action);
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
  // 排序 key 避免不同機器上 Record 的 key 插入順序不同導致 checksum 誤判跑飛。
  const goldPart = Object.keys(state.gold)
    .sort()
    .map((id) => `${id}:${state.gold[id]}`)
    .join(',');
  const towerPart = state.towers
    .map((t) => `${t.id}:${t.x}:${t.y}:${t.element}:${t.level}:${t.targetStrategy}`)
    .join(';');
  const monsterPart = state.monsters
    .map((m) => `${m.id}:${m.hp}:${m.pos.pathId}:${m.pos.segmentIndex}:${m.pos.distanceIntoSegmentFp}`)
    .join(';');
  const trapPart = state.traps.map((t) => `${t.id}:${t.x}:${t.y}`).join(';');
  const resourceBuildingPart = state.resourceBuildings
    .map((r) => `${r.id}:${r.x}:${r.y}:${r.ticksSinceLastIncome}`)
    .join(';');
  const bonusPart = state.bonusAwarded.map((b) => (b ? '1' : '0')).join('');
  return simpleHash(
    `${state.tick}|${goldPart}|${state.lives}|${towerPart}|${monsterPart}|${trapPart}|${resourceBuildingPart}|${bonusPart}`,
  );
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
      grantGoldToAllPlayers(state, wave.bonusGold);
      state.bonusAwarded[i] = true;
    }
  }
}

export function step(state: SimulationState, tick: number, commands: TimedCommand[]): SimulationState {
  if (state.gameOver || state.victory) {
    return { ...state, tick, combatEvents: [] };
  }

  const next = cloneState(state);
  next.tick = tick;
  next.combatEvents = [];

  // 依 playerId 排序,確保指令套用順序在所有機器上完全一致
  const sorted = [...commands].sort((a, b) => a.playerId.localeCompare(b.playerId));
  for (const cmd of sorted) {
    applyCommand(next, cmd.playerId, cmd.action);
  }

  for (const spawn of getSpawnEventsForTick(tick)) {
    const scaled = scaledSpawn(spawn, next.difficultyPercent, next.playerCountScalePercent);
    next.monsters.push(createMonster(next.nextMonsterId++, scaled));
  }

  // 怪物移動,漏怪扣生命——站在陷阱格上的怪物這個 tick 的移動速度打折扣。
  const trapTiles = new Set(next.traps.map((t) => `${t.x},${t.y}`));
  const survivors: Monster[] = [];
  for (const m of next.monsters) {
    const { xFp, yFp } = worldPositionFp(m.pos);
    const onTrap = trapTiles.has(`${Math.floor(xFp / FP_SCALE)},${Math.floor(yFp / FP_SCALE)}`);
    const speedFp = onTrap ? Math.floor((m.speedFp * (100 - TRAP_SLOW_PERCENT)) / 100) : m.speedFp;
    const { pos, leaked } = advanceAlongPath(m.pos, speedFp);
    if (leaked) {
      next.lives -= 1;
      continue;
    }
    m.pos = pos;
    survivors.push(m);
  }
  next.monsters = survivors;

  for (const tower of next.towers) {
    const event = tryAttack(tower, next.monsters);
    if (event) next.combatEvents.push(event);
  }

  const dead = next.monsters.filter((m) => m.hp <= 0);
  // 擊殺賞金:不追蹤是誰的塔打死的(多座塔常常一起打中同一隻),每個現存玩家都各自拿全額。
  for (const m of dead) grantGoldToAllPlayers(next, m.bounty);
  next.monsters = next.monsters.filter((m) => m.hp > 0);

  // 資源建築定期產生被動金幣,只給建造者自己(不是全員均分,這是個人投資報酬)。
  for (const building of next.resourceBuildings) {
    building.ticksSinceLastIncome += 1;
    if (building.ticksSinceLastIncome >= RESOURCE_BUILDING_INTERVAL_TICKS) {
      building.ticksSinceLastIncome = 0;
      next.gold[building.ownerId] = (next.gold[building.ownerId] ?? 0) + RESOURCE_BUILDING_INCOME;
    }
  }

  applyBonusWaveRewards(next, tick);

  if (next.lives <= 0) {
    next.gameOver = true;
  } else if (tick >= totalWaveTicks() && next.monsters.length === 0) {
    next.victory = true;
  }

  next.checksum = computeChecksum(next);
  return next;
}
