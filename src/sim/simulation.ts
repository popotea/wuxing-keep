// Phase 1 核心模擬:蓋塔/賣塔指令、生怪、怪物移動、塔攻擊、金幣/生命、勝敗判定。
// 對外簽章 step(state, tick, commands) 維持跟 Phase 3 stub 一樣,lockstep.ts 完全不用改。
//
// 決定性守則:全程整數/定點數運算,不合法的指令一律安全忽略(不丟例外),
// 這樣同一組 (state, tick, commands) 在任何一台機器上都會算出完全相同的結果。

import type { Action, PlayerId, TimedCommand } from '../net/protocol';
import { isElement, type Element } from './elements';
import { advanceAlongPath, FP_SCALE, inBounds, isOnPath, PATH_COUNT, worldPositionFp } from './map';
import {
  createMonster,
  getEndlessSpawnEventsForTick,
  getSpawnEventsForTick,
  SPAWN_INTERVAL_TICKS,
  totalWaveTicks,
  WAVE_INTERVAL_TICKS,
  WAVES,
  type Monster,
  type SpawnEvent,
} from './monsters';
import {
  MAX_RUNE_TOTEM_LEVEL,
  RESOURCE_BUILDING_COST,
  RESOURCE_BUILDING_INCOME,
  RESOURCE_BUILDING_INTERVAL_TICKS,
  RUNE_TOTEM_COST,
  RUNE_TOTEM_UPGRADE_COST,
  TRAP_COST,
  TRAP_SLOW_PERCENT_BY_LEVEL,
  trapUpgradeCost,
  type ResourceBuilding,
  type RuneTotem,
  type Trap,
} from './placements';
import {
  dualTowerStats,
  sellValue,
  TARGET_STRATEGIES,
  TOWER_DEFS,
  tryAttack,
  upgradeCost,
  UPGRADE_PATH_LEVEL,
  type CombatEvent,
  type TargetStrategy,
  type Tower,
  type UpgradePath,
} from './towers';

/** 記分板用的每人累計數據(參考 WC3 記分板),純顯示用,不影響任何經濟/戰鬥判定。 */
export interface PlayerStats {
  damageDealt: number;
  kills: number;
}

