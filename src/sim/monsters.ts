// 怪物與波次。波次全部是寫死的腳本(數量/血量/速度/賞金都是常數),
// 完全不需要亂數——省掉「RNG 演算法在不同瀏覽器要跑出一樣結果」這個額外風險。

import type { Element } from './elements';
import { createStartPos, PATH_COUNT, type PathPos } from './map';

/**
 * 移動類型(參考 Bloons TD 的 flying/camo 分類概念,簡化成互斥的三選一,不是獨立疊加的標記):
 * 'ground' 是預設,大多數怪物都是;'air' 飛在空中(陷阱打不到,只有部分屬性的塔打得到);
 * 'water' 是水路怪(只有非火屬性的塔打得到,呼應五行水克火;出場時路徑會有流水視覺效果)。
 * 這個分類獨立於 Element(五行傷害倍率用),兩者互不影響。
 */
export type MoveType = 'ground' | 'air' | 'water';

export interface Monster {
  id: number;
  element: Element;
  hp: number;
  maxHp: number;
  speedFp: number;
  bounty: number;
  pos: PathPos;
  /** 這隻怪屬於第幾波(0-based),加碼波判定「整波清光了沒」要用 */
  waveIndex: number;
  /** 首領波的怪(目前只有最後一波),UI 用來畫得比較大隻/加標示,純視覺,不影響戰鬥數值判定。 */
  isBoss: boolean;
  /** 移動類型,影響哪些塔打得到、陷阱有沒有效(見 src/sim/towers.ts 的 canTargetMoveType())。 */
  moveType: MoveType;
}

export interface WaveDef {
  element: Element;
  count: number;
  hp: number;
  speedFp: number;
  bounty: number;
  /** 加碼波(可選):在波次開始後這麼多 tick 內把整波清光,可以拿 bonusGold 額外獎勵。 */
  bonusClearWithinTicks?: number;
  bonusGold?: number;
  /** 首領波(可選):目前只用在最後一波,單隻厚血高賞金的怪當收尾挑戰。 */
  isBoss?: boolean;
  /** 移動類型(可選,不填就是 'ground')。 */
  moveType?: MoveType;
}

export const WAVE_INTERVAL_TICKS = 400; // 20 tick/秒 * 20 秒
export const SPAWN_INTERVAL_TICKS = 20; // 同波怪物間隔 1 秒

// 數值都是先求「能玩」的佔位平衡,真正調數值是 Phase 5 的事。
export const WAVES: readonly WaveDef[] = [
  // 水路怪:出場時路徑會浮現流水視覺效果(GameScene.ts),只有非火屬性的塔打得到(水克火)。
  { element: 'water', count: 6, hp: 40, speedFp: 60, bounty: 10, moveType: 'water' },
  { element: 'fire', count: 6, hp: 55, speedFp: 65, bounty: 12 },
  { element: 'wood', count: 8, hp: 70, speedFp: 60, bounty: 14 },
  // 加碼波:血少速度快,限時內清光才拿得到額外金幣,清不完也不會有懲罰。
  {
    element: 'earth',
    count: 5,
    hp: 30,
    speedFp: 90,
    bounty: 8,
    bonusClearWithinTicks: 200,
    bonusGold: 100,
  },
  { element: 'earth', count: 8, hp: 90, speedFp: 55, bounty: 16 },
  // 飛行怪:陷阱打不到,只有土屬性以外的塔打得到(土是純地面系,搆不到天上)。
  { element: 'metal', count: 10, hp: 110, speedFp: 60, bounty: 18, moveType: 'air' },
  { element: 'fire', count: 12, hp: 130, speedFp: 70, bounty: 22 },
  // 最終首領波:單隻厚血慢速的收尾挑戰,賞金給得比較多當作全破獎勵的一部分。
  { element: 'earth', count: 1, hp: 1200, speedFp: 45, bounty: 150, isBoss: true },
];

export function totalWaveTicks(): number {
  return WAVES.length * WAVE_INTERVAL_TICKS;
}

/** 目前是第幾波(1-based),超過最後一波就固定停在最後一波編號。 */
export function currentWaveNumber(tick: number): number {
  return Math.min(Math.floor(tick / WAVE_INTERVAL_TICKS), WAVES.length - 1) + 1;
}

/** 距離下一波開始還有幾個 tick;已經是最後一波的話回傳 null(沒有下一波了)。 */
export function ticksUntilNextWave(tick: number): number | null {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  if (nextWaveIndex >= WAVES.length) return null;
  return nextWaveIndex * WAVE_INTERVAL_TICKS - tick;
}

/** 下一波的波次定義(讓 UI 能提前顯示屬性);沒有下一波就回傳 null。 */
export function upcomingWaveDef(tick: number): WaveDef | null {
  const nextWaveIndex = Math.floor(tick / WAVE_INTERVAL_TICKS) + 1;
  if (nextWaveIndex >= WAVES.length) return null;
  return WAVES[nextWaveIndex];
}

/** 目前這波如果是加碼波,回傳距離時限還剩幾個 tick + 獎勵金額;不是加碼波或已經過時限就回傳 null。 */
export function activeBonusWaveInfo(tick: number): { ticksLeft: number; bonusGold: number } | null {
  const waveIndex = Math.min(Math.floor(tick / WAVE_INTERVAL_TICKS), WAVES.length - 1);
  const wave = WAVES[waveIndex];
  if (wave.bonusClearWithinTicks === undefined || wave.bonusGold === undefined) return null;
  const deadline = waveIndex * WAVE_INTERVAL_TICKS + wave.bonusClearWithinTicks;
  if (tick > deadline) return null;
  return { ticksLeft: deadline - tick, bonusGold: wave.bonusGold };
}

export interface SpawnEvent {
  element: Element;
  hp: number;
  speedFp: number;
  bounty: number;
  pathId: number;
  waveIndex: number;
  isBoss: boolean;
  moveType: MoveType;
}

/** 純函式:給定 tick,回傳這一 tick 該生出的怪物。同一個 tick 在哪台機器算都是同一個答案。 */
export function getSpawnEventsForTick(tick: number): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  for (let i = 0; i < WAVES.length; i++) {
    const wave = WAVES[i];
    const waveStartTick = i * WAVE_INTERVAL_TICKS;
    for (let j = 0; j < wave.count; j++) {
      const spawnTick = waveStartTick + j * SPAWN_INTERVAL_TICKS;
      if (spawnTick === tick) {
        events.push({
          element: wave.element,
          hp: wave.hp,
          speedFp: wave.speedFp,
          bounty: wave.bounty,
          // 同一波怪物輪流分配路徑,逼玩家同時顧好兩條路,而不是把火力全堆在一條線上。
          pathId: j % PATH_COUNT,
          waveIndex: i,
          isBoss: wave.isBoss ?? false,
          moveType: wave.moveType ?? 'ground',
        });
      }
    }
  }
  return events;
}

export function createMonster(id: number, spawn: SpawnEvent): Monster {
  return {
    id,
    element: spawn.element,
    hp: spawn.hp,
    maxHp: spawn.hp,
    speedFp: spawn.speedFp,
    bounty: spawn.bounty,
    pos: createStartPos(spawn.pathId),
    waveIndex: spawn.waveIndex,
    isBoss: spawn.isBoss,
    moveType: spawn.moveType,
  };
}