export interface SimulationState {
  tick: number;
  /** 團隊模式:每個玩家自己一份、彼此獨立的金幣。塔可以互相幫忙升級,但花的是升級者自己的錢。 */
  gold: Record<PlayerId, number>;
  /** 團隊共用一份的生命(預設模式,不分誰漏的怪)。`individualLivesMode` 開啟時這個欄位不會
   * 再被更新(固定停在初始值),勝敗判定跟漏怪扣血都改看下面的 `pathLives`。 */
  lives: number;
  towers: Tower[];
  monsters: Monster[];
  /**
   * 非攻擊型放置物:陷阱只能蓋在路徑格,踩到會減速;資源建築規則跟塔一樣蓋在非路徑格,定期給
   * owner 被動金幣;符文圖騰規則也跟塔一樣蓋在非路徑格,自己不攻擊,範圍內的塔(不分誰的)
   * 攻擊力/攻速都可能提升(見 towers.ts 的 nearbyTotemEffect)。
   */
  traps: Trap[];
  resourceBuildings: ResourceBuilding[];
  runeTotems: RuneTotem[];
  nextTowerId: number;
  nextMonsterId: number;
  nextTrapId: number;
  nextResourceBuildingId: number;
  nextRuneTotemId: number;
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
  /** 記分板用:每個玩家累計造成的傷害/擊殺數,依塔的 ownerId 歸戶。純顯示用,跟團隊經濟(賞金全員均分)是分開的兩件事。 */
  playerStats: Record<PlayerId, PlayerStats>;
  /** 這個 tick 發生的攻擊事件,只給 UI 顯示飄動傷害數字用,每個 tick 開始都會清空重算,不是累積狀態。 */
  combatEvents: CombatEvent[];
  /**
   * 無限模式:開局後固定不變,跟 difficultyPercent 一樣是靜態設定,不用算進 checksum(不會被
   * step() 修改,也不是跨機器可能分岐的來源)。true 時 step() 改用 monsters.ts 的
   * getEndlessSpawnEventsForTick() 生怪(難度隨波次持續往上疊,沒有終點),victory 永遠不會
   * 被設成 true(只有 gameOver),加碼波機制(applyBonusWaveRewards)也整個跳過不判定。
   */
  endlessMode: boolean;
  /**
   * 「呼叫下一波」按鈕的累計快轉量:只影響「現在算到第幾波、該生什麼」的判斷(見
   * effectiveWaveTick()),不影響真正的 tick(怪物移動速度、塔冷卻、資源建築收入這些都還是
   * 照實際 tick 走,不會被這個影響——按了「呼叫下一波」不會讓場上怪物突然移動變快)。
   * 任何玩家都能按,不分誰的操作(跟升級/集火策略同一套慣例)。
   */
  waveTickOffset: number;
  /**
   * 個人生命模式:開局後固定不變(跟 `endlessMode` 一樣,不用算進 checksum)。多人連線限定
   * (單人模式一直是 false,見 `main.ts` 只有多人建房頁面才有這個選項)。true 時每條路徑各自
   * 有獨立的生命池子(見 `pathLives`),漏怪只扣該路徑自己的血,不影響其他路徑;某條路徑的
   * 生命歸零時那條路徑直接停止生怪(`step()` 過濾掉指定給死路徑的 `SpawnEvent`,怪物永遠不會
   * 再出現,不是暫停),其他路徑不受影響繼續進行;全部路徑都歸零才算 `gameOver`。
   */
  individualLivesMode: boolean;
  /**
   * 只有 `individualLivesMode` 開啟時才有意義,長度固定是 `PATH_COUNT`,索引對應 `pathId`。
   * 是會被 `step()` 修改的動態狀態,**要算進 `computeChecksum`**(跟 `waveTickOffset` 同一類,
   * 不是像 `endlessMode` 那種一次性旗標)。
   */
  pathLives: number[];
  /**
   * 只有 `individualLivesMode` 開啟時才有意義,長度固定是 `PATH_COUNT`,索引對應 `pathId`,
   * 內容是負責那條路徑的玩家 id 清單(`createInitialState()` 依玩家數對 `PATH_COUNT` 取餘數
   * 分組,純顯示用——不是權限管控,任何人本來就能在任何地方蓋塔,只是决定「這條路徑漏怪
   * 算誰的」)。開局後固定不變,不用算進 checksum。
   */
  pathOwners: PlayerId[][];
  /** 除錯用:多台機器互相比對,一旦不一致就代表跑飛了 */
  checksum: string;
}

/** 判斷「現在算到第幾波」用的有效 tick——真正的 tick 加上「呼叫下一波」按鈕累計的快轉量。 */
export function effectiveWaveTick(state: SimulationState): number {
  return state.tick + state.waveTickOffset;
}

const STARTING_GOLD = 300;
export const STARTING_LIVES = 20;

/**
 * 互助道具:緊急補命——花大錢回復幾條命,任何玩家都能用,不分誰出錢。故意設計成只有
 * 「生命快歸零」時才能用(`lives <= EMERGENCY_HEAL_THRESHOLD`),不是隨時能買命池子,
 * 定位是走投無路時的最後手段,不是常態性的生命來源。個人生命模式下改看指定路徑的
 * `pathLives`,只補那一條路徑,其他路徑不受影響。
 */
export const EMERGENCY_HEAL_COST = 400;
export const EMERGENCY_HEAL_AMOUNT = 5;
export const EMERGENCY_HEAL_THRESHOLD = 5;

export function createInitialState(
  seed: number,
  difficultyPercent = 100,
  playerElements: Record<PlayerId, Element[]> = {},
  endlessMode = false,
  individualLivesMode = false,
): SimulationState {
  const gold: Record<PlayerId, number> = {};
  const playerStats: Record<PlayerId, PlayerStats> = {};
  for (const playerId of Object.keys(playerElements)) {
    gold[playerId] = STARTING_GOLD;
    playerStats[playerId] = { damageDealt: 0, kills: 0 };
  }

  const playerCount = Math.max(1, Object.keys(playerElements).length);
  // 每多一個玩家 +20% 血量/速度,單人(playerCount=1)固定是 100%,不影響既有單人平衡。
  const playerCountScalePercent = 100 + (playerCount - 1) * 20;

  // 個人生命模式:把玩家排序後依 index % PATH_COUNT 分組,每條路徑的生命池子是團隊生命
  // 平均分下去(而不是每條路徑各自滿額),維持整體難度跟預設模式差不多,不會憑空變兩倍簡單。
  const sortedPlayerIds = Object.keys(playerElements).sort();
  const pathOwners: PlayerId[][] = Array.from({ length: PATH_COUNT }, () => []);
  for (let i = 0; i < sortedPlayerIds.length; i++) {
    pathOwners[i % PATH_COUNT].push(sortedPlayerIds[i]);
  }
  const livesPerPath = Math.max(1, Math.floor(STARTING_LIVES / PATH_COUNT));

  return {
    tick: 0,
    gold,
    lives: STARTING_LIVES,
    towers: [],
    monsters: [],
    traps: [],
    resourceBuildings: [],
    runeTotems: [],
    nextTowerId: 1,
    nextMonsterId: 1,
    nextTrapId: 1,
    nextResourceBuildingId: 1,
    nextRuneTotemId: 1,
    gameOver: false,
    victory: false,
    waveTickOffset: 0,
    individualLivesMode,
    pathLives: Array.from({ length: PATH_COUNT }, () => livesPerPath),
    pathOwners,
    bonusAwarded: WAVES.map(() => false),
    difficultyPercent,
    playerCountScalePercent,
    playerElements,
    playerStats,
    combatEvents: [],
    endlessMode,
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
  const playerStats: Record<PlayerId, PlayerStats> = {};
  for (const playerId of Object.keys(state.playerStats)) playerStats[playerId] = { ...state.playerStats[playerId] };
  return {
    ...state,
    gold: { ...state.gold },
    towers: state.towers.map((t) => ({ ...t })),
    monsters: state.monsters.map((m) => ({ ...m, pos: { ...m.pos } })),
    traps: state.traps.map((t) => ({ ...t })),
    resourceBuildings: state.resourceBuildings.map((r) => ({ ...r })),
    runeTotems: state.runeTotems.map((r) => ({ ...r })),
    pathLives: [...state.pathLives],
    pathOwners: state.pathOwners.map((owners) => [...owners]),
    bonusAwarded: [...state.bonusAwarded],
    playerStats,
  };
}

/** 塔/資源建築/符文圖騰都只能蓋在非路徑格,而且彼此不能疊在同一格上。 */
function isBuildableTileFree(state: SimulationState, x: number, y: number): boolean {
  if (state.towers.some((t) => t.x === x && t.y === y)) return false;
  if (state.resourceBuildings.some((r) => r.x === x && r.y === y)) return false;
  if (state.runeTotems.some((r) => r.x === x && r.y === y)) return false;
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
    upgradePath: 'none',
  });
}

/**
 * 雙屬性塔(元素組合玩法):蓋塔當下就要指定兩個不同的屬性,兩個都要在這個玩家自己允許蓋的
 * 屬性清單內(跟一般建塔同一條規則,不能繞過分工限制),而且兩個屬性不能相同(不然就只是
 * 包裝過的單屬性塔,浪費雙屬性溢價的造價)。造價/基礎數值用 dualTowerStats() 算,跟
 * describeTower()/tryAttack() 內部用的 baseTowerDef() 是同一套公式,避免兩邊算法各改各的漂掉。
 */
function applyBuildDualTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  const element = action.params.element;
  const secondElement = action.params.secondElement;
  if (x === null || y === null || !isElement(element) || !isElement(secondElement)) return;
  if (element === secondElement) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (!isBuildableTileFree(state, x, y)) return;
  const allowed = state.playerElements[playerId];
  if (allowed && (!allowed.includes(element) || !allowed.includes(secondElement))) return;
  const def = dualTowerStats(element as Element, secondElement as Element);
  const gold = state.gold[playerId] ?? 0;
  if (gold < def.cost) return;
  state.gold[playerId] = gold - def.cost;
  state.towers.push({
    id: state.nextTowerId++,
    element: element as Element,
    secondElement: secondElement as Element,
    x,
    y,
    level: 1,
    ticksSinceLastAttack: 0,
    ownerId: playerId,
    targetStrategy: 'first',
    upgradePath: 'none',
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

/**
 * 升級不分誰的塔,誰都能幫忙出錢升級,但花的是出手升級這個人自己的錢。
 * 升到 UPGRADE_PATH_LEVEL(分岐級)一定要在 action.params.path 指定 'burst' 或 'splash',
 * 沒指定或指定無效值就整個升級安全忽略(不會半途扣錢卻沒選到路線)。選過的路線之後不能改。
 */
function applyUpgradeTower(state: SimulationState, playerId: PlayerId, action: Action): void {
  const towerId = asFiniteInt(action.params.towerId);
  if (towerId === null) return;
  const tower = state.towers.find((t) => t.id === towerId);
  if (!tower) return;
  const cost = upgradeCost(tower);
  const gold = state.gold[playerId] ?? 0;
  if (cost === null || gold < cost) return;

  const nextLevel = tower.level + 1;
  let path: UpgradePath | null = null;
  if (nextLevel === UPGRADE_PATH_LEVEL) {
    const requestedPath = action.params.path;
    if (requestedPath !== 'burst' && requestedPath !== 'splash') return;
    path = requestedPath;
  }

  state.gold[playerId] = gold - cost;
  tower.level = nextLevel;
  if (path) tower.upgradePath = path;
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
  state.traps.push({ id: state.nextTrapId++, x, y, ownerId: playerId, level: 1 });
}

/** 陷阱升級不分誰蓋的,誰都能出錢升級(跟塔升級同一套慣例),只加強減速幅度,已封頂安全忽略。 */
function applyUpgradeTrap(state: SimulationState, playerId: PlayerId, action: Action): void {
  const trapId = asFiniteInt(action.params.trapId);
  if (trapId === null) return;
  const trap = state.traps.find((t) => t.id === trapId);
  if (!trap) return;
  const cost = trapUpgradeCost(trap);
  const gold = state.gold[playerId] ?? 0;
  if (cost === null || gold < cost) return;
  state.gold[playerId] = gold - cost;
  trap.level += 1;
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

/** 符文圖騰規則跟塔/資源建築一樣蓋在非路徑格,自己不攻擊,只提供範圍加成(見 towers.ts 的 nearbyTotemEffect)。 */
function applyBuildRuneTotem(state: SimulationState, playerId: PlayerId, action: Action): void {
  const x = asFiniteInt(action.params.x);
  const y = asFiniteInt(action.params.y);
  if (x === null || y === null) return;
  if (!inBounds(x, y) || isOnPath(x, y)) return;
  if (!isBuildableTileFree(state, x, y)) return;
  const gold = state.gold[playerId] ?? 0;
  if (gold < RUNE_TOTEM_COST) return;
  state.gold[playerId] = gold - RUNE_TOTEM_COST;
  state.runeTotems.push({ id: state.nextRuneTotemId++, x, y, ownerId: playerId, level: 1, upgradePath: 'none' });
}

/**
 * 符文圖騰升級不分誰蓋的,誰都能出錢升級(跟塔/陷阱升級同一套慣例)。升到
 * MAX_RUNE_TOTEM_LEVEL(2 級)那一次必須在 action.params.path 指定 'damage'/'haste' 之一,
 * 不是就整個升級安全忽略(不會扣錢卻沒定案路線,跟塔的 applyUpgradeTower 同一套邏輯)。
 */
function applyUpgradeRuneTotem(state: SimulationState, playerId: PlayerId, action: Action): void {
  const totemId = asFiniteInt(action.params.totemId);
  if (totemId === null) return;
  const totem = state.runeTotems.find((t) => t.id === totemId);
  if (!totem) return;
  if (totem.level >= MAX_RUNE_TOTEM_LEVEL) return;
  const gold = state.gold[playerId] ?? 0;
  if (gold < RUNE_TOTEM_UPGRADE_COST) return;

  const nextLevel = totem.level + 1;
  let path: 'damage' | 'haste' | null = null;
  if (nextLevel === MAX_RUNE_TOTEM_LEVEL) {
    const requestedPath = action.params.path;
    if (requestedPath !== 'damage' && requestedPath !== 'haste') return;
    path = requestedPath;
  }

  state.gold[playerId] = gold - RUNE_TOTEM_UPGRADE_COST;
  totem.level = nextLevel;
  if (path) totem.upgradePath = path;
}

/**
 * 「呼叫下一波」:把 waveTickOffset 往前調,讓 effectiveWaveTick() 直接跳到下一波開始的
 * 那一刻——不分誰按,任何隊友都能按(跟升級/集火策略同一套慣例)。固定模式已經是最後一波
 * 就沒有下一波可以跳,安全忽略;無限模式永遠有下一波。目前場上還沒清完的怪物不會被清掉,
 * 兩波會疊在一起同時出現,這是刻意的(提早叫下一波本來就該有風險,不是純粹加速沒有代價)。
 */
function applySkipToNextWave(state: SimulationState): void {
  const current = effectiveWaveTick(state);
  const currentWaveIndex = Math.floor(current / WAVE_INTERVAL_TICKS);
  if (!state.endlessMode && currentWaveIndex + 1 >= WAVES.length) return;
  const nextWaveStartTick = (currentWaveIndex + 1) * WAVE_INTERVAL_TICKS;
  state.waveTickOffset += nextWaveStartTick - current;
}

/**
 * 互助道具:金幣禮物——把自己的金幣直接轉一部分給隊友,純粹重新分配現有資源,不會憑空
 * 生錢也不會消失(從送禮者的 gold 扣多少,收禮者的 gold 就加多少)。不能送給自己、金額
 * 必須是正整數、送禮者的錢要夠,任何一項不成立就安全忽略。單人模式沒有其他玩家可以送,
 * 這個指令自然就一直是 no-op。
 */
function applyGiftGold(state: SimulationState, playerId: PlayerId, action: Action): void {
  const toPlayerId = action.params.toPlayerId;
  const amount = asFiniteInt(action.params.amount);
  if (typeof toPlayerId !== 'string' || amount === null || amount <= 0) return;
  if (toPlayerId === playerId) return;
  if (!(toPlayerId in state.gold)) return;
  const gold = state.gold[playerId] ?? 0;
  if (gold < amount) return;
  state.gold[playerId] = gold - amount;
  state.gold[toPlayerId] = (state.gold[toPlayerId] ?? 0) + amount;
}

/**
 * 互助道具:緊急補命。個人生命模式下 `action.params.pathId` 指定要補哪一條路徑(不合法/超出
 * 範圍就安全忽略);預設模式不需要 `pathId`,直接補團隊共用的 `lives`。兩種模式都只有生命
 * 「快歸零」(`<= EMERGENCY_HEAL_THRESHOLD`)時才能用,回滿也不會超過開局的滿血值。
 */
function applyEmergencyHeal(state: SimulationState, playerId: PlayerId, action: Action): void {
  const gold = state.gold[playerId] ?? 0;
  if (gold < EMERGENCY_HEAL_COST) return;

  if (state.individualLivesMode) {
    const pathId = asFiniteInt(action.params.pathId);
    if (pathId === null || pathId < 0 || pathId >= state.pathLives.length) return;
    if (state.pathLives[pathId] > EMERGENCY_HEAL_THRESHOLD) return;
    const startingPerPath = Math.max(1, Math.floor(STARTING_LIVES / state.pathLives.length));
    state.gold[playerId] = gold - EMERGENCY_HEAL_COST;
    state.pathLives[pathId] = Math.min(startingPerPath, state.pathLives[pathId] + EMERGENCY_HEAL_AMOUNT);
  } else {
    if (state.lives > EMERGENCY_HEAL_THRESHOLD) return;
    state.gold[playerId] = gold - EMERGENCY_HEAL_COST;
    state.lives = Math.min(STARTING_LIVES, state.lives + EMERGENCY_HEAL_AMOUNT);
  }
}

function applyCommand(state: SimulationState, playerId: PlayerId, action: Action): void {
  if (action.kind === 'build_tower') applyBuildTower(state, playerId, action);
  else if (action.kind === 'build_dual_tower') applyBuildDualTower(state, playerId, action);
  else if (action.kind === 'sell_tower') applySellTower(state, playerId, action);
  else if (action.kind === 'upgrade_tower') applyUpgradeTower(state, playerId, action);
  else if (action.kind === 'set_target_strategy') applySetTargetStrategy(state, action);
  else if (action.kind === 'build_trap') applyBuildTrap(state, playerId, action);
  else if (action.kind === 'upgrade_trap') applyUpgradeTrap(state, playerId, action);
  else if (action.kind === 'build_resource_building') applyBuildResourceBuilding(state, playerId, action);
  else if (action.kind === 'build_rune_totem') applyBuildRuneTotem(state, playerId, action);
  else if (action.kind === 'upgrade_rune_totem') applyUpgradeRuneTotem(state, playerId, action);
  else if (action.kind === 'skip_to_next_wave') applySkipToNextWave(state);
  else if (action.kind === 'gift_gold') applyGiftGold(state, playerId, action);
  else if (action.kind === 'emergency_heal') applyEmergencyHeal(state, playerId, action);
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
    .map((t) => `${t.id}:${t.x}:${t.y}:${t.element}:${t.secondElement ?? ''}:${t.level}:${t.targetStrategy}:${t.upgradePath}`)
    .join(';');
  const monsterPart = state.monsters
    .map((m) => `${m.id}:${m.hp}:${m.pos.pathId}:${m.pos.segmentIndex}:${m.pos.distanceIntoSegmentFp}`)
    .join(';');
  const trapPart = state.traps.map((t) => `${t.id}:${t.x}:${t.y}:${t.level}`).join(';');
  const resourceBuildingPart = state.resourceBuildings
    .map((r) => `${r.id}:${r.x}:${r.y}:${r.ticksSinceLastIncome}`)
    .join(';');
  const runeTotemPart = state.runeTotems.map((r) => `${r.id}:${r.x}:${r.y}:${r.level}:${r.upgradePath}`).join(';');
  const pathLivesPart = state.pathLives.join(',');
  const bonusPart = state.bonusAwarded.map((b) => (b ? '1' : '0')).join('');
  const statsPart = Object.keys(state.playerStats)
    .sort()
    .map((id) => `${id}:${state.playerStats[id].damageDealt}:${state.playerStats[id].kills}`)
    .join(',');
  return simpleHash(
    `${state.tick}|${state.waveTickOffset}|${goldPart}|${state.lives}|${pathLivesPart}|${towerPart}|${monsterPart}|${trapPart}|${resourceBuildingPart}|${runeTotemPart}|${bonusPart}|${statsPart}`,
  );
}

/**
 * 加碼波判定:限時內把整波怪物清光,發放額外金幣;不管有沒有趕上時限,都只判定一次。
 * 無限模式沒有這個機制(生怪內容是無限模式自己那套規則,跟這裡讀的固定 WAVES 定義對不上,
 * 硬套用會誤判/誤發獎勵),整個跳過不判定。
 */
function applyBonusWaveRewards(state: SimulationState, tick: number): void {
  if (state.endlessMode) return;
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

  const waveTick = effectiveWaveTick(next);
  const rawSpawnEvents = next.endlessMode ? getEndlessSpawnEventsForTick(waveTick) : getSpawnEventsForTick(waveTick);
  // 個人生命模式下,生命池子歸零的路徑直接停止生怪(不是暫停,是永久不會再出現),
  // 過濾掉指定給死路徑的 SpawnEvent 就好,不用另外處理「這隻怪生出來要不要立刻消失」。
  const spawnEvents = next.individualLivesMode
    ? rawSpawnEvents.filter((spawn) => next.pathLives[spawn.pathId] > 0)
    : rawSpawnEvents;
  for (const spawn of spawnEvents) {
    const scaled = scaledSpawn(spawn, next.difficultyPercent, next.playerCountScalePercent);
    next.monsters.push(createMonster(next.nextMonsterId++, scaled));
  }

  // 怪物移動,漏怪扣生命——站在陷阱格上的怪物這個 tick 的移動速度打折扣(飛行怪飛在空中,陷阱打不到),
  // 折扣幅度依陷阱等級查表(TRAP_SLOW_PERCENT_BY_LEVEL),陷阱格用 Map 存等級,不是只存在不在。
  const trapLevelByTile = new Map(next.traps.map((t) => [`${t.x},${t.y}`, t.level]));
  const survivors: Monster[] = [];
  for (const m of next.monsters) {
    const { xFp, yFp } = worldPositionFp(m.pos);
    const trapLevel = m.moveType === 'air' ? undefined : trapLevelByTile.get(`${Math.floor(xFp / FP_SCALE)},${Math.floor(yFp / FP_SCALE)}`);
    const slowPercent = trapLevel !== undefined ? (TRAP_SLOW_PERCENT_BY_LEVEL[trapLevel] ?? 0) : 0;
    const speedFp = slowPercent > 0 ? Math.floor((m.speedFp * (100 - slowPercent)) / 100) : m.speedFp;
    const { pos, leaked } = advanceAlongPath(m.pos, speedFp);
    if (leaked) {
      if (next.individualLivesMode) {
        next.pathLives[m.pos.pathId] = Math.max(0, next.pathLives[m.pos.pathId] - 1);
      } else {
        next.lives -= 1;
      }
      continue;
    }
    m.pos = pos;
    survivors.push(m);
  }
  next.monsters = survivors;

  // 記分板統計:傷害依塔的 ownerId 歸戶;擊殺數只算一次,同一隻怪這個 tick 被好幾座塔
  // 一起打死(常見於 splash 路線)只算給第一個把牠打進 0 血以下的塔主人,不會重複計算。
  const killedMonsterIdsThisTick = new Set<number>();
  for (const tower of next.towers) {
    const events = tryAttack(tower, next.monsters, next.towers, next.runeTotems);
    const stats = next.playerStats[tower.ownerId];
    for (const event of events) {
      next.combatEvents.push(event);
      if (!stats) continue;
      stats.damageDealt += event.damage;
      if (killedMonsterIdsThisTick.has(event.monsterId)) continue;
      const monster = next.monsters.find((m) => m.id === event.monsterId);
      if (monster && monster.hp <= 0) {
        stats.kills += 1;
        killedMonsterIdsThisTick.add(event.monsterId);
      }
    }
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

  applyBonusWaveRewards(next, waveTick);

  // 個人生命模式:全部路徑的生命池子都歸零才算團隊真的守不住;預設模式維持原本團隊共用一份。
  const teamWiped = next.individualLivesMode ? next.pathLives.every((l) => l <= 0) : next.lives <= 0;
  if (teamWiped) {
    next.gameOver = true;
  } else if (!next.endlessMode && waveTick >= totalWaveTicks() && next.monsters.length === 0) {
    // 無限模式沒有「破完」這回事,永遠不會走到這個分支,只有團隊守不住的 gameOver。
    next.victory = true;
  }

  next.checksum = computeChecksum(next);
  return next;
}
